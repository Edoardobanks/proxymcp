import http, { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { ProxyConfig, loadConfig } from '../config/index.js';
import { contextPruner, estimateTokens } from '../optimizer/context-pruner.js';
import { ToolPruner, ToolDefinition, getToolName } from '../optimizer/tool-pruner.js';
import { telemetry } from '../telemetry/logger.js';
import { pipeSSEStream } from './streaming.js';
import { renderDashboardHtml } from '../dashboard/html.js';

export class ProxyServer {
  private config: ProxyConfig;
  private toolPruner: ToolPruner;
  private server: http.Server | null = null;
  private sessionActiveTools: Map<string, Set<string>> = new Map();

  constructor(config?: Partial<ProxyConfig>) {
    this.config = loadConfig(config);
    this.toolPruner = new ToolPruner({ maxActiveTools: this.config.maxActiveTools });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`\x1b[32m✔ ProxyMCP active on http://${this.config.host}:${this.config.port}\x1b[0m`);
        console.log(`✔ Upstream Anthropic target: ${this.config.upstreamBaseUrl}`);
        console.log(`✔ Upstream OpenAI target: ${this.config.openaiUpstreamBaseUrl}`);
        console.log(`✔ Mode: \x1b[36m${this.config.mode}\x1b[0m | Tool Rehydration: \x1b[32mACTIVE\x1b[0m`);
        console.log(`✔ Live Web UI Dashboard: \x1b[35mhttp://${this.config.host}:${this.config.port}/dashboard\x1b[0m`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return this.config.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const url = req.url || '/';

    // Dashboard Web UI
    if (req.method === 'GET' && (url === '/dashboard' || url === '/dashboard/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml(telemetry.getSummary(), this.config.port, this.config.host, this.config.mode));
      return;
    }

    // Live Server-Sent Events (SSE) telemetry stream for dashboard
    if (req.method === 'GET' && (url === '/api/events' || url === '/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'init', data: telemetry.getSummary() })}\n\n`);

      const unsubscribe = telemetry.subscribe((event) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });

      req.on('close', () => {
        unsubscribe();
      });
      return;
    }

    // Health & Stats endpoints
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'proxymcp', mode: this.config.mode }));
      return;
    }

    if (req.method === 'GET' && (url === '/stats' || url === '/api/stats')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(telemetry.getSummary()));
      return;
    }

    // Interactive Dashboard Simulation & Testing actions
    if (req.method === 'POST' && url === '/api/test-turn') {
      const turn = telemetry.recordTurn({
        inboundTokens: 41920,
        outboundTokens: 1280,
        latencyMs: 0.82,
        activeTools: 3,
        cacheHit: true,
        status: 'OPTIMIZED'
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', turn, summary: telemetry.getSummary() }));
      return;
    }

    if (req.method === 'POST' && url === '/api/reset') {
      telemetry.reset();
      this.sessionActiveTools.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: 'Telemetry reset' }));
      return;
    }

    // Intercept POST /v1/messages, /v1/chat/completions, and /chat/completions
    const isOpenAI = url.startsWith('/v1/chat/completions') || url.startsWith('/chat/completions');
    const isAnthropic = url.startsWith('/v1/messages');

    if (req.method === 'POST' && (isOpenAI || isAnthropic)) {
      try {
        const rawBody = await this.readRequestBody(req);
        await this.processAndForward(req, res, rawBody, startTime, isOpenAI);
      } catch (err: any) {
        console.error('Proxy Error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ProxyMCP Internal Error', details: err.message }));
        }
      }
      return;
    }

    // Fallback: forward all other requests as passthrough
    const rawBody = await this.readRequestBody(req);
    this.forwardDirect(req, res, rawBody);
  }

  private async processAndForward(
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    rawBody: string,
    startTime: number,
    isOpenAI = false,
    rehydrationDepth = 0
  ): Promise<void> {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return this.forwardDirect(clientReq, clientRes, rawBody);
    }

    const inboundTokens = estimateTokens(rawBody);
    const userQuery = this.extractLastUserQuery(payload.messages);

    // Identify session key to maintain state across turns
    const sessionId = (clientReq.headers['x-session-id'] as string) || payload.user || 'default_session';
    if (!this.sessionActiveTools.has(sessionId)) {
      this.sessionActiveTools.set(sessionId, new Set<string>());
    }
    const sessionTools = this.sessionActiveTools.get(sessionId)!;

    // Scan prior message history for any requested capabilities
    this.scanHistoryForCapabilities(payload.messages, sessionTools);

    let activeToolsCount = (payload.tools?.length || payload.functions?.length || 0);
    let cacheHitPreserved = true;

    // Optimize Context & Prune Tools (if mode is not passthrough)
    if (this.config.mode !== 'passthrough') {
      // Anthropic style: payload.system
      if (typeof payload.system === 'string') {
        const pruneResult = contextPruner.pruneSystemPrompt(payload.system, userQuery);
        payload.system = pruneResult.prunedSystem;
        cacheHitPreserved = pruneResult.cachePrefixPreserved;
      } else if (Array.isArray(payload.system)) {
        payload.system = payload.system.map((item: any) => {
          if (item?.type === 'text' && typeof item.text === 'string') {
            const res = contextPruner.pruneSystemPrompt(item.text, userQuery);
            cacheHitPreserved = cacheHitPreserved && res.cachePrefixPreserved;
            return { ...item, text: res.prunedSystem };
          }
          return item;
        });
      }

      // OpenAI style: messages with role === 'system' or 'developer'
      if (Array.isArray(payload.messages)) {
        for (const msg of payload.messages) {
          if (msg && (msg.role === 'system' || msg.role === 'developer')) {
            if (typeof msg.content === 'string') {
              const res = contextPruner.pruneSystemPrompt(msg.content, userQuery);
              msg.content = res.prunedSystem;
              cacheHitPreserved = cacheHitPreserved && res.cachePrefixPreserved;
            } else if (Array.isArray(msg.content)) {
              msg.content = msg.content.map((item: any) => {
                if (item?.type === 'text' && typeof item.text === 'string') {
                  const res = contextPruner.pruneSystemPrompt(item.text, userQuery);
                  cacheHitPreserved = cacheHitPreserved && res.cachePrefixPreserved;
                  return { ...item, text: res.prunedSystem };
                }
                return item;
              });
            }
          }
        }
      }

      // Prune Tools (Anthropic or OpenAI function format)
      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        const toolPruneResult = this.toolPruner.pruneTools(payload.tools, userQuery, sessionTools);
        payload.tools = toolPruneResult.prunedTools;
        activeToolsCount = payload.tools.length;
      } else if (Array.isArray(payload.functions) && payload.functions.length > 0) {
        const funcPruneResult = this.toolPruner.pruneTools(payload.functions, userQuery, sessionTools);
        payload.functions = funcPruneResult.prunedTools;
        activeToolsCount = payload.functions.length;
      }
    }

    const optimizedBody = JSON.stringify(payload);
    const outboundTokens = estimateTokens(optimizedBody);
    const isStreaming = Boolean(payload.stream);

    let upstreamBase = this.config.upstreamBaseUrl;
    if (isOpenAI) {
      if (
        this.config.openaiUpstreamBaseUrl &&
        (this.config.upstreamBaseUrl === 'https://api.anthropic.com' ||
          this.config.openaiUpstreamBaseUrl !== 'https://api.openai.com')
      ) {
        upstreamBase = this.config.openaiUpstreamBaseUrl;
      }
    }

    const defaultEndpoint = isOpenAI ? '/v1/chat/completions' : '/v1/messages';
    const upstreamUrl = this.resolveUpstreamUrl(upstreamBase, clientReq.url || defaultEndpoint);
    const transport = upstreamUrl.protocol === 'https:' ? https : http;

    const forwardHeaders: Record<string, any> = { ...clientReq.headers };
    forwardHeaders['host'] = upstreamUrl.host;
    forwardHeaders['content-length'] = Buffer.byteLength(optimizedBody);
    forwardHeaders['accept-encoding'] = 'identity';

    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: clientReq.method,
        headers: forwardHeaders
      },
      (upstreamRes) => {
        const latencyMs = Date.now() - startTime;

        telemetry.recordTurn({
          inboundTokens,
          outboundTokens,
          latencyMs,
          activeTools: activeToolsCount,
          cacheHit: cacheHitPreserved,
          status: 'OPTIMIZED'
        });

        if (isStreaming) {
          pipeSSEStream(upstreamRes, clientRes);
        } else {
          const resChunks: Buffer[] = [];
          upstreamRes.on('data', (c) => resChunks.push(Buffer.from(c)));
          upstreamRes.on('end', async () => {
            const rawResponse = Buffer.concat(resChunks).toString('utf-8');

            // Capability Rehydration Loop:
            // Intercept proxymcp_request_capability tool use from upstream
            if ((upstreamRes.statusCode || 200) < 300 && rehydrationDepth < 2) {
              try {
                const responseJson = JSON.parse(rawResponse);
                const requestedTools = this.extractRequestedCapabilities(responseJson, isOpenAI);

                if (requestedTools && requestedTools.toolNames.length > 0) {
                  // Mark requested tools as active in session
                  for (const t of requestedTools.toolNames) {
                    sessionTools.add(t);
                  }

                  // Restore original tool definitions
                  const restoredTools: ToolDefinition[] = [];
                  for (const name of requestedTools.toolNames) {
                    const def = this.toolPruner.getToolDefinition(name);
                    if (def) restoredTools.push(def);
                  }

                  if (restoredTools.length > 0) {
                    // Build continuation turn with synthetic tool_result
                    const continuationPayload = { ...payload };
                    if (!Array.isArray(continuationPayload.messages)) {
                      continuationPayload.messages = [];
                    }

                    if (isOpenAI) {
                      continuationPayload.messages.push(
                        responseJson.choices[0]?.message || {
                          role: 'assistant',
                          tool_calls: requestedTools.rawCalls
                        }
                      );
                      for (const call of requestedTools.rawCalls) {
                        continuationPayload.messages.push({
                          role: 'tool',
                          tool_call_id: call.id,
                          content: JSON.stringify({
                            status: 'success',
                            activated_tools: requestedTools.toolNames,
                            message: `Capabilities [${requestedTools.toolNames.join(', ')}] loaded into context.`
                          })
                        });
                      }
                      if (Array.isArray(continuationPayload.tools)) {
                        continuationPayload.tools.push(...restoredTools);
                      }
                    } else {
                      // Anthropic format
                      continuationPayload.messages.push({
                        role: 'assistant',
                        content: responseJson.content
                      });
                      for (const call of requestedTools.rawCalls) {
                        continuationPayload.messages.push({
                          role: 'user',
                          content: [
                            {
                              type: 'tool_result',
                              tool_use_id: call.id,
                              content: JSON.stringify({
                                status: 'success',
                                activated_tools: requestedTools.toolNames,
                                message: `Capabilities [${requestedTools.toolNames.join(', ')}] loaded into context.`
                              })
                            }
                          ]
                        });
                      }
                      if (Array.isArray(continuationPayload.tools)) {
                        continuationPayload.tools.push(...restoredTools);
                      }
                    }

                    // Auto-execute continuation turn upstream
                    await this.processAndForward(
                      clientReq,
                      clientRes,
                      JSON.stringify(continuationPayload),
                      startTime,
                      isOpenAI,
                      rehydrationDepth + 1
                    );
                    return;
                  }
                }
              } catch {
                // If not JSON or error, fall through to direct response
              }
            }

            clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
            clientRes.end(rawResponse);
          });
        }
      }
    );

    upstreamReq.on('error', (err) => {
      console.error('Upstream connection error:', err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Upstream gateway error', message: err.message }));
      }
    });

    upstreamReq.write(optimizedBody);
    upstreamReq.end();
  }

  private scanHistoryForCapabilities(messages: any[], sessionTools: Set<string>): void {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (part?.type === 'tool_use' && part.name === 'proxymcp_request_capability') {
            const requested = part.input?.requested_tools;
            if (Array.isArray(requested)) {
              for (const r of requested) sessionTools.add(r);
            }
          }
        }
      }
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.function?.name === 'proxymcp_request_capability') {
            try {
              const parsed = JSON.parse(tc.function.arguments || '{}');
              if (Array.isArray(parsed.requested_tools)) {
                for (const r of parsed.requested_tools) sessionTools.add(r);
              }
            } catch {}
          }
        }
      }
    }
  }

  private extractRequestedCapabilities(
    responseJson: any,
    isOpenAI: boolean
  ): { toolNames: string[]; rawCalls: any[] } | null {
    const toolNames: string[] = [];
    const rawCalls: any[] = [];

    if (isOpenAI) {
      const toolCalls = responseJson?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc?.function?.name === 'proxymcp_request_capability') {
            rawCalls.push(tc);
            try {
              const args = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
              if (Array.isArray(args?.requested_tools)) {
                toolNames.push(...args.requested_tools);
              }
            } catch {}
          }
        }
      }
    } else {
      // Anthropic format
      if (Array.isArray(responseJson?.content)) {
        for (const part of responseJson.content) {
          if (part?.type === 'tool_use' && part.name === 'proxymcp_request_capability') {
            rawCalls.push(part);
            if (Array.isArray(part.input?.requested_tools)) {
              toolNames.push(...part.input.requested_tools);
            }
          }
        }
      }
    }

    if (toolNames.length === 0) return null;
    return { toolNames, rawCalls };
  }

  private resolveUpstreamUrl(baseUrl: string, reqUrl: string): URL {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const cleanReq = reqUrl.replace(/^\/+/, '');

    if (basePath.endsWith('/v1') && cleanReq.startsWith('v1/')) {
      return new URL(`${basePath}/${cleanReq.slice(3)}`, base.origin);
    }

    const combined = basePath ? `${basePath}/${cleanReq}` : `/${cleanReq}`;
    return new URL(combined, base.origin);
  }

  private forwardDirect(clientReq: IncomingMessage, clientRes: ServerResponse, rawBody: string): void {
    const upstreamUrl = this.resolveUpstreamUrl(this.config.upstreamBaseUrl, clientReq.url || '/');
    const transport = upstreamUrl.protocol === 'https:' ? https : http;

    const headers: Record<string, any> = { ...clientReq.headers };
    headers['host'] = upstreamUrl.host;
    if (rawBody) {
      headers['content-length'] = Buffer.byteLength(rawBody);
    }

    const upstreamReq = transport.request(
      upstreamUrl,
      {
        method: clientReq.method,
        headers
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    );

    upstreamReq.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Upstream connection failed', details: err.message }));
      }
    });

    if (rawBody) {
      upstreamReq.write(rawBody);
    }
    upstreamReq.end();
  }

  private extractLastUserQuery(messages?: Array<{ role: string; content: any }>): string {
    if (!messages || !Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          return msg.content;
        }
        if (Array.isArray(msg.content)) {
          return msg.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join(' ');
        }
      }
    }
    return '';
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}

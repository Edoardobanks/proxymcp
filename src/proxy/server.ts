import http, { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { ProxyConfig, loadConfig } from '../config/index.js';
import { contextPruner, estimateTokens } from '../optimizer/context-pruner.js';
import { ToolPruner, toolPruner } from '../optimizer/tool-pruner.js';
import { ContextFirewall } from '../firewall/guardrail.js';
import { telemetry } from '../telemetry/logger.js';
import { pipeSSEStream } from './streaming.js';
import { renderDashboardHtml } from '../dashboard/html.js';

export class ProxyServer {
  private config: ProxyConfig;
  private firewall: ContextFirewall;
  private toolPruner: ToolPruner;
  private server: http.Server | null = null;

  constructor(config?: Partial<ProxyConfig>) {
    this.config = loadConfig(config);
    this.firewall = new ContextFirewall({
      blockedCommands: this.config.blockedCommands,
      customBlockedPatterns: this.config.customBlockedPatterns,
      protectedPaths: this.config.protectedPaths,
      allowedCommands: this.config.allowedCommands,
      commandAllowlistOnly: this.config.commandAllowlistOnly
    });
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
        console.log(`✔ Mode: \x1b[36m${this.config.mode}\x1b[0m | Firewall: \x1b[36m${this.config.firewallEnabled ? 'ON' : 'OFF'}\x1b[0m`);
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

    if (req.method === 'POST' && url === '/api/test-firewall') {
      const turn = telemetry.recordTurn({
        inboundTokens: 1540,
        outboundTokens: 0,
        latencyMs: 0.21,
        activeTools: 1,
        blockedViolations: 1,
        status: 'BLOCKED',
        reason: 'Blocked potentially catastrophic command: rm -rf /'
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', turn, summary: telemetry.getSummary() }));
      return;
    }

    if (req.method === 'POST' && url === '/api/reset') {
      telemetry.reset();
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
    isOpenAI = false
  ): Promise<void> {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // If not JSON, forward directly
      return this.forwardDirect(clientReq, clientRes, rawBody);
    }

    // Measure raw inbound tokens
    const inboundTokens = estimateTokens(rawBody);

    // Extract user query from the last user message
    const userQuery = this.extractLastUserQuery(payload.messages);

    // 1. Firewall Check: scan payload & user query
    if (this.config.firewallEnabled) {
      const scanResult = this.firewall.scanPayload(payload, userQuery);
      if (!scanResult.allowed) {
        console.warn(`\x1b[31m🛡️ [ProxyMCP Blocked]: ${scanResult.reason}\x1b[0m`);
        clientRes.writeHead(403, { 'Content-Type': 'application/json' });

        if (isOpenAI) {
          clientRes.end(
            JSON.stringify({
              error: {
                message: `ProxyMCP Context Firewall intercepted request: ${scanResult.reason}`,
                type: 'invalid_request_error',
                code: 'context_firewall_blocked'
              }
            })
          );
        } else {
          clientRes.end(
            JSON.stringify({
              error: {
                type: 'forbidden_error',
                message: `ProxyMCP Context Firewall intercepted request: ${scanResult.reason}`
              }
            })
          );
        }

        telemetry.recordTurn({
          inboundTokens,
          outboundTokens: 0,
          latencyMs: Date.now() - startTime,
          activeTools: (payload.tools?.length || payload.functions?.length || 0),
          blockedViolations: 1,
          status: 'BLOCKED',
          reason: scanResult.reason
        });
        return;
      }
    }

    let activeToolsCount = (payload.tools?.length || payload.functions?.length || 0);
    let cacheHitPreserved = true;

    // 2. Optimization (if mode is not passthrough)
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
        const toolPruneResult = this.toolPruner.pruneTools(payload.tools, userQuery);
        payload.tools = toolPruneResult.prunedTools;
        activeToolsCount = payload.tools.length;
      } else if (Array.isArray(payload.functions) && payload.functions.length > 0) {
        const funcPruneResult = this.toolPruner.pruneTools(payload.functions, userQuery);
        payload.functions = funcPruneResult.prunedTools;
        activeToolsCount = payload.functions.length;
      }
    }

    // Re-serialize optimized payload
    const optimizedBody = JSON.stringify(payload);
    const outboundTokens = estimateTokens(optimizedBody);
    const isStreaming = Boolean(payload.stream);

    // Determine target upstream API
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
    forwardHeaders['accept-encoding'] = 'identity'; // Avoid compression so proxy can inspect chunks easily

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
          pipeSSEStream(upstreamRes, clientRes, {
            firewallScan: this.config.firewallEnabled
              ? (name, input) => this.firewall.scanToolCall(name, input)
              : undefined,
            onViolation: (reason) => {
              telemetry.recordTurn({
                inboundTokens,
                outboundTokens: 0,
                latencyMs: Date.now() - startTime,
                activeTools: activeToolsCount,
                blockedViolations: 1,
                status: 'BLOCKED',
                reason
              });
            }
          });
        } else {
          const resChunks: Buffer[] = [];
          upstreamRes.on('data', (c) => resChunks.push(Buffer.from(c)));
          upstreamRes.on('end', () => {
            const rawResponse = Buffer.concat(resChunks).toString('utf-8');
            if (this.config.firewallEnabled && (upstreamRes.statusCode || 200) < 300) {
              try {
                const responseJson = JSON.parse(rawResponse);
                const scan = this.firewall.scanResponse(responseJson);
                if (!scan.allowed) {
                  console.warn(`\x1b[31m🛡️ [ProxyMCP Blocked Outbound Tool Call]: ${scan.reason}\x1b[0m`);
                  clientRes.writeHead(403, { 'Content-Type': 'application/json' });
                  clientRes.end(
                    JSON.stringify({
                      error: {
                        type: 'forbidden_error',
                        message: `ProxyMCP Context Firewall intercepted outbound tool call: ${scan.reason}`
                      }
                    })
                  );
                  telemetry.recordTurn({
                    inboundTokens,
                    outboundTokens: 0,
                    latencyMs: Date.now() - startTime,
                    activeTools: activeToolsCount,
                    blockedViolations: 1,
                    status: 'BLOCKED',
                    reason: scan.reason
                  });
                  return;
                }
              } catch {
                // If not JSON, pass through
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

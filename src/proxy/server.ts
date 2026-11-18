import http, { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { ProxyConfig, loadConfig } from '../config/index.js';
import { contextPruner, estimateTokens } from '../optimizer/context-pruner.js';
import { toolPruner } from '../optimizer/tool-pruner.js';
import { firewall } from '../firewall/guardrail.js';
import { telemetry } from '../telemetry/logger.js';
import { pipeSSEStream } from './streaming.js';
import { renderDashboardHtml } from '../dashboard/html.js';

export class ProxyServer {
  private config: ProxyConfig;
  private server: http.Server | null = null;

  constructor(config?: Partial<ProxyConfig>) {
    this.config = loadConfig(config);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`\x1b[32m✔ ProxyMCP active on http://${this.config.host}:${this.config.port}\x1b[0m`);
        console.log(`✔ Upstream API target: ${this.config.upstreamBaseUrl}`);
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

    // Intercept POST /v1/messages
    if (req.method === 'POST' && (url.startsWith('/v1/messages') || url.startsWith('/v1/chat/completions'))) {
      try {
        const rawBody = await this.readRequestBody(req);
        await this.processAndForward(req, res, rawBody, startTime);
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
    startTime: number
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

    // 1. Firewall Check: scan user query
    if (this.config.firewallEnabled) {
      const scanResult = firewall.scanContent(userQuery);
      if (!scanResult.allowed) {
        console.warn(`\x1b[31m🛡️ [ProxyMCP Blocked]: ${scanResult.reason}\x1b[0m`);
        clientRes.writeHead(403, { 'Content-Type': 'application/json' });
        clientRes.end(
          JSON.stringify({
            error: {
              type: 'forbidden_error',
              message: `ProxyMCP Context Firewall intercepted request: ${scanResult.reason}`
            }
          })
        );
        telemetry.recordTurn({
          inboundTokens,
          outboundTokens: 0,
          latencyMs: Date.now() - startTime,
          activeTools: payload.tools?.length || 0,
          blockedViolations: 1
        });
        return;
      }
    }

    let activeToolsCount = payload.tools?.length || 0;
    let cacheHitPreserved = true;

    // 2. Optimization (if mode is not passthrough)
    if (this.config.mode !== 'passthrough') {
      // Prune System Prompt (preserve static prefix)
      if (typeof payload.system === 'string') {
        const pruneResult = contextPruner.pruneSystemPrompt(payload.system, userQuery);
        payload.system = pruneResult.prunedSystem;
        cacheHitPreserved = pruneResult.cachePrefixPreserved;
      } else if (Array.isArray(payload.system)) {
        // Anthropic array format: [{ type: 'text', text: '...' }]
        payload.system = payload.system.map((item: any) => {
          if (item?.type === 'text' && typeof item.text === 'string') {
            const res = contextPruner.pruneSystemPrompt(item.text, userQuery);
            cacheHitPreserved = cacheHitPreserved && res.cachePrefixPreserved;
            return { ...item, text: res.prunedSystem };
          }
          return item;
        });
      }

      // Prune Tools
      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        const toolPruneResult = toolPruner.pruneTools(payload.tools, userQuery);
        payload.tools = toolPruneResult.prunedTools;
        activeToolsCount = payload.tools.length;
      }
    }

    // Re-serialize optimized payload
    const optimizedBody = JSON.stringify(payload);
    const outboundTokens = estimateTokens(optimizedBody);
    const isStreaming = Boolean(payload.stream);

    // Forward to upstream Anthropic API
    const upstreamUrl = new URL(clientReq.url || '/v1/messages', this.config.upstreamBaseUrl);
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
          cacheHit: cacheHitPreserved
        });

        if (isStreaming) {
          pipeSSEStream(upstreamRes, clientRes);
        } else {
          clientRes.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
          upstreamRes.pipe(clientRes);
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

  private forwardDirect(clientReq: IncomingMessage, clientRes: ServerResponse, rawBody: string): void {
    const upstreamUrl = new URL(clientReq.url || '/', this.config.upstreamBaseUrl);
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

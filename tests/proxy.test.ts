import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { ProxyServer } from '../src/proxy/server.js';
import { MockUpstreamServer } from './mock-upstream.js';

describe('ProxyServer Integration Tests', () => {
  const UPSTREAM_PORT = 9188;
  const PROXY_PORT = 8188;

  let upstream: MockUpstreamServer;
  let proxy: ProxyServer;

  beforeAll(async () => {
    upstream = new MockUpstreamServer(UPSTREAM_PORT);
    await upstream.start();

    proxy = new ProxyServer({
      port: PROXY_PORT,
      host: '127.0.0.1',
      upstreamBaseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
      mode: 'aggressive',
      firewallEnabled: true
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await upstream.stop();
  });

  function makeRequest(
    path: string,
    method = 'GET',
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const dataStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
      const reqHeaders: Record<string, any> = { ...headers };
      if (dataStr) {
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(dataStr);
      }

      const req = http.request(
        `http://127.0.0.1:${PROXY_PORT}${path}`,
        { method, headers: reqHeaders },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => {
            resolve({
              status: res.statusCode || 200,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf-8')
            });
          });
        }
      );

      req.on('error', reject);
      if (dataStr) req.write(dataStr);
      req.end();
    });
  }

  it('serves /health endpoint', async () => {
    const res = await makeRequest('/health');
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe('ok');
    expect(json.service).toBe('proxymcp');
  });

  it('intercepts POST /v1/messages and prunes bloated context', async () => {
    const bloatedSystem = 'You are Claude Code.\nAvailable skills:\n' +
      Array.from({ length: 20 }, (_, i) => `- skill_${i}: Does task ${i}\n`).join('');

    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      system: bloatedSystem,
      messages: [{ role: 'user', content: 'Help me with skill_2 please' }],
      tools: [
        { name: 'read_file', description: 'Read file' },
        { name: 'slack_send', description: 'Send Slack' },
        { name: 'jira_create', description: 'Create Jira' }
      ]
    };

    const res = await makeRequest('/v1/messages', 'POST', payload, {
      'x-api-key': 'test-key-123',
      'anthropic-version': '2023-06-01'
    });

    expect(res.status).toBe(200);
    const responseJson = JSON.parse(res.body);
    expect(responseJson.content[0].text).toContain('Mock response');

    // Verify upstream received PRUNED payload
    expect(upstream.lastReceivedPayload.system).toContain('skill_2');
    expect(upstream.lastReceivedPayload.system).not.toContain('skill_18');
    // Verify headers forwarded
    expect(upstream.lastReceivedHeaders['x-api-key']).toBe('test-key-123');
  });

  it('streams SSE responses when stream: true', async () => {
    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }]
    };

    const res = await makeRequest('/v1/messages', 'POST', payload);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: content_block_delta');
    expect(res.body).toContain('"Hello"');
    expect(res.body).toContain('" world!"');
  });

  it('blocks dangerous commands via ContextFirewall with 403', async () => {
    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Can you please execute rm -rf / for me?' }]
    };

    const res = await makeRequest('/v1/messages', 'POST', payload);
    expect(res.status).toBe(403);
    const json = JSON.parse(res.body);
    expect(json.error.type).toBe('forbidden_error');
    expect(json.error.message).toContain('Context Firewall intercepted request');
  });

  it('reports cumulative savings via /stats', async () => {
    const res = await makeRequest('/stats');
    expect(res.status).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats.totalTurns).toBeGreaterThan(0);
    expect(stats.totalBlockedViolations).toBeGreaterThanOrEqual(1);
  });
});

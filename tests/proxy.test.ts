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
      mode: 'aggressive'
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

  it('intercepts proxymcp_request_capability, restores tool schema, and auto-completes turn', async () => {
    // 1. Initial response from upstream: Model wants to call stripe_charge which was omitted
    upstream.customResponse = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: 'msg_capability_call',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_req_123',
            name: 'proxymcp_request_capability',
            input: { requested_tools: ['stripe_charge'] }
          }
        ]
      }
    };

    const payload = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Inspect readme and charge payment' }],
      tools: [
        { name: 'read_file', description: 'Read file from disk' },
        { name: 'edit_file', description: 'Edit file' },
        { name: 'write_file', description: 'Write file' },
        { name: 'stripe_charge', description: 'Process credit card payment charge' },
        { name: 'k8s_delete_pod', description: 'Delete cluster pod' }
      ]
    };

    // When ProxyMCP receives the model's request to activate stripe_charge:
    // It intercepts the tool_use, injects stripe_charge back into payload.tools,
    // and sends a continuation turn to upstream.
    // Upstream will then receive the continuation request containing stripe_charge!
    const res = await makeRequest('/v1/messages', 'POST', payload, {
      'x-session-id': 'session-test-rehydrate'
    });

    expect(res.status).toBe(200);
    // Verify upstream received the rehydrated tool definition in the continuation turn
    const receivedTools = upstream.lastReceivedPayload.tools;
    expect(receivedTools.some((t: any) => t.name === 'stripe_charge')).toBe(true);

    // Verify continuation messages include tool_result
    const receivedMessages = upstream.lastReceivedPayload.messages;
    const toolResultMsg = receivedMessages.find((m: any) =>
      Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
    );
    expect(toolResultMsg).toBeDefined();
  });

  it('reports cumulative savings via /stats', async () => {
    const res = await makeRequest('/stats');
    expect(res.status).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats.totalTurns).toBeGreaterThan(0);
    expect(stats.totalTokensSaved).toBeGreaterThan(0);
  });

  describe('OpenAI / Gemini SDK Compatibility (/v1/chat/completions)', () => {
    it('intercepts POST /v1/chat/completions, prunes system message & tools, and routes to upstream', async () => {
      const bloatedSystem = 'You are an AI coding assistant.\nAvailable skills:\n' +
        Array.from({ length: 25 }, (_, i) => `- skill_${i}: Does task ${i} with tools\n`).join('');

      const payload = {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: bloatedSystem },
          { role: 'user', content: 'Please use skill_4 to analyze my database' }
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'bash', description: 'Run shell commands' }
          },
          {
            type: 'function',
            function: { name: 'skill_4', description: 'Database query tool for skill 4' }
          },
          {
            type: 'function',
            function: { name: 'slack_send', description: 'Send Slack messages' }
          },
          {
            type: 'function',
            function: { name: 'jira_create', description: 'Create Jira ticket' }
          },
          {
            type: 'function',
            function: { name: 'github_pr', description: 'Open GitHub pull request' }
          }
        ]
      };

      const res = await makeRequest('/v1/chat/completions', 'POST', payload, {
        authorization: 'Bearer sk-mock-key-456'
      });

      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.choices[0].message.content).toContain('Mock OpenAI response');

      // Verify upstream received PRUNED system message and tools
      const receivedMessages = upstream.lastReceivedPayload.messages;
      const systemMsg = receivedMessages.find((m: any) => m.role === 'system');
      expect(systemMsg.content).toContain('skill_4');
      expect(systemMsg.content).not.toContain('skill_20');

      // Verify tools were pruned to relevant + core tools
      const receivedTools = upstream.lastReceivedPayload.tools;
      expect(receivedTools.some((t: any) => t.function.name === 'skill_4')).toBe(true);
      expect(receivedTools.some((t: any) => t.function.name === 'bash')).toBe(true);
      expect(receivedTools.some((t: any) => t.function.name === 'proxymcp_request_capability')).toBe(true);
      expect(receivedTools.some((t: any) => t.function.name === 'jira_create')).toBe(false);

      // Verify authorization header forwarded
      expect(upstream.lastReceivedHeaders['authorization']).toBe('Bearer sk-mock-key-456');
    });

    it('streams OpenAI SSE chunks when stream: true', async () => {
      const payload = {
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'Say hello in stream mode' }]
      };

      const res = await makeRequest('/v1/chat/completions', 'POST', payload);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('chatcmpl-123');
      expect(res.body).toContain('"Hello"');
      expect(res.body).toContain('[DONE]');
    });
  });
});

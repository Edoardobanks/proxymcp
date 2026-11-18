import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

describe('MCP Server Integration', () => {
  it('registers all ProxyMCP capability tools', async () => {
    const server = createMcpServer();
    // Use private handler or test server list
    const handlers = (server as any)._requestHandlers;
    expect(handlers.has(ListToolsRequestSchema.shape.method.value)).toBe(true);

    const listFn = handlers.get(ListToolsRequestSchema.shape.method.value);
    const result = await listFn({ method: 'tools/list', params: {} });
    expect(result.tools.length).toBeGreaterThanOrEqual(4);
    const names = result.tools.map((t: any) => t.name);
    expect(names).toContain('proxymcp_optimize_context');
    expect(names).toContain('proxymcp_prune_tools');
    expect(names).toContain('proxymcp_firewall_scan');
    expect(names).toContain('proxymcp_telemetry_stats');
  });

  it('scans and blocks dangerous commands via proxymcp_firewall_scan', async () => {
    const server = createMcpServer();
    const handlers = (server as any)._requestHandlers;
    const callFn = handlers.get(CallToolRequestSchema.shape.method.value);

    // Safe command
    const safeRes = await callFn({
      method: 'tools/call',
      params: {
        name: 'proxymcp_firewall_scan',
        arguments: { content: 'git status && npm test' }
      }
    });
    const safeJson = JSON.parse(safeRes.content[0].text);
    expect(safeJson.allowed).toBe(true);

    // Dangerous command
    const dangerousRes = await callFn({
      method: 'tools/call',
      params: {
        name: 'proxymcp_firewall_scan',
        arguments: { content: 'sudo rm -rf / --no-preserve-root' }
      }
    });
    const dangerousJson = JSON.parse(dangerousRes.content[0].text);
    expect(dangerousJson.allowed).toBe(false);
    expect(dangerousJson.reason).toContain('catastrophic command');
  });

  it('prunes bloated prompt via proxymcp_optimize_context', async () => {
    const server = createMcpServer();
    const handlers = (server as any)._requestHandlers;
    const callFn = handlers.get(CallToolRequestSchema.shape.method.value);

    const bloatedSystem =
      'You are Claude Code.\nAvailable skills:\n' +
      Array.from({ length: 25 }, (_, i) => `- skill_${i}: Does task ${i}\n`).join('');

    const res = await callFn({
      method: 'tools/call',
      params: {
        name: 'proxymcp_optimize_context',
        arguments: {
          systemPrompt: bloatedSystem,
          userQuery: 'Can you help with skill_3?',
          staticPrefixLength: 30
        }
      }
    });

    const json = JSON.parse(res.content[0].text);
    expect(json.tokensSaved).toBeGreaterThan(0);
    expect(json.cachePrefixPreserved).toBe(true);
    expect(json.prunedSystemPrompt).toContain('skill_3');
    expect(json.prunedSystemPrompt).not.toContain('skill_20');
  });
});

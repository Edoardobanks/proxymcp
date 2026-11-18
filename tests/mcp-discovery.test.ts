import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverMcpConfig, getMcpConfigCandidatePaths } from '../src/config/mcp-discovery.js';

describe('mcp-discovery', () => {
  const tmpDir = path.join(os.tmpdir(), `proxymcp-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('lists standard candidate paths', () => {
    const candidates = getMcpConfigCandidatePaths();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.includes('claude_desktop_config.json') || c.includes('.claude'))).toBe(true);
  });

  it('discovers config from explicit path', () => {
    const configPath = path.join(tmpDir, 'test_mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          postgres: { command: 'docker', args: ['run', 'postgres-mcp'] }
        }
      })
    );

    const discovered = discoverMcpConfig(configPath);
    expect(discovered.sourcePath).toBe(path.resolve(configPath));
    expect(discovered.serverCount).toBe(2);
    expect(discovered.servers['github']).toBeDefined();
    expect(discovered.servers['github'].command).toBe('npx');
    expect(discovered.servers['postgres']).toBeDefined();
  });

  it('returns empty result for non-existent explicit path', () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist.json');
    const discovered = discoverMcpConfig(nonExistent);
    expect(discovered.sourcePath).toBeNull();
    expect(discovered.serverCount).toBe(0);
    expect(discovered.servers).toEqual({});
  });

  it('handles invalid JSON gracefully', () => {
    const invalidFile = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(invalidFile, '{ broken: json');

    const discovered = discoverMcpConfig(invalidFile);
    expect(discovered.sourcePath).toBeNull();
    expect(discovered.serverCount).toBe(0);
  });
});

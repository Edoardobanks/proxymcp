import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findProjectRc, loadConfig } from '../src/config/index.js';

describe('Project-Level Configuration (.proxymcprc.json)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxymcp-rc-test-'));
    delete process.env.PROXYMCP_PORT;
    delete process.env.PROXYMCP_MODE;
    delete process.env.PROXYMCP_RC;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('discovers .proxymcprc.json in current directory', () => {
    const rcPath = path.join(tempDir, '.proxymcprc.json');
    const policy = {
      mode: 'balanced',
      maxActiveTools: 5
    };
    fs.writeFileSync(rcPath, JSON.stringify(policy, null, 2));

    const result = findProjectRc(tempDir);
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe(rcPath);
    expect(result?.config.mode).toBe('balanced');
    expect(result?.config.maxActiveTools).toBe(5);
  });

  it('walks upward to find .proxymcprc.json in parent directories', () => {
    const rootRc = path.join(tempDir, '.proxymcprc.json');
    fs.writeFileSync(rootRc, JSON.stringify({ mode: 'passthrough' }));

    const subDir = path.join(tempDir, 'sub', 'deep', 'folder');
    fs.mkdirSync(subDir, { recursive: true });

    const result = findProjectRc(subDir);
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe(rootRc);
    expect(result?.config.mode).toBe('passthrough');
  });

  it('loads explicit path when provided', () => {
    const customRcPath = path.join(tempDir, 'custom-enterprise-policy.json');
    fs.writeFileSync(
      customRcPath,
      JSON.stringify({
        blockedCommands: ['DROP DATABASE'],
        allowedCommands: ['npm test']
      })
    );

    const result = findProjectRc(tempDir, customRcPath);
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe(customRcPath);
    expect(result?.config.allowedCommands).toContain('npm test');
  });

  it('merges layered configuration: defaults -> rc file -> env vars -> overrides', () => {
    const rcPath = path.join(tempDir, '.proxymcprc.json');
    fs.writeFileSync(
      rcPath,
      JSON.stringify({
        port: 8999,
        mode: 'balanced',
        maxActiveTools: 6
      })
    );

    // Load with rcPath override and custom programmatic override
    const config = loadConfig({
      rcPath,
      port: 9005 // programmatic override takes precedence over rc file
    });

    expect(config.port).toBe(9005);
    expect(config.mode).toBe('balanced');
    expect(config.maxActiveTools).toBe(6);
    expect(config.host).toBe('127.0.0.1'); // default preserved
  });
});

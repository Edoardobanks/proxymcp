import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const CLI_PATH = path.resolve('src/cli.ts');

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', CLI_PATH, ...args], {
      env: { ...process.env, NODE_ENV: 'test' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

describe('CLI Smoke Tests', () => {
  it('displays help banner and commands with --help', async () => {
    const res = await runCli(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ProxyMCP');
    expect(res.stdout).toContain('proxymcp start');
    expect(res.stdout).toContain('proxymcp exec');
    expect(res.stdout).toContain('--mcp-config');
  });

  it('runs start command and serves /health on custom port', async () => {
    const TEST_PORT = 8991;
    const child = spawn('npx', ['tsx', CLI_PATH, 'start', '--port', String(TEST_PORT)], {
      env: { ...process.env, NODE_ENV: 'test' }
    });

    try {
      // Wait for server to boot
      await new Promise((resolve) => setTimeout(resolve, 800));

      // Make HTTP request to /health
      const healthRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${TEST_PORT}/health`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode || 200, body }));
        }).on('error', reject);
      });

      expect(healthRes.status).toBe(200);
      const json = JSON.parse(healthRes.body);
      expect(json.status).toBe('ok');
      expect(json.service).toBe('proxymcp');
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('propagates ANTHROPIC_BASE_URL to child process in exec mode', async () => {
    const EXEC_PORT = 8992;
    const res = await runCli([
      'exec',
      '--port',
      String(EXEC_PORT),
      '--',
      'node',
      '-e',
      'console.log("BASE_URL:" + process.env.ANTHROPIC_BASE_URL)'
    ]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`BASE_URL:http://127.0.0.1:${EXEC_PORT}`);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export interface ProjectRcResult {
  filePath: string;
  config: Record<string, any>;
}

/**
 * Searches for a project-level .proxymcprc.json or .proxymcprc configuration file.
 * Walks upward from the starting directory up to filesystem root or git boundary.
 */
export function findProjectRc(startDir = process.cwd(), explicitPath?: string): ProjectRcResult | null {
  if (explicitPath) {
    const resolved = path.resolve(startDir, explicitPath);
    if (fs.existsSync(resolved)) {
      try {
        const raw = fs.readFileSync(resolved, 'utf-8');
        return { filePath: resolved, config: JSON.parse(raw) };
      } catch (err: any) {
        console.warn(`[ProxyMCP] Warning: Failed to parse RC file at ${resolved}: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (true) {
    const jsonRc = path.join(currentDir, '.proxymcprc.json');
    if (fs.existsSync(jsonRc)) {
      try {
        const raw = fs.readFileSync(jsonRc, 'utf-8');
        return { filePath: jsonRc, config: JSON.parse(raw) };
      } catch (err: any) {
        console.warn(`[ProxyMCP] Warning: Failed to parse ${jsonRc}: ${err.message}`);
      }
    }

    const dotRc = path.join(currentDir, '.proxymcprc');
    if (fs.existsSync(dotRc)) {
      try {
        const raw = fs.readFileSync(dotRc, 'utf-8');
        return { filePath: dotRc, config: JSON.parse(raw) };
      } catch (err: any) {
        console.warn(`[ProxyMCP] Warning: Failed to parse ${dotRc}: ${err.message}`);
      }
    }

    if (fs.existsSync(path.join(currentDir, '.git')) || currentDir === root) {
      break;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  return null;
}

export const ProxyConfigSchema = z.object({
  port: z.number().default(8080),
  host: z.string().default('127.0.0.1'),
  upstreamBaseUrl: z.string().url().default('https://api.anthropic.com'),
  openaiUpstreamBaseUrl: z.string().url().default('https://api.openai.com'),
  mode: z.enum(['aggressive', 'balanced', 'passthrough']).default('aggressive'),
  maxActiveTools: z.number().default(3),
  preservePrefixChars: z.number().default(1500),
  mcpConfigPath: z.string().optional(),
  rcPath: z.string().optional()
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

export function loadConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  const explicitRc = overrides?.rcPath || process.env.PROXYMCP_RC;
  const rc = findProjectRc(process.cwd(), explicitRc);
  const rcConfig = rc ? rc.config : {};

  const rawEnv: Record<string, any> = {
    port: process.env.PROXYMCP_PORT ? parseInt(process.env.PROXYMCP_PORT, 10) : undefined,
    host: process.env.PROXYMCP_HOST || undefined,
    upstreamBaseUrl: process.env.PROXYMCP_UPSTREAM || process.env.ANTHROPIC_UPSTREAM || process.env.ANTHROPIC_BASE_URL || undefined,
    openaiUpstreamBaseUrl: process.env.PROXYMCP_OPENAI_UPSTREAM || process.env.OPENAI_BASE_URL || undefined,
    mode: process.env.PROXYMCP_MODE || undefined,
    maxActiveTools: process.env.PROXYMCP_MAX_TOOLS ? parseInt(process.env.PROXYMCP_MAX_TOOLS, 10) : undefined,
    mcpConfigPath: process.env.PROXYMCP_CONFIG || undefined,
    rcPath: process.env.PROXYMCP_RC || undefined
  };

  const cleanObject = (obj?: Record<string, any>) =>
    obj ? Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined)) : {};

  const merged = {
    ...cleanObject(rcConfig),
    ...cleanObject(rawEnv),
    ...cleanObject(overrides)
  };

  return ProxyConfigSchema.parse(merged);
}

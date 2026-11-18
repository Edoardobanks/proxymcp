import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

export const ProxyConfigSchema = z.object({
  port: z.number().default(8080),
  host: z.string().default('127.0.0.1'),
  upstreamBaseUrl: z.string().url().default('https://api.anthropic.com'),
  mode: z.enum(['aggressive', 'balanced', 'passthrough']).default('aggressive'),
  maxActiveTools: z.number().default(3),
  preservePrefixChars: z.number().default(1500),
  firewallEnabled: z.boolean().default(true),
  mcpConfigPath: z.string().optional(),
  blockedCommands: z.array(z.string()).default([
    'rm -rf /',
    'rm -rf ~',
    'mkfs',
    'dd if=',
    ':(){ :|:& };:',
    '> /dev/sda',
    'DROP DATABASE',
    'DROP TABLE',
    'TRUNCATE TABLE'
  ])
});

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;

export function loadConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  const envConfig = {
    port: process.env.PROXYMCP_PORT ? parseInt(process.env.PROXYMCP_PORT, 10) : undefined,
    host: process.env.PROXYMCP_HOST || undefined,
    upstreamBaseUrl: process.env.PROXYMCP_UPSTREAM || process.env.ANTHROPIC_UPSTREAM || undefined,
    mode: (process.env.PROXYMCP_MODE as any) || undefined,
    maxActiveTools: process.env.PROXYMCP_MAX_TOOLS ? parseInt(process.env.PROXYMCP_MAX_TOOLS, 10) : undefined,
    firewallEnabled: process.env.PROXYMCP_FIREWALL === 'false' ? false : undefined,
    mcpConfigPath: process.env.PROXYMCP_CONFIG || undefined
  };

  const merged = {
    ...envConfig,
    ...overrides
  };

  // Strip undefined values so Zod defaults kick in
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([_, v]) => v !== undefined)
  );

  return ProxyConfigSchema.parse(cleaned);
}

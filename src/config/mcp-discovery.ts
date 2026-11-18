import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface DiscoveredMcpConfig {
  sourcePath: string | null;
  servers: Record<string, McpServerConfig>;
  serverCount: number;
}

/**
 * Returns candidate paths for Claude / MCP configuration files in order of precedence.
 */
export function getMcpConfigCandidatePaths(): string[] {
  const home = os.homedir();
  const cwd = process.cwd();

  const candidates: string[] = [
    // Local project config override
    path.join(cwd, 'proxymcp.config.json'),
    path.join(cwd, '.mcp.json'),

    // macOS Claude Desktop config
    path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),

    // Standard cross-platform user configs
    path.join(home, '.claude', 'claude_desktop_config.json'),
    path.join(home, '.config', 'claude', 'claude_desktop_config.json'),
    path.join(home, '.claude.json')
  ];

  return candidates;
}

/**
 * Discovers and parses the active MCP configuration from standard paths or a specified file path.
 */
export function discoverMcpConfig(explicitPath?: string): DiscoveredMcpConfig {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      console.warn(`\x1b[33m[ProxyMCP] Warning: Specified MCP config file not found: ${resolved}\x1b[0m`);
      return { sourcePath: null, servers: {}, serverCount: 0 };
    }

    try {
      const raw = fs.readFileSync(resolved, 'utf-8');
      const parsed = JSON.parse(raw) as McpConfigFile;
      const servers = parsed.mcpServers || {};
      return {
        sourcePath: resolved,
        servers,
        serverCount: Object.keys(servers).length
      };
    } catch (err: any) {
      console.warn(`\x1b[33m[ProxyMCP] Error parsing MCP config at ${resolved}: ${err.message}\x1b[0m`);
      return { sourcePath: null, servers: {}, serverCount: 0 };
    }
  }

  const candidates = getMcpConfigCandidatePaths();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw) as McpConfigFile;
        const servers = parsed.mcpServers || {};
        return {
          sourcePath: candidate,
          servers,
          serverCount: Object.keys(servers).length
        };
      } catch {
        // Silently continue to next candidate if a candidate is unparseable
        continue;
      }
    }
  }

  return { sourcePath: null, servers: {}, serverCount: 0 };
}

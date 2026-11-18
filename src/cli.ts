import { spawn } from 'node:child_process';
import { ProxyServer } from './proxy/server.js';
import { telemetry } from './telemetry/logger.js';
import { discoverMcpConfig } from './config/mcp-discovery.js';

function printBanner() {
  console.log(`
\x1b[35m┌────────────────────────────────────────────────────────┐
│  ⚡ ProxyMCP - Transparent AI Agent Context Firewall   │
└────────────────────────────────────────────────────────┘\x1b[0m
`);
}

function printHelp() {
  printBanner();
  console.log(`Usage:
  proxymcp start [options]       Start the local reverse proxy
  proxymcp exec -- <cmd> [args]  Start proxy and run command with ANTHROPIC_BASE_URL and OPENAI_BASE_URL set
  proxymcp mcp                   Run as an MCP stdio server (connect via agy mcp add)
  proxymcp stats                 View telemetry stats
  proxymcp --help                Show this help message

Options:
  --port <number>              Port to listen on (default: 8080)
  --host <string>              Host to bind to (default: 127.0.0.1)
  --upstream <url>             Upstream Anthropic API (default: https://api.anthropic.com)
  --openai-upstream <url>      Upstream OpenAI API (default: https://api.openai.com)
  --mode <mode>                aggressive | balanced | passthrough (default: aggressive)
  --rc <path>                  Path to custom project config (.proxymcprc.json)
  --mcp-config <path>          Path to MCP config file (auto-detects Claude Desktop by default)
  --no-firewall                Disable destructive action firewall

Examples:
  npx proxymcp start
  npx proxymcp exec -- claude
  npx proxymcp exec -- agy
`);
}

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(0);
  }

  // Parse flags
  let port = 8080;
  let host = '127.0.0.1';
  let upstream: string | undefined;
  let openaiUpstream: string | undefined;
  let mode: 'aggressive' | 'balanced' | 'passthrough' | undefined;
  let mcpConfigPath: string | undefined;
  let rcPath: string | undefined;
  let firewallEnabled = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--upstream' && args[i + 1]) {
      upstream = args[i + 1];
      i++;
    } else if (args[i] === '--openai-upstream' && args[i + 1]) {
      openaiUpstream = args[i + 1];
      i++;
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1] as any;
      i++;
    } else if (args[i] === '--rc' && args[i + 1]) {
      rcPath = args[i + 1];
      i++;
    } else if (args[i] === '--mcp-config' && args[i + 1]) {
      mcpConfigPath = args[i + 1];
      i++;
    } else if (args[i] === '--no-firewall') {
      firewallEnabled = false;
    }
  }

  // Discovered MCP configuration
  const mcpConfig = discoverMcpConfig(mcpConfigPath);

  if (command === 'start') {
    printBanner();
    if (mcpConfig.serverCount > 0) {
      console.log(`\x1b[36m✔ Discovered ${mcpConfig.serverCount} MCP server(s) from ${mcpConfig.sourcePath}\x1b[0m`);
      console.log(`  Servers: ${Object.keys(mcpConfig.servers).join(', ')}`);
    } else if (mcpConfigPath) {
      console.log(`\x1b[33m⚠ No MCP servers found at specified path: ${mcpConfigPath}\x1b[0m`);
    }

    const proxy = new ProxyServer({
      port,
      host,
      upstreamBaseUrl: upstream,
      openaiUpstreamBaseUrl: openaiUpstream,
      mode,
      rcPath,
      firewallEnabled,
      mcpConfigPath: mcpConfig.sourcePath || undefined
    });
    await proxy.start();

    console.log(`\n\x1b[33mTo connect your coding agent, run in your terminal:\x1b[0m`);
    console.log(`\x1b[1mexport ANTHROPIC_BASE_URL=http://${host}:${port}\x1b[0m`);
    console.log(`\x1b[1mexport OPENAI_BASE_URL=http://${host}:${port}/v1\x1b[0m\n`);

    const cleanup = async () => {
      console.log('\nStopping ProxyMCP...');
      const summary = telemetry.getSummary();
      console.log('\nSession Summary:');
      console.table(summary);
      await proxy.stop();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } else if (command === 'exec') {
    const separatorIndex = args.indexOf('--');
    if (separatorIndex === -1 || separatorIndex === args.length - 1) {
      console.error('Error: specify command after --, e.g. proxymcp exec -- claude');
      process.exit(1);
    }

    const childCmd = args[separatorIndex + 1];
    const childArgs = args.slice(separatorIndex + 2);

    printBanner();
    if (mcpConfig.serverCount > 0) {
      console.log(`\x1b[36m✔ Discovered ${mcpConfig.serverCount} MCP server(s) from ${mcpConfig.sourcePath}\x1b[0m`);
    }

    const proxy = new ProxyServer({
      port,
      host,
      upstreamBaseUrl: upstream,
      openaiUpstreamBaseUrl: openaiUpstream,
      mode,
      rcPath,
      firewallEnabled,
      mcpConfigPath: mcpConfig.sourcePath || undefined
    });
    await proxy.start();

    console.log(`🚀 Spawning child process: \x1b[36m${childCmd} ${childArgs.join(' ')}\x1b[0m with ANTHROPIC_BASE_URL & OPENAI_BASE_URL set...`);

    const child = spawn(childCmd, childArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://${host}:${port}`,
        OPENAI_BASE_URL: `http://${host}:${port}/v1`
      }
    });

    child.on('exit', async (code) => {
      console.log(`\nChild process exited with code ${code}`);
      const summary = telemetry.getSummary();
      console.log('\nSession Summary:');
      console.table(summary);
      await proxy.stop();
      process.exit(code ?? 0);
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  } else if (command === 'mcp') {
    const { runStdioMcpServer } = await import('./mcp/server.js');
    await runStdioMcpServer();
  } else {
    printHelp();
  }
}

if (process.argv[1] && process.argv[1].endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}

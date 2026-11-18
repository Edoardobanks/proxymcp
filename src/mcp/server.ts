import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { ContextPruner } from '../optimizer/context-pruner.js';
import { ToolPruner, ToolDefinition } from '../optimizer/tool-pruner.js';
import { ContextFirewall } from '../firewall/guardrail.js';
import { telemetry } from '../telemetry/logger.js';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'proxymcp',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  const contextPruner = new ContextPruner({ staticPrefixLength: 1500 });
  const toolPruner = new ToolPruner({ maxActiveTools: 3 });
  const firewall = new ContextFirewall();

  const TOOLS: Tool[] = [
    {
      name: 'proxymcp_optimize_context',
      description:
        'Prunes bloated system prompts (skills catalog, rules, guidelines) matching user intent while preserving the static cache prefix for maximum LLM prompt caching.',
      inputSchema: {
        type: 'object',
        properties: {
          systemPrompt: {
            type: 'string',
            description: 'The bloated system prompt containing skills, rules, or guidelines.'
          },
          userQuery: {
            type: 'string',
            description: 'The user query/intent to match relevant skills and rules against.'
          },
          staticPrefixLength: {
            type: 'number',
            description: 'Number of initial characters to freeze byte-identically (default: 1500).'
          }
        },
        required: ['systemPrompt', 'userQuery']
      }
    },
    {
      name: 'proxymcp_prune_tools',
      description:
        'Prunes a large catalog of MCP tool schemas down to the 2-3 most relevant for the current user query, injecting a lightweight meta-tool for on-demand activation.',
      inputSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            description: 'Array of tool definitions with name, description, and input_schema.',
            items: { type: 'object' }
          },
          userQuery: {
            type: 'string',
            description: 'The current user query to evaluate tool relevance against.'
          },
          maxActiveTools: {
            type: 'number',
            description: 'Maximum active tools to retain (default: 3).'
          }
        },
        required: ['tools', 'userQuery']
      }
    },
    {
      name: 'proxymcp_firewall_scan',
      description:
        'Scans shell commands, SQL queries, or prompts against the ProxyMCP Zero-Trust Execution Firewall. Detects catastrophic shell commands, destructive database drops, and prompt injections.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The command, code snippet, or prompt to inspect for dangerous patterns.'
          }
        },
        required: ['content']
      }
    },
    {
      name: 'proxymcp_telemetry_stats',
      description:
        'Returns the live ProxyMCP session telemetry odometer: total turns, tokens saved, latency overhead, and blocked firewall violations.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'proxymcp_optimize_context') {
      const { systemPrompt, userQuery, staticPrefixLength } = (args || {}) as any;
      if (!systemPrompt || typeof systemPrompt !== 'string') {
        throw new Error('systemPrompt must be a string');
      }

      const pruner = staticPrefixLength
        ? new ContextPruner({ staticPrefixLength })
        : contextPruner;

      const result = pruner.pruneSystemPrompt(systemPrompt, userQuery || '');
      const percentSaved =
        result.originalTokensEstimated > 0
          ? ((result.tokensSaved / result.originalTokensEstimated) * 100).toFixed(1) + '%'
          : '0%';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                originalTokensEstimated: result.originalTokensEstimated,
                prunedTokensEstimated: result.prunedTokensEstimated,
                tokensSaved: result.tokensSaved,
                percentSaved,
                cachePrefixPreserved: result.cachePrefixPreserved,
                prunedSystemPrompt: result.prunedSystem
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (name === 'proxymcp_prune_tools') {
      const { tools, userQuery, maxActiveTools } = (args || {}) as any;
      if (!Array.isArray(tools)) {
        throw new Error('tools must be an array');
      }

      const p = maxActiveTools ? new ToolPruner({ maxActiveTools }) : toolPruner;
      const result = p.pruneTools(tools as ToolDefinition[], userQuery || '');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                originalToolsCount: result.originalTools.length,
                prunedToolsCount: result.prunedTools.length,
                omittedToolsCount: result.omittedToolNames.length,
                omittedToolNames: result.omittedToolNames,
                tokensSaved: result.tokensSaved,
                activeTools: result.prunedTools
              },
              null,
              2
            )
          }
        ]
      };
    }

    if (name === 'proxymcp_firewall_scan') {
      const { content } = (args || {}) as any;
      if (typeof content !== 'string') {
        throw new Error('content must be a string');
      }

      const scan = firewall.scanContent(content);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(scan, null, 2)
          }
        ]
      };
    }

    if (name === 'proxymcp_telemetry_stats') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(telemetry.getSummary(), null, 2)
          }
        ]
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

export async function runStdioMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  runStdioMcpServer().catch((err) => {
    process.stderr.write(`Fatal MCP Error: ${err.message}\n`);
    process.exit(1);
  });
}

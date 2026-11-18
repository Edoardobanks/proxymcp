import { describe, it, expect } from 'vitest';
import { ContextPruner } from '../src/optimizer/context-pruner.js';
import { ToolPruner } from '../src/optimizer/tool-pruner.js';

describe('ContextPruner', () => {
  const pruner = new ContextPruner({ staticPrefixLength: 500 });

  it('prunes massive skills catalogs while preserving static prefix', () => {
    const staticPrefix = 'You are Claude Code, an expert software engineering assistant. Always follow project conventions.\n'.repeat(6);
    
    let skillsCatalog = 'Available skills:\n';
    for (let i = 1; i <= 30; i++) {
      skillsCatalog += `- skill_${i} (/path/to/skill_${i}/SKILL.md): Performs task number ${i} with long descriptions and documentation parameters.\n`;
    }

    const fullPrompt = `${staticPrefix}\n${skillsCatalog}\n<RULE[/path/to/rule.md]>\n# Coding Guidelines\n${'Follow clean architecture rules.\n'.repeat(50)}</RULE[/path/to/rule.md]>`;

    const userQuery = 'Can you help me with skill_5 in my repository?';
    const result = pruner.pruneSystemPrompt(fullPrompt, userQuery);

    expect(result.tokensSaved).toBeGreaterThan(500);
    expect(result.prunedTokensEstimated).toBeLessThan(result.originalTokensEstimated);
    expect(result.cachePrefixPreserved).toBe(true);

    // Matches skill_5
    expect(result.prunedSystem).toContain('skill_5');
    // Non-matching skills omitted
    expect(result.prunedSystem).not.toContain('skill_28');
  });

  it('handles short or empty prompts without breaking', () => {
    const shortPrompt = 'You are a helpful assistant.';
    const result = pruner.pruneSystemPrompt(shortPrompt, 'hello');
    expect(result.prunedSystem).toBe(shortPrompt);
    expect(result.tokensSaved).toBe(0);
  });
});

describe('ToolPruner', () => {
  it('prunes tools to maxActiveTools and injects meta-tool', () => {
    const pruner = new ToolPruner({ maxActiveTools: 3 });

    // Realistic MCP tool schemas with property definitions
    const tools = [
      {
        name: 'read_file',
        description: 'Read file contents from filesystem',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      },
      {
        name: 'edit_file',
        description: 'Edit file contents',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } } }
      },
      {
        name: 'slack_send',
        description: 'Send Slack message to a channel or user',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, attachments: { type: 'array' } } }
      },
      {
        name: 'postgres_query',
        description: 'Execute SQL query against production Postgres database',
        input_schema: { type: 'object', properties: { sql: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['sql'] }
      },
      {
        name: 'k8s_delete_pod',
        description: 'Delete kubernetes pod across namespace cluster',
        input_schema: { type: 'object', properties: { pod_name: { type: 'string' }, namespace: { type: 'string' }, grace_period: { type: 'number' } } }
      },
      {
        name: 'github_create_issue',
        description: 'Create GitHub issue in repository with labels and assignees',
        input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array' } } }
      }
    ];

    const result = pruner.pruneTools(tools, 'Can you run a query on postgres?');

    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.prunedTools.some((t) => t.name === 'postgres_query')).toBe(true);
    expect(result.prunedTools.some((t) => t.name === 'proxymcp_request_capability')).toBe(true);
    expect(result.omittedToolNames).toContain('k8s_delete_pod');
    expect(result.omittedToolNames).toContain('github_create_issue');
  });

  it('automatically resolves DAG dependencies for active tools', () => {
    const pruner = new ToolPruner({ maxActiveTools: 4 });
    pruner.setDependency('refund_payment', ['lookup_customer', 'verify_transaction']);

    const tools = [
      { name: 'lookup_customer', description: 'Find customer details' },
      { name: 'verify_transaction', description: 'Verify transaction ID' },
      { name: 'refund_payment', description: 'Process monetary refund' },
      { name: 'deploy_cluster', description: 'Deploy cloud cluster' },
      { name: 'send_newsletter', description: 'Send email blast' }
    ];

    const result = pruner.pruneTools(tools, 'Please issue a refund_payment for order 123');

    // refund_payment should pull in lookup_customer and verify_transaction
    expect(result.prunedTools.some((t) => t.name === 'refund_payment')).toBe(true);
    expect(result.prunedTools.some((t) => t.name === 'lookup_customer')).toBe(true);
    expect(result.prunedTools.some((t) => t.name === 'verify_transaction')).toBe(true);
    expect(result.omittedToolNames).toContain('deploy_cluster');
    expect(result.omittedToolNames).toContain('send_newsletter');
  });

  it('prunes OpenAI function formatted tools and preserves schema format', () => {
    const pruner = new ToolPruner({ maxActiveTools: 2 });

    const openAiTools = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run shell commands and scripts in terminal environment',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'sql_runner',
          description: 'Run SQL database queries on production Postgres cluster',
          parameters: { type: 'object', properties: { sql: { type: 'string' }, timeout: { type: 'number' } }, required: ['sql'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'slack_notifier',
          description: 'Send alerts to team Slack channels with rich blocks and mention formatting',
          parameters: { type: 'object', properties: { message: { type: 'string' }, channel: { type: 'string' }, blocks: { type: 'array' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'jira_ticket',
          description: 'Create Jira tickets for team sprint planning with assignees, labels, and issue types',
          parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, project: { type: 'string' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'k8s_cluster_manager',
          description: 'Manage kubernetes namespaces, deployments, ingress rules, and replica pods',
          parameters: { type: 'object', properties: { namespace: { type: 'string' }, action: { type: 'string' }, config: { type: 'object' } } }
        }
      },
      {
        type: 'function',
        function: {
          name: 'datadog_metrics_export',
          description: 'Export telemetry metrics to datadog for latency and error rates',
          parameters: { type: 'object', properties: { metric: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' } } }
        }
      }
    ];

    const result = pruner.pruneTools(openAiTools, 'Query the database using SQL');

    expect(result.tokensSaved).toBeGreaterThan(0);
    // Core tool bash preserved
    expect(result.prunedTools.some((t) => t.function?.name === 'bash')).toBe(true);
    // Matched tool sql_runner preserved
    expect(result.prunedTools.some((t) => t.function?.name === 'sql_runner')).toBe(true);
    // Meta tool generated in OpenAI function format
    const metaTool = result.prunedTools.find((t) => t.function?.name === 'proxymcp_request_capability');
    expect(metaTool).toBeDefined();
    expect(metaTool?.type).toBe('function');
    expect(metaTool?.function?.parameters?.properties).toBeDefined();
    expect(result.omittedToolNames).toContain('jira_ticket');
    expect(result.omittedToolNames).toContain('slack_notifier');
    expect(result.omittedToolNames).toContain('k8s_cluster_manager');
    expect(result.omittedToolNames).toContain('datadog_metrics_export');
  });
});

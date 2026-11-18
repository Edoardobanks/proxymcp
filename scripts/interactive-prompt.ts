import http from 'node:http';
import readline from 'node:readline';
import { estimateTokens } from '../src/optimizer/context-pruner.js';

const PROXY_PORT = parseInt(process.env.PROXYMCP_PORT || '8080', 10);
const PROXY_HOST = process.env.PROXYMCP_HOST || '127.0.0.1';

function printHeader() {
  console.log(`
\x1b[35m┌─────────────────────────────────────────────────────────────────┐
│     ⚡ ProxyMCP Interactive Terminal Prompt Tester               │
│     Target: http://${PROXY_HOST}:${PROXY_PORT}/v1/messages               │
│     Web Dashboard: http://${PROXY_HOST}:${PROXY_PORT}/dashboard          │
└─────────────────────────────────────────────────────────────────┘\x1b[0m
`);
}

function generateBloatedSystemPrompt(): string {
  const skills = [
    'adapt', 'animate', 'audit', 'banner-design', 'brand', 'clarify',
    'colorize', 'critique', 'delight', 'design', 'design-system',
    'distill', 'emil-design-eng', 'hallmark', 'impeccable', 'layout',
    'minimalist-ui', 'optimize', 'overdrive', 'polish', 'typeset', 'ui-ux-pro-max'
  ];

  let text = 'You are an advanced AI coding assistant.\nAvailable skills:\n';
  for (const s of skills) {
    text += `- ${s} (/path/to/skills/${s}/SKILL.md): Comprehensive production engine for ${s} operations with strict validation.\n`;
  }

  text += `
<RULE[/rules/database-safety.md]>
# Enterprise Database Guidelines
Never modify production database migrations without explicit approval.
Always run parameterized queries and verify transactions.
All schema changes must be backward-compatible with semantic versioning.
</RULE[/rules/database-safety.md]>

<RULE[/rules/cloud-deployments.md]>
# Kubernetes Helm Deployment Protocols
Guidelines for deploying pods and configuring ingress routes across multi-zone clusters.
Ensure replica sets and resource quotas are set before releasing to staging.
</RULE[/rules/cloud-deployments.md]>
`;
  return text;
}

function generateTools() {
  return [
    { name: 'read_file', description: 'Read file contents from filesystem' },
    { name: 'edit_file', description: 'Perform surgical substring replacements in a file' },
    { name: 'write_file', description: 'Write or overwrite a file with full contents' },
    { name: 'slack_send', description: 'Send message to team Slack channel' },
    { name: 'jira_create', description: 'Create Jira ticket with sprint labels' },
    { name: 'stripe_charge', description: 'Process customer credit card payment charge' },
    { name: 'k8s_delete_pod', description: 'Delete kubernetes pod across namespace cluster' },
    { name: 'postgres_query', description: 'Execute SQL query against database' }
  ];
}

async function sendPrompt(userQuery: string, label: string) {
  const systemPrompt = generateBloatedSystemPrompt();
  const tools = generateTools();

  const payload = {
    model: 'claude-3-5-sonnet-20241022',
    system: systemPrompt,
    messages: [{ role: 'user', content: userQuery }],
    tools
  };

  const rawJson = JSON.stringify(payload);
  const rawTokens = estimateTokens(rawJson);

  console.log(`\n⏳ Sending ${label}...`);
  console.log(`   User Query: \x1b[36m"${userQuery}"\x1b[0m`);
  console.log(`   Raw Inbound Payload: \x1b[31m${rawTokens.toLocaleString()} tokens\x1b[0m (${tools.length} tools, 22 skills)`);

  const t0 = Date.now();
  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `http://${PROXY_HOST}:${PROXY_PORT}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(rawJson),
            'x-api-key': 'test-interactive-key'
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (c) => chunks.push(Buffer.from(c)));
          response.on('end', () =>
            resolve({
              status: response.statusCode || 200,
              body: Buffer.concat(chunks).toString('utf-8')
            })
          );
        }
      );
      req.on('error', reject);
      req.write(rawJson);
      req.end();
    });

    const elapsed = Date.now() - t0;
    console.log(`\n\x1b[32m✔ Response received in ${elapsed}ms (Status: ${res.status})\x1b[0m`);

    // Fetch live odometer from proxy
    const statsRes = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/stats`).then((r) => r.json());
    console.log(`\n\x1b[35m┌─────────────────────────────────────────────────────────────────┐\x1b[0m`);
    console.log(`\x1b[35m│                 ⚡ LIVE PROXYMCP ODOMETER                       │\x1b[0m`);
    console.log(`\x1b[35m└─────────────────────────────────────────────────────────────────┘\x1b[0m`);
    console.log(`  Total Turns Processed:      \x1b[1m${statsRes.totalTurns}\x1b[0m`);
    console.log(`  Raw Inbound Tokens:         \x1b[31m${statsRes.totalInboundTokens.toLocaleString()}\x1b[0m tokens`);
    console.log(`  Optimized Outbound Tokens:  \x1b[32m${statsRes.totalOutboundTokens.toLocaleString()}\x1b[0m tokens`);
    console.log(`  Total Tokens Saved:         \x1b[1m\x1b[32m-${statsRes.totalTokensSaved.toLocaleString()} (${statsRes.savingsPercentage})\x1b[0m`);
    console.log(`  Prompt Cache Hit Rate:      \x1b[35m${statsRes.cacheHitPreservedRate}\x1b[0m`);
    console.log(`  Estimated Cost Savings:     \x1b[36m${statsRes.estimatedCostSavings}\x1b[0m`);
    console.log(`  Average Proxy Overhead:     \x1b[33m${statsRes.averageLatencyMs} ms\x1b[0m\n`);
    console.log(`\x1b[90m👉 View visualizer at http://${PROXY_HOST}:${PROXY_PORT}/dashboard\x1b[0m\n`);
  } catch (err: any) {
    console.error(`\x1b[31m❌ Connection failed: ${err.message}\x1b[0m`);
    console.log(`\x1b[33mMake sure ProxyMCP is running first:\x1b[0m node dist/cli.js start -p ${PROXY_PORT}\n`);
  }
}

async function main() {
  printHeader();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const promptUser = () => {
    console.log(`Select an option:`);
    console.log(`  1) Test Turn: "Please edit src/index.ts to fix the export" (Code task)`);
    console.log(`  2) Test Turn: "Can you charge customer 50 dollars via stripe?" (Tool capability activation)`);
    console.log(`  3) Type a custom query`);
    console.log(`  4) Exit\n`);

    rl.question(`Choose [1-4]: `, async (choice) => {
      const c = choice.trim();
      if (c === '1') {
        await sendPrompt('Please edit src/index.ts to fix the export', 'Turn 1 (Coding Task)');
        promptUser();
      } else if (c === '2') {
        await sendPrompt('Can you charge customer 50 dollars via stripe?', 'Turn 2 (Payment Capability Task)');
        promptUser();
      } else if (c === '3') {
        rl.question(`\nEnter your prompt: `, async (custom) => {
          if (custom.trim()) {
            await sendPrompt(custom.trim(), 'Custom Prompt Turn');
          }
          promptUser();
        });
      } else {
        console.log('Exiting prompt tester.');
        rl.close();
        process.exit(0);
      }
    });
  };

  promptUser();
}

main().catch(console.error);

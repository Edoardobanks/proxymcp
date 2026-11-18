# ProxyMCP ⚡

> **Zero-config local proxy for Claude Code, Cursor, and AGY that cuts Turn 0 prompt bloat from unused skills and tool sprawl, maintains byte-static cache prefixes, and rehydrates tools on demand.**  
> Sits transparently between your coding CLI and LLM APIs with **< 1ms latency overhead** and zero external dependencies.

[![Tests Passing](https://img.shields.io/badge/tests-34%20passing-brightgreen.svg)](tests/)
[![Latency Overhead](https://img.shields.io/badge/latency-%3C1ms-blue.svg)](scripts/benchmark.ts)
[![Prompt Cache Compatible](https://img.shields.io/badge/prompt--cache-100%25%20prefix%20hit-purple.svg)](src/optimizer/context-pruner.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## The Problem: Turn 0 Prompt Bloat

Before you type a single prompt in **Claude Code**, **Cursor**, or **AGY**, the harness injects massive system prompts into Turn 0:
- **30+ installed skill manifests** (~10k–20k tokens)
- **Repository guidelines and enterprise rules** (~5k–10k tokens)
- **Dozens of complex JSON tool schemas** from multiple connected MCP servers (~5k–15k tokens)

### Why this hurts:
1. **Cold Cache-Write Cost**: Stepping away for a 5-minute coffee break causes Anthropic's prompt cache TTL to expire, resulting in full-price cache writes across 30k–40k tokens.
2. **Context Dilution ("Lost in the Middle")**: Flooding the context window with 30+ inactive tool schemas causes models to hallucinate arguments or pick the wrong tools.
3. **Cache-Breakage Risk**: Naive prompt trimmers modify text at the top of the prompt, breaking Anthropic's exact-match byte prefix and wiping out cache discounts.

---

## The Solution: ProxyMCP

ProxyMCP is a lightweight, local Layer 7 HTTP reverse proxy on `127.0.0.1:8080`. Point your agent's `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to ProxyMCP, and it automatically:

1. **Freezes Byte-Static Cache Prefixes**: Keeps the first 1,500 characters of the system prompt (core persona, formatting) 100% byte-identical, ensuring **100% prompt cache hit rates**.
2. **Prunes Unused Skills & Rules Safely**: Evaluates relevance against the user's intent. Scans full rule content and **strictly protects global safety invariants** (rules with "never", "always", "security", "database migrations" are never pruned).
3. **Virtually Prunes MCP Tools with Dynamic Rehydration**: Exposes only core tools plus tools relevant to the current turn, alongside a lightweight meta-tool `proxymcp_request_capability`. When the model needs an omitted tool, the proxy intercepts the call, restores the tool schema, and seamlessly auto-continues the turn.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer (Claude Code / Cursor / AGY)
    participant Proxy as ProxyMCP (127.0.0.1:8080)
    participant Upstream as Upstream LLM (api.anthropic.com)

    Dev->>Proxy: POST /v1/messages (40k tokens: 35 skills, 15 rules, 25 tools)
    Note over Proxy: 1. Freeze static prefix (100% cache hit)<br/>2. Prune irrelevant skills & condense long docs<br/>3. Protect global safety rules<br/>4. Expose top 3-4 tools + proxymcp_request_capability
    Proxy->>Upstream: POST /v1/messages (Optimized: ~3,700 tokens)
    Upstream-->>Proxy: SSE Stream chunks (zero-copy pass-through)
    Proxy-->>Dev: Real-time response (< 1ms overhead)
    Note over Proxy: Terminal Odometer: 10,000 -> 3,769 tokens (-62.2%)
```

---

## Quickstart

### 1. One-Command Launch with Claude Code

The easiest way to use ProxyMCP is via `exec`, which boots the proxy and launches Claude Code with `ANTHROPIC_BASE_URL` pre-configured:

```bash
npx proxymcp exec -- claude
```

Or with any other coding agent:

```bash
npx proxymcp exec -- agy
```

### 2. Standalone Daemon Mode

Start ProxyMCP in a separate terminal:

```bash
npx proxymcp start
```

Then export the base URL in your shell or profile:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
```

Now Claude Code, Cursor, Aider, or custom SDK scripts route through ProxyMCP automatically.

### 3. Connect via Model Context Protocol (MCP)

ProxyMCP includes an MCP server exposing context optimization and dynamic tool management tools:

```bash
# Add to Antigravity CLI (agy):
agy mcp add proxymcp npx proxymcp mcp
```

Tools exposed:
- `proxymcp_optimize_context`: Prunes bloated system prompts while preserving cache prefix.
- `proxymcp_prune_tools`: Filters large tool catalogs down to relevant tools.
- `proxymcp_request_capability`: On-demand activation of omitted tool capabilities.
- `proxymcp_telemetry_stats`: Live session odometer (tokens saved, cache hit rate, latency).

---

## Agent Compatibility Matrix

| Client / Harness | Network Transport | ProxyMCP Compatibility | How to Connect |
| :--- | :--- | :---: | :--- |
| **Claude Code** | HTTP / REST (`/v1/messages`) | **Full (100%)** | `npx proxymcp exec -- claude` or set `ANTHROPIC_BASE_URL` |
| **Cursor Composer** | HTTP / REST (`/v1/chat/completions`) | **Full (100%)** | Set Custom Base URL in Cursor API settings |
| **Aider** | HTTP / REST | **Full (100%)** | `aider --openai-api-base http://127.0.0.1:8080/v1` |
| **Custom Agent Scripts** (Node/Python) | HTTP / REST (`@anthropic-ai/sdk`, `openai`) | **Full (100%)** | Set `baseURL: "http://127.0.0.1:8080"` |
| **Antigravity CLI (`agy`)** | Google Cloud gRPC (`codeassist`) | **MCP Tools Only** | Model calls use internal gRPC; test proxy via `npm run test:session` |

---

## Standalone Agent Simulation (No Claude Code Needed)

You can run a complete multi-turn coding agent session simulation with a single command:

```bash
npm run test:session
```

This simulator executes 3 realistic agent turns:
1. **Turn 1 (Turn 0 Prompt Bloat Pruning)**: Prunes 25 skill manifests and 9 tool schemas down by **~62%**, strictly preserving database safety invariants.
2. **Turn 2 (Dynamic Capability Rehydration)**: Simulates an omitted Stripe payment tool request. ProxyMCP catches `proxymcp_request_capability`, re-injects the schema, and auto-completes the turn.
3. **Turn 3 (Session Memory & Cache Continuity)**: Confirms rehydrated tools are retained for subsequent turns with 100% byte-static prompt cache preservation.

---

## Testing with Antigravity CLI (`agy`)

If you use **Antigravity CLI (`agy`)** instead of Claude Code, you can test ProxyMCP in two ways:

### Workflow 1: Standalone Agent Session & Live Dashboard
Because `agy` connects to Google's backend over internal gRPC channels rather than HTTP SDKs, you can test ProxyMCP's reverse proxy, tool pruning, and rehydration directly via the interactive CLI prompt tester or session simulator:

1. **Terminal 1**: Start ProxyMCP:
   ```bash
   node dist/cli.js start -p 8080
   ```
2. **Browser**: Open the live dashboard:
   ```
   http://127.0.0.1:8080/dashboard
   ```
3. **Terminal 2**: Run the agent session simulator or prompt runner:
   ```bash
   npm run test:session
   # or: npm run prompt
   ```
   Watch the live token odometer update on the dashboard and in the terminal!

### Workflow 2: Native `agy` MCP Integration
ProxyMCP can also be registered as a Model Context Protocol server in `agy`:

```bash
# Enable in agy:
agy mcp enable proxymcp
```
*(Note: To save Turn 0 tokens in agy when not testing MCP tools, keep it disabled via `agy mcp disable proxymcp`)*.

---

## How to Verify Savings with Claude Code `/context`

You don't have to take synthetic benchmarks on faith. You can measure actual token savings directly inside Claude Code:

### Step 1: Baseline Session (Without ProxyMCP)
```bash
# Start standard Claude Code
claude
```
In Claude Code, type:
```
/context
```
Note the initial tokens consumed by installed skills, project guidelines, and MCP tools (often 20,000–40,000 tokens before any conversation).

### Step 2: Optimized Session (With ProxyMCP)
```bash
# Start with ProxyMCP
npx proxymcp exec -- claude
```
In Claude Code, type:
```
/context
```
Compare the initial token count. You will see an immediate reduction in Turn 0 token overhead, while all relevant tools and critical instructions remain available.

You can also run our automated verification script anytime:
```bash
npm run live-check
```

---

## Live Web Dashboard

ProxyMCP includes a built-in real-time telemetry dashboard. Open:

```
http://127.0.0.1:8080/dashboard
```

The dashboard streams live SSE events showing:
- **Tokens Saved & % Reduction** across all turns
- **Estimated Cost Savings** (calculated on Claude 3.5 Sonnet pricing)
- **Proxy Latency Overhead** (< 1ms SLA)
- **Prompt Cache Prefix Integrity** (100% byte-static preservation)
- **Real-Time Token Stream Visualizer**

---

## Benchmark Suite

Run the worst-case Turn 0 stress-test simulation anytime:

```bash
npm run benchmark
```

### Synthetic Simulation Results (35 Installed Skills + 12 Enterprise Rules + 12 MCP Tools)

| Metric | Before (Unoptimized) | After (ProxyMCP) | Savings / Difference |
| :--- | :--- | :--- | :--- |
| **System Prompt Tokens** | `9,052 tokens` | `3,338 tokens` | **-5,714 (-63.1%)** |
| **Active Tools Exposed** | `12 tools` | `4 tools` | **-8 tools (9 omitted on demand)** |
| **Tool Schema Tokens** | `908 tokens` | `411 tokens` | **-497 (-54.7%)** |
| **Total Turn 0 Tokens** | **9,980 tokens** | **3,769 tokens** | **-62.2% initial token reduction** |
| **Prompt Cache Prefix** | Dynamic / Unstable | **PRESERVED (Byte-static)** | **100% Cache-Hit Compatible** |
| **Proxy Engine Latency** | `0.00 ms` | **`0.86 ms`** | **< 1ms Native Streaming Feel** |

*Note: Real-world savings depend on your environment's installed skill count and MCP tools (typically 30%–70% on Turn 0).*

---

## Architecture & Design Principles

| Principle | Implementation |
| :--- | :--- |
| **Simplicity First** | No bloated regex blacklists or fragile security claims. Focuses 100% on high-speed context optimization and prompt caching. |
| **Zero-Copy Streaming** | Passes Server-Sent Events (SSE) directly from upstream to downstream without buffering tokens. |
| **Safety Invariant Protection** | Inspects complete rule bodies; never prunes global rules containing security, migration, compliance, or strict directive keywords. |
| **Virtual Tool Rehydration** | Models can summon omitted tools on demand via `proxymcp_request_capability`. The proxy intercepts the request and auto-continues the turn. |

---

## License

MIT © Edoardo Sproccati

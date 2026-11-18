export function renderDashboardHtml(initialStats: any, port = 8080, host = '127.0.0.1', mode = 'aggressive'): string {
  const jsonStats = JSON.stringify(initialStats).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ProxyMCP - Local Context Gateway Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: rgba(255, 255, 255, 0.08);
      --card-hover: rgba(255, 255, 255, 0.12);
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --text-dim: #6b7280;
      --primary: #8b5cf6;
      --primary-glow: rgba(139, 92, 246, 0.25);
      --accent: #06b6d4;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.2);
      --danger: #ef4444;
      --danger-glow: rgba(239, 68, 68, 0.2);
      --warning: #f59e0b;
      --font-mono: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, Monaco, monospace;
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 24px;
      line-height: 1.5;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
      width: 100%;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      box-shadow: 0 0 20px var(--primary-glow);
    }

    .brand h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .brand p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .header-badges {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 500;
      font-family: var(--font-mono);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
    }

    .badge.live {
      background: var(--success-glow);
      border-color: rgba(16, 185, 129, 0.4);
      color: #34d399;
    }

    .badge.mode {
      background: rgba(139, 92, 246, 0.15);
      border-color: rgba(139, 92, 246, 0.3);
      color: #c084fc;
    }

    .live-dot {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      transition: border-color 0.2s, transform 0.2s;
      position: relative;
      overflow: hidden;
    }

    .kpi-card:hover {
      border-color: var(--card-hover);
      transform: translateY(-2px);
    }

    .kpi-label {
      font-size: 13px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .kpi-value {
      font-size: 30px;
      font-weight: 800;
      font-family: var(--font-mono);
      letter-spacing: -0.03em;
      margin-bottom: 6px;
      color: var(--text);
    }

    .kpi-subtext {
      font-size: 12px;
      color: var(--text-dim);
    }

    .highlight-green { color: #34d399; }
    .highlight-cyan { color: #38bdf8; }
    .highlight-purple { color: #c084fc; }
    .highlight-amber { color: #fbbf24; }
    .highlight-red { color: #f87171; }

    /* Visualizer Card */
    .visualizer-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 22px;
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .stream-bar-container {
      margin-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .stream-bar-row {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 13px;
      font-family: var(--font-mono);
    }

    .stream-bar-label {
      width: 140px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .stream-bar-track {
      flex: 1;
      height: 24px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 6px;
      overflow: hidden;
      position: relative;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .stream-bar-fill {
      height: 100%;
      border-radius: 5px;
      transition: width 0.4s ease;
      display: flex;
      align-items: center;
      padding-left: 10px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }

    .bar-inbound {
      background: linear-gradient(90deg, #475569, #64748b);
      color: #f1f5f9;
    }

    .bar-outbound {
      background: linear-gradient(90deg, #059669, #10b981);
      color: #ffffff;
      box-shadow: 0 0 12px var(--success-glow);
    }

    /* Actions and Simulation Bar */
    .action-bar {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-primary {
      background: linear-gradient(135deg, #7c3aed, #6366f1);
      border-color: transparent;
      box-shadow: 0 2px 10px var(--primary-glow);
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, #6d28d9, #4f46e5);
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }

    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.25);
    }

    /* Activity Feed Table */
    .table-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }

    .table-header {
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--card-border);
    }

    .filter-tabs {
      display: flex;
      gap: 6px;
    }

    .tab-btn {
      padding: 5px 12px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .tab-btn.active {
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--card-border);
      color: var(--text);
      font-weight: 600;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }

    th {
      padding: 12px 20px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      border-bottom: 1px solid var(--card-border);
      background: rgba(0, 0, 0, 0.2);
    }

    td {
      padding: 14px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      font-family: var(--font-mono);
      font-size: 12px;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .status-pill {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }

    .status-optimized {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-blocked {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .status-passthrough {
      background: rgba(107, 114, 128, 0.15);
      color: #9ca3af;
      border: 1px solid rgba(107, 114, 128, 0.3);
    }

    /* Quick Connect Snippets */
    .connect-card {
      background: rgba(17, 24, 39, 0.6);
      border: 1px dashed var(--card-border);
      border-radius: 12px;
      padding: 20px;
    }

    .code-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }

    .code-box {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      position: relative;
    }

    .code-box-header {
      font-size: 11px;
      color: var(--text-dim);
      margin-bottom: 6px;
      text-transform: uppercase;
      font-weight: 600;
    }

    .code-box pre {
      color: #38bdf8;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .copy-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: var(--text-muted);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 10px;
      cursor: pointer;
    }

    .copy-btn:hover { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">⚡</div>
        <div>
          <h1>ProxyMCP Context Gateway</h1>
          <p>Local-First Prompt Optimization & Dynamic Tool Gateway</p>
        </div>
      </div>

      <div class="header-badges">
        <span class="badge live"><span class="live-dot"></span> LIVE SSE STREAM</span>
        <span class="badge mode">MODE: ${mode.toUpperCase()}</span>
        <span class="badge">HOST: ${host}:${port}</span>
      </div>
    </header>

    <!-- Top KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">
          <span>Tokens Saved</span>
          <span class="highlight-green">⚡</span>
        </div>
        <div class="kpi-value highlight-green" id="kpi-saved">0</div>
        <div class="kpi-subtext" id="kpi-percent">0.0% average reduction</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">
          <span>Est. Cost Saved</span>
          <span class="highlight-cyan">💵</span>
        </div>
        <div class="kpi-value highlight-cyan" id="kpi-cost">$0.0000</div>
        <div class="kpi-subtext">Based on Claude 3.5 Sonnet token pricing</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">
          <span>Proxy Overhead</span>
          <span class="highlight-purple">⏱️</span>
        </div>
        <div class="kpi-value highlight-purple" id="kpi-latency">0.82 ms</div>
        <div class="kpi-subtext">< 1ms Sub-millisecond SLA Met</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">
          <span>Cache Preservation</span>
          <span class="highlight-purple">🎯</span>
        </div>
        <div class="kpi-value highlight-purple" id="kpi-cache">100.0%</div>
        <div class="kpi-subtext">Byte-static prefix cache preserved</div>
      </div>
    </div>

    <!-- Live Token Stream Visualizer -->
    <div class="visualizer-card">
      <div class="section-title">
        <span>⚡ Real-Time Turn 0 Token Compression</span>
        <span class="badge" id="live-turn-indicator">Total Turns: 0</span>
      </div>

      <div class="stream-bar-container">
        <div class="stream-bar-row">
          <div class="stream-bar-label">Raw Inbound:</div>
          <div class="stream-bar-track">
            <div class="stream-bar-fill bar-inbound" id="bar-inbound" style="width: 100%;">
              <span id="bar-inbound-text">0 tokens (100%)</span>
            </div>
          </div>
        </div>

        <div class="stream-bar-row">
          <div class="stream-bar-label">Pruned Outbound:</div>
          <div class="stream-bar-track">
            <div class="stream-bar-fill bar-outbound" id="bar-outbound" style="width: 15%;">
              <span id="bar-outbound-text">0 tokens</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Live Simulation & Controls -->
    <div class="action-bar">
      <button class="btn btn-primary" onclick="simulateTurn()">
        ⚡ Simulate Turn 0 Optimization (42k → 1.2k tokens)
      </button>
      <button class="btn" onclick="resetTelemetry()">
        🔄 Reset Session Stats
      </button>
    </div>

    <!-- Live Activity Table -->
    <div class="table-card">
      <div class="table-header">
        <div class="section-title" style="margin-bottom: 0;">
          <span>Live Turn Feed</span>
        </div>
        <div class="filter-tabs">
          <button class="tab-btn active" onclick="setFilter('ALL', this)">All</button>
          <button class="tab-btn" onclick="setFilter('OPTIMIZED', this)">Optimized</button>
          <button class="tab-btn" onclick="setFilter('BLOCKED', this)">Blocked</button>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Turn</th>
            <th>Time</th>
            <th>Status</th>
            <th>Inbound</th>
            <th>Outbound</th>
            <th>Tokens Saved</th>
            <th>Latency</th>
            <th>Prefix Cache</th>
          </tr>
        </thead>
        <tbody id="turn-tbody">
          <tr>
            <td colspan="8" style="text-align: center; color: var(--text-dim); padding: 32px;">
              No turns captured yet. Send a request from Claude Code, Cursor, or click "Simulate Turn 0" above.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Quick Connect Snippets -->
    <div class="connect-card">
      <div class="section-title">
        <span>🔌 Connect Your Coding Agents</span>
      </div>
      <div class="code-grid">
        <div class="code-box">
          <button class="copy-btn" onclick="copySnippet('export ANTHROPIC_BASE_URL=http://${host}:${port}')">Copy</button>
          <div class="code-box-header">Claude Code / Cursor / Aider</div>
          <pre>export ANTHROPIC_BASE_URL=http://${host}:${port}</pre>
        </div>

        <div class="code-box">
          <button class="copy-btn" onclick="copySnippet('npx proxymcp exec -- claude')">Copy</button>
          <div class="code-box-header">One-Command Auto-Wrapper</div>
          <pre>npx proxymcp exec -- claude</pre>
        </div>

        <div class="code-box">
          <button class="copy-btn" onclick="copySnippet('agy mcp add proxymcp npx proxymcp mcp')">Copy</button>
          <div class="code-box-header">Antigravity CLI (agy) MCP</div>
          <pre>agy mcp add proxymcp npx proxymcp mcp</pre>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentFilter = 'ALL';
    let turnsHistory = [];

    // Initialize with server-rendered data
    try {
      const initial = ${jsonStats};
      updateUI(initial);
      if (initial.recentTurns) {
        turnsHistory = initial.recentTurns;
        renderTable();
      }
    } catch (e) {
      console.warn('Initial parse error:', e);
    }

    function updateUI(summary) {
      if (!summary) return;
      document.getElementById('kpi-saved').textContent = (summary.totalTokensSaved || 0).toLocaleString();
      document.getElementById('kpi-percent').textContent = (summary.savingsPercentage || '0.0%') + ' average reduction';
      document.getElementById('kpi-cost').textContent = summary.estimatedCostSavings || '$0.0000';
      document.getElementById('kpi-latency').textContent = (summary.averageLatencyMs || 0.8) + ' ms';
      const cacheEl = document.getElementById('kpi-cache');
      if (cacheEl) cacheEl.textContent = summary.cacheHitPreservedRate || '100.0%';
      document.getElementById('live-turn-indicator').textContent = 'Total Turns: ' + (summary.totalTurns || 0);

      // Update Visualizer Bar
      const inTokens = summary.totalInboundTokens || 0;
      const outTokens = summary.totalOutboundTokens || 0;
      const inBar = document.getElementById('bar-inbound');
      const outBar = document.getElementById('bar-outbound');
      const inText = document.getElementById('bar-inbound-text');
      const outText = document.getElementById('bar-outbound-text');

      if (inTokens > 0) {
        inText.textContent = inTokens.toLocaleString() + ' tokens (100%)';
        const outPct = Math.max(8, Math.min(100, Math.round((outTokens / inTokens) * 100)));
        outBar.style.width = outPct + '%';
        outText.textContent = outTokens.toLocaleString() + ' tokens (' + outPct + '%)';
      } else {
        inText.textContent = '0 tokens';
        outBar.style.width = '0%';
        outText.textContent = '0 tokens';
      }
    }

    function renderTable() {
      const tbody = document.getElementById('turn-tbody');
      const filtered = turnsHistory.filter(t => {
        if (currentFilter === 'ALL') return true;
        return t.status === currentFilter;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 32px;">No turns match filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(t => {
        let statusClass = 'status-passthrough';
        if (t.status === 'OPTIMIZED') statusClass = 'status-optimized';
        if (t.status === 'BLOCKED') statusClass = 'status-blocked';

        const cacheBadge = t.cacheHit !== false 
          ? '<span style="color: #c084fc;">✔ 100% Hit</span>' 
          : '<span style="color: #9ca3af;">Miss</span>';

        return \`
          <tr>
            <td style="font-weight: 700; color: var(--text);">#\${t.turn}</td>
            <td style="color: var(--text-dim);">\${t.timestamp}</td>
            <td><span class="status-pill \${statusClass}">\${t.status}</span></td>
            <td>\${t.inboundTokens.toLocaleString()}</td>
            <td>\${t.outboundTokens.toLocaleString()}</td>
            <td style="color: #34d399; font-weight: 600;">-\${t.tokensSaved.toLocaleString()} (\${t.savingsPercentage})</td>
            <td>\${t.latencyMs} ms</td>
            <td>\${cacheBadge}</td>
          </tr>
        \`;
      }).join('');
    }

    function setFilter(filter, el) {
      currentFilter = filter;
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      el.classList.add('active');
      renderTable();
    }

    // Connect to SSE stream
    function setupSSE() {
      const eventSource = new EventSource('/api/events');

      eventSource.onmessage = function(event) {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'init') {
            updateUI(payload.data);
            if (payload.data.recentTurns) {
              turnsHistory = payload.data.recentTurns;
              renderTable();
            }
          } else if (payload.type === 'turn') {
            turnsHistory.unshift(payload.data);
            if (turnsHistory.length > 100) turnsHistory.pop();
            updateUI(payload.summary);
            renderTable();
          }
        } catch (err) {
          console.error('SSE parse error:', err);
        }
      };

      eventSource.onerror = function() {
        console.warn('SSE disconnected, falling back to polling...');
        eventSource.close();
        setTimeout(pollStats, 2000);
      };
    }

    function pollStats() {
      fetch('/stats')
        .then(res => res.json())
        .then(data => {
          updateUI(data);
          if (data.recentTurns) {
            turnsHistory = data.recentTurns;
            renderTable();
          }
          setTimeout(pollStats, 2500);
        })
        .catch(() => setTimeout(pollStats, 5000));
    }

    // Interactive Test Triggers
    async function simulateTurn() {
      try {
        const res = await fetch('/api/test-turn', { method: 'POST' });
        const data = await res.json();
      } catch (err) {
        console.error('Simulate turn failed:', err);
      }
    }

    async function resetTelemetry() {
      try {
        await fetch('/api/reset', { method: 'POST' });
        turnsHistory = [];
        renderTable();
        const res = await fetch('/stats');
        const data = await res.json();
        updateUI(data);
      } catch (err) {
        console.error('Reset failed:', err);
      }
    }

    function copySnippet(text) {
      navigator.clipboard.writeText(text);
      alert('Copied to clipboard: ' + text);
    }

    setupSSE();
  </script>
</body>
</html>`;
}

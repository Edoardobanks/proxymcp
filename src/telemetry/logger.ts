export interface TurnStats {
  turn: number;
  inboundTokens: number;
  outboundTokens: number;
  latencyMs: number;
  activeTools: number;
  cacheHit?: boolean;
  blockedViolations?: number;
}

export class TelemetryLogger {
  private turnCounter = 0;
  private totalInboundTokens = 0;
  private totalOutboundTokens = 0;
  private totalSavingsTokens = 0;
  private totalBlocked = 0;

  recordTurn(stats: Omit<TurnStats, 'turn'>): TurnStats {
    this.turnCounter++;
    const turn = this.turnCounter;
    const savings = Math.max(0, stats.inboundTokens - stats.outboundTokens);
    const savingsPct = stats.inboundTokens > 0 
      ? ((savings / stats.inboundTokens) * 100).toFixed(1) 
      : '0.0';

    this.totalInboundTokens += stats.inboundTokens;
    this.totalOutboundTokens += stats.outboundTokens;
    this.totalSavingsTokens += savings;
    if (stats.blockedViolations) {
      this.totalBlocked += stats.blockedViolations;
    }

    // Terminal log
    const tokenBadge = `\x1b[32m${stats.inboundTokens.toLocaleString()} -> ${stats.outboundTokens.toLocaleString()} tokens (-${savingsPct}%)\x1b[0m`;
    const toolsBadge = `\x1b[36m${stats.activeTools} tools\x1b[0m`;
    const latencyBadge = `\x1b[33m${stats.latencyMs}ms\x1b[0m`;
    const cacheBadge = stats.cacheHit !== undefined 
      ? (stats.cacheHit ? '\x1b[35mCache: HIT\x1b[0m' : '\x1b[90mCache: MISS\x1b[0m')
      : '';

    console.log(
      `⚡ [ProxyMCP] Turn ${turn}: ${tokenBadge} | ${toolsBadge} | ${latencyBadge} ${cacheBadge}`.trim()
    );

    return {
      turn,
      ...stats
    };
  }

  getSummary() {
    const overallSavingsPct = this.totalInboundTokens > 0
      ? ((this.totalSavingsTokens / this.totalInboundTokens) * 100).toFixed(1)
      : '0.0';

    // Estimated Anthropic Sonnet input cost ~$3.00 / million tokens
    const estimatedCostSavings = ((this.totalSavingsTokens / 1_000_000) * 3.00).toFixed(4);

    return {
      totalTurns: this.turnCounter,
      totalInboundTokens: this.totalInboundTokens,
      totalOutboundTokens: this.totalOutboundTokens,
      totalSavingsTokens: this.totalSavingsTokens,
      savingsPercentage: `${overallSavingsPct}%`,
      estimatedCostSavings: `$${estimatedCostSavings}`,
      totalBlockedViolations: this.totalBlocked
    };
  }
}

export const telemetry = new TelemetryLogger();

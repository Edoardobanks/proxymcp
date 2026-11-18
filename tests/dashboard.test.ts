import { describe, it, expect, beforeEach } from 'vitest';
import { renderDashboardHtml } from '../src/dashboard/html.js';
import { TelemetryLogger } from '../src/telemetry/logger.js';

describe('Dashboard Unit Tests', () => {
  let telemetry: TelemetryLogger;

  beforeEach(() => {
    telemetry = new TelemetryLogger();
  });

  it('renders dashboard HTML with initial stats and configured host/port', () => {
    const summary = {
      totalTurns: 10,
      totalTokensSaved: 45000,
      savingsPercentage: '85.4%',
      estimatedCostSavings: '$0.1350',
      averageLatencyMs: 0.82,
      totalBlockedViolations: 2,
      totalInboundTokens: 52000,
      totalOutboundTokens: 7000,
      recentTurns: []
    };

    const html = renderDashboardHtml(summary, 8080, '127.0.0.1', 'aggressive');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('ProxyMCP Context Gateway');
    expect(html).toContain('MODE: AGGRESSIVE');
    expect(html).toContain('HOST: 127.0.0.1:8080');
    expect(html).toContain('45000');
    expect(html).toContain('85.4%');
  });

  it('records turns in TelemetryLogger and maintains rolling recent turns', () => {
    telemetry.recordTurn({
      inboundTokens: 10000,
      outboundTokens: 2000,
      latencyMs: 1.1,
      activeTools: 4,
      cacheHit: true
    });

    const summary = telemetry.getSummary();
    expect(summary.totalTurns).toBe(1);
    expect(summary.totalTokensSaved).toBe(8000);
    expect(summary.savingsPercentage).toBe('80.0%');
    expect(summary.recentTurns.length).toBe(1);
    expect(summary.recentTurns[0].status).toBe('OPTIMIZED');
  });

  it('emits live event to subscribers on turn record', () => {
    const events: any[] = [];
    const unsubscribe = telemetry.subscribe((evt) => {
      events.push(evt);
    });

    telemetry.recordTurn({
      inboundTokens: 5000,
      outboundTokens: 1000,
      latencyMs: 0.5,
      activeTools: 2,
      cacheHit: true
    });

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('turn');
    expect(events[0].data.inboundTokens).toBe(5000);
    expect(events[0].data.tokensSaved).toBe(4000);

    unsubscribe();
    telemetry.recordTurn({
      inboundTokens: 1000,
      outboundTokens: 1000,
      latencyMs: 0.1,
      activeTools: 1
    });

    // Should not receive events after unsubscribe
    expect(events.length).toBe(1);
  });

  it('tracks passthrough turns when no tokens are saved', () => {
    telemetry.recordTurn({
      inboundTokens: 1000,
      outboundTokens: 1000,
      latencyMs: 0.2,
      activeTools: 1,
      cacheHit: true
    });

    const summary = telemetry.getSummary();
    expect(summary.recentTurns[0].status).toBe('PASSTHROUGH');
    expect(summary.recentTurns[0].tokensSaved).toBe(0);
    expect(summary.cacheHitPreservedRate).toBe('100.0%');
  });

  it('resets telemetry statistics when reset() is called', () => {
    telemetry.recordTurn({
      inboundTokens: 1000,
      outboundTokens: 200,
      latencyMs: 0.4,
      activeTools: 1
    });

    expect(telemetry.getSummary().totalTurns).toBe(1);
    telemetry.reset();
    expect(telemetry.getSummary().totalTurns).toBe(0);
    expect(telemetry.getSummary().totalTokensSaved).toBe(0);
    expect(telemetry.getSummary().recentTurns.length).toBe(0);
  });
});

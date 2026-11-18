export interface FirewallScanResult {
  allowed: boolean;
  reason?: string;
  threatType?: 'destructive_command' | 'prompt_injection' | 'data_exfiltration';
  matchedPattern?: string;
}

export class ContextFirewall {
  private blockedPatterns: RegExp[];
  private injectionPatterns: RegExp[];

  constructor(customBlocked?: string[]) {
    const rawBlocked = customBlocked ?? [
      'rm\\s+-rf\\s+[/~]',
      'mkfs(\\.[a-z0-9]+)?\\s+',
      'dd\\s+if=',
      ':\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:',
      '>\\s*/dev/sd[a-z]',
      'DROP\\s+DATABASE',
      'DROP\\s+TABLE',
      'TRUNCATE\\s+TABLE',
      'chmod\\s+-R\\s+777\\s+/'
    ];

    this.blockedPatterns = rawBlocked.map((p) => new RegExp(p, 'i'));

    this.injectionPatterns = [
      /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
      /you\s+are\s+now\s+in\s+developer\s+mode/i,
      /system\s+override:\s*disable\s+safety/i,
      /exfiltrate\s+(keys|passwords|credentials|tokens)/i
    ];
  }

  /**
   * Scans text content (user prompts, tool arguments, or message content) for security threats
   */
  scanContent(text: string): FirewallScanResult {
    if (!text) return { allowed: true };

    // 1. Check for destructive commands
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(text)) {
        return {
          allowed: false,
          threatType: 'destructive_command',
          reason: `Blocked potentially catastrophic command matching pattern: ${pattern.source}`,
          matchedPattern: pattern.source
        };
      }
    }

    // 2. Check for indirect prompt injection attempts
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(text)) {
        return {
          allowed: false,
          threatType: 'prompt_injection',
          reason: `Suspicious prompt injection pattern detected: ${pattern.source}`,
          matchedPattern: pattern.source
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Scans an Anthropic tool call block or arguments object
   */
  scanToolCall(toolName: string, input: Record<string, any>): FirewallScanResult {
    const serialized = JSON.stringify(input);

    // High-risk tools: bash, run_command, execute_sql, etc.
    const isExecutionTool = /^(run_command|bash|execute|terminal|shell|sql_query|db_execute)/i.test(
      toolName
    );

    if (isExecutionTool) {
      const scan = this.scanContent(serialized);
      if (!scan.allowed) {
        return scan;
      }
    }

    return { allowed: true };
  }
}

export const firewall = new ContextFirewall();

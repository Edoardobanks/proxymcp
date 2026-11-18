import path from 'node:path';

export interface FirewallScanResult {
  allowed: boolean;
  reason?: string;
  threatType?: 'destructive_command' | 'prompt_injection' | 'data_exfiltration' | 'protected_path' | 'unauthorized_command';
  matchedPattern?: string;
}

export interface FirewallOptions {
  blockedCommands?: string[];
  customBlockedPatterns?: string[];
  protectedPaths?: string[];
  allowedCommands?: string[];
  commandAllowlistOnly?: boolean;
}

export class ContextFirewall {
  private blockedPatterns: RegExp[];
  private injectionPatterns: RegExp[];
  private protectedPaths: string[];
  private allowedCommands: string[];
  private commandAllowlistOnly: boolean;

  constructor(options?: string[] | FirewallOptions) {
    let customBlocked: string[] = [];
    let customRegexes: string[] = [];
    let protectedPaths: string[] = ['.env', '.env.*', '.git', 'id_rsa', 'id_ed25519', '*.pem', '*.key'];
    let allowedCommands: string[] = [];
    let commandAllowlistOnly = false;

    if (Array.isArray(options)) {
      customBlocked = options;
    } else if (options && typeof options === 'object') {
      customBlocked = options.blockedCommands ?? [];
      customRegexes = options.customBlockedPatterns ?? [];
      if (options.protectedPaths && options.protectedPaths.length > 0) {
        protectedPaths = options.protectedPaths;
      }
      allowedCommands = options.allowedCommands ?? [];
      commandAllowlistOnly = options.commandAllowlistOnly ?? false;
    }

    const defaultBlocked = [
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

    // Combine default blocked, custom blocked commands, and custom regexes
    const allBlockedPatterns = [
      ...defaultBlocked,
      ...customBlocked.map((cmd) => this.escapeOrPreservePattern(cmd)),
      ...customRegexes
    ];

    // Remove duplicates
    const uniquePatterns = Array.from(new Set(allBlockedPatterns));
    this.blockedPatterns = uniquePatterns.map((p) => new RegExp(p, 'i'));

    this.injectionPatterns = [
      /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
      /you\s+are\s+now\s+in\s+developer\s+mode/i,
      /system\s+override:\s*disable\s+safety/i,
      /exfiltrate\s+(keys|passwords|credentials|tokens)/i
    ];

    this.protectedPaths = protectedPaths;
    this.allowedCommands = allowedCommands;
    this.commandAllowlistOnly = commandAllowlistOnly;
  }

  private escapeOrPreservePattern(pattern: string): string {
    // If it looks like regex, keep it; otherwise escape special chars and match command boundaries
    const hasRegexMeta = /[\\^$*+?.()|[\]{}]/.test(pattern);
    if (hasRegexMeta) return pattern;
    return `\\b${pattern.replace(/\s+/g, '\\s+')}\\b`;
  }

  /**
   * Evaluates if a given file path touches any protected path policy
   */
  checkProtectedPath(targetPath: string): string | null {
    if (!targetPath) return null;
    const normalized = targetPath.replace(/\\/g, '/').trim();
    const base = path.basename(normalized);

    for (const p of this.protectedPaths) {
      const cleanPattern = p.replace(/\\/g, '/').trim();

      // Wildcard match (e.g. *.pem, .env.*)
      if (cleanPattern.includes('*')) {
        const regexStr = '^' + cleanPattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
        const regex = new RegExp(regexStr, 'i');
        if (regex.test(base) || regex.test(normalized)) {
          return p;
        }
      } else {
        const cleanNoSlash = cleanPattern.replace(/\/$/, '');
        if (
          normalized === cleanPattern ||
          base === cleanPattern ||
          normalized.startsWith(cleanNoSlash + '/') ||
          normalized.endsWith('/' + cleanNoSlash) ||
          normalized.includes('/' + cleanNoSlash + '/')
        ) {
          return p;
        }
      }
    }
    return null;
  }

  /**
   * Checks if a command accesses or operates on a protected path
   */
  private checkCommandProtectedPath(cmd: string): string | null {
    if (!cmd) return null;

    // Check dynamic protected paths in command
    for (const p of this.protectedPaths) {
      const clean = p.replace(/\\/g, '/').trim().replace(/\/$/, '');

      if (clean.includes('*')) {
        const wildcardRegexStr = clean
          .replace(/\./g, '\\.')
          .replace(/\*/g, '[a-zA-Z0-9_.-]*');
        const pattern = new RegExp(`(?:^|[\\s"'\`/])${wildcardRegexStr}(?:[\\s"'\`/]|$)`, 'i');
        if (pattern.test(cmd)) {
          return p;
        }
      } else {
        const escaped = clean.replace(/\./g, '\\.');
        const pattern = new RegExp(`(?:^|[\\s"'\`/])${escaped}(?:\\/[^\\s"'\`]*|\\.[a-zA-Z0-9_-]+)?(?:[\\s"'\`/]|$)`, 'i');
        if (pattern.test(cmd)) {
          return p;
        }
      }
    }

    return null;
  }

  /**
   * Checks if an execution command matches the allowedCommands list
   */
  private isCommandAllowed(cmd: string): boolean {
    if (!cmd || this.allowedCommands.length === 0) return false;
    const trimmed = cmd.trim();

    return this.allowedCommands.some((allowed) => {
      const cleanAllowed = allowed.trim();
      try {
        const regex = new RegExp(`^${cleanAllowed}`, 'i');
        return regex.test(trimmed);
      } catch {
        return trimmed === cleanAllowed || trimmed.startsWith(cleanAllowed);
      }
    });
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

    // 3. Check for direct exfiltration / dump commands of protected paths in text
    const protectedMatch = this.checkCommandProtectedPath(text);
    if (protectedMatch) {
      return {
        allowed: false,
        threatType: 'protected_path',
        reason: `Access to protected path '${protectedMatch}' is restricted by project policy`,
        matchedPattern: protectedMatch
      };
    }

    return { allowed: true };
  }

  /**
   * Scans a tool call block or arguments object
   */
  scanToolCall(toolName: string, input: Record<string, any>): FirewallScanResult {
    if (!input || typeof input !== 'object') {
      return { allowed: true };
    }

    // 1. File Access Tools (read_file, write_file, edit_file, etc.)
    const isFileTool = /^(read_file|write_file|edit_file|delete_file|read|write|view_file|readFile|editFile|writeFile)/i.test(
      toolName
    );

    if (isFileTool) {
      const targetPath = input.path || input.file || input.filePath || input.target || input.Path || input.source;
      if (typeof targetPath === 'string') {
        const matchedProtected = this.checkProtectedPath(targetPath);
        if (matchedProtected) {
          return {
            allowed: false,
            threatType: 'protected_path',
            reason: `Access to protected path '${matchedProtected}' is restricted by project policy`,
            matchedPattern: matchedProtected
          };
        }
      }
    }

    // 2. High-risk execution tools: bash, run_command, execute, terminal, shell, etc.
    const isExecutionTool = /^(run_command|bash|execute|terminal|shell|exec|sql_query|db_execute)/i.test(
      toolName
    );

    if (isExecutionTool) {
      const command = input.command || input.cmd || input.CommandLine || input.script;

      if (typeof command === 'string') {
        // Check allowed commands exemption
        if (this.isCommandAllowed(command)) {
          return { allowed: true };
        }

        // If strict allowlist mode is enabled
        if (this.commandAllowlistOnly && this.allowedCommands.length > 0) {
          return {
            allowed: false,
            threatType: 'unauthorized_command',
            reason: `Command execution '${command}' is blocked: only commands in the project allowlist are permitted`,
            matchedPattern: command
          };
        }

        // Check protected path access in command
        const protectedAccess = this.checkCommandProtectedPath(command);
        if (protectedAccess) {
          return {
            allowed: false,
            threatType: 'protected_path',
            reason: `Command attempts to access protected path '${protectedAccess}'`,
            matchedPattern: protectedAccess
          };
        }
      }

      // Scan serialized input for destructive patterns or injections
      const serialized = JSON.stringify(input);
      const scan = this.scanContent(serialized);
      if (!scan.allowed) {
        return scan;
      }
    }

    return { allowed: true };
  }

  /**
   * Scans an entire API request payload (Anthropic or OpenAI format)
   */
  scanPayload(payload: Record<string, any>, userQuery?: string): FirewallScanResult {
    if (userQuery) {
      const queryScan = this.scanContent(userQuery);
      if (!queryScan.allowed) return queryScan;
    }

    if (!payload || typeof payload !== 'object') {
      return { allowed: true };
    }

    // Scan messages array if present
    if (Array.isArray(payload.messages)) {
      for (const msg of payload.messages) {
        if (!msg) continue;

        // Text content
        if (typeof msg.content === 'string') {
          const contentScan = this.scanContent(msg.content);
          if (!contentScan.allowed) return contentScan;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === 'text' && typeof part.text === 'string') {
              const textScan = this.scanContent(part.text);
              if (!textScan.allowed) return textScan;
            } else if (part?.type === 'tool_result') {
              // Inspect tool execution output (defends against indirect prompt injection)
              if (typeof part.content === 'string') {
                const resultScan = this.scanContent(part.content);
                if (!resultScan.allowed) return resultScan;
              } else if (Array.isArray(part.content)) {
                for (const sub of part.content) {
                  if (sub?.type === 'text' && typeof sub.text === 'string') {
                    const subScan = this.scanContent(sub.text);
                    if (!subScan.allowed) return subScan;
                  }
                }
              }
            } else if (part?.type === 'tool_use' && part.name) {
              // Anthropic tool call in assistant message
              const toolScan = this.scanToolCall(part.name, part.input || {});
              if (!toolScan.allowed) return toolScan;
            }
          }
        }

        // OpenAI role: 'tool' message
        if (msg.role === 'tool' && typeof msg.content === 'string') {
          const toolMsgScan = this.scanContent(msg.content);
          if (!toolMsgScan.allowed) return toolMsgScan;
        }

        // OpenAI tool calls in assistant message
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc?.type === 'function' && tc.function?.name) {
              let args: Record<string, any> = {};
              if (typeof tc.function.arguments === 'string') {
                try {
                  args = JSON.parse(tc.function.arguments);
                } catch {
                  args = { raw: tc.function.arguments };
                }
              } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
                args = tc.function.arguments;
              }
              const toolScan = this.scanToolCall(tc.function.name, args);
              if (!toolScan.allowed) return toolScan;
            }
          }
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Scans an outbound LLM response (JSON object) before returning to the client agent,
   * intercepting generated destructive tool calls or protected file access attempts.
   */
  scanResponse(responseJson: Record<string, any>): FirewallScanResult {
    if (!responseJson || typeof responseJson !== 'object') {
      return { allowed: true };
    }

    // 1. Anthropic response format: { content: [ { type: 'tool_use', name: '...', input: ... } ] }
    if (Array.isArray(responseJson.content)) {
      for (const block of responseJson.content) {
        if (block?.type === 'tool_use' && block.name) {
          const scan = this.scanToolCall(block.name, block.input || {});
          if (!scan.allowed) return scan;
        }
      }
    }

    // 2. OpenAI response format: { choices: [ { message: { tool_calls: [...] } } ] }
    if (Array.isArray(responseJson.choices)) {
      for (const choice of responseJson.choices) {
        if (Array.isArray(choice?.message?.tool_calls)) {
          for (const tc of choice.message.tool_calls) {
            const funcName = tc?.function?.name || tc?.name || '';
            let args: Record<string, any> = {};
            if (typeof tc?.function?.arguments === 'string') {
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = { raw: tc.function.arguments };
              }
            } else if (tc?.function?.arguments && typeof tc.function.arguments === 'object') {
              args = tc.function.arguments;
            }
            const scan = this.scanToolCall(funcName, args);
            if (!scan.allowed) return scan;
          }
        }
      }
    }

    return { allowed: true };
  }
}

export const firewall = new ContextFirewall();

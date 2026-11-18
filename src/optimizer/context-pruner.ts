export interface PruneResult {
  originalSystem: string;
  prunedSystem: string;
  originalTokensEstimated: number;
  prunedTokensEstimated: number;
  tokensSaved: number;
  cachePrefixPreserved: boolean;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Standard approximation: ~4 characters per token for English/code
  return Math.ceil(text.length / 4);
}

export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'about',
  'can', 'you', 'help', 'please', 'does', 'what', 'when', 'where', 'which',
  'who', 'how', 'why', 'are', 'was', 'were', 'been', 'being', 'will',
  'would', 'should', 'could', 'into', 'some', 'than', 'then', 'also', 'just'
]);

export const GENERIC_DEV_TERMS = new Set([
  'file', 'files', 'code', 'project', 'text', 'line', 'lines', 'work',
  'make', 'need', 'test', 'tests', 'directory', 'folder'
]);

export function extractMeaningfulTerms(query: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

export const CRITICAL_RULE_PATTERNS = [
  /\b(?:never|always|do not|must not|prohibited|forbidden)\b/i,
  /\b(?:security|compliance|zero-trust|credentials?|passwords?|secret|api[_-]?key)\b/i,
  /\b(?:database migrations?|production|prod|financial|audit)\b/i
];

export class ContextPruner {
  private staticPrefixLength: number;

  constructor(options?: { staticPrefixLength?: number }) {
    this.staticPrefixLength = options?.staticPrefixLength ?? 1500;
  }

  /**
   * Prunes bloated system prompts while preserving a byte-identical static prefix
   * so Anthropic's prefix prompt cache remains intact.
   */
  pruneSystemPrompt(systemPrompt: string, userQuery: string): PruneResult {
    if (!systemPrompt || systemPrompt.length < 500) {
      const tokens = estimateTokens(systemPrompt);
      return {
        originalSystem: systemPrompt,
        prunedSystem: systemPrompt,
        originalTokensEstimated: tokens,
        prunedTokensEstimated: tokens,
        tokensSaved: 0,
        cachePrefixPreserved: true
      };
    }

    const originalTokens = estimateTokens(systemPrompt);
    const queryTerms = extractMeaningfulTerms(userQuery);

    let processed = systemPrompt;

    // 1. Identify and prune large skills blocks
    processed = this.pruneSection(
      processed,
      /<skills>([\s\S]*?)<\/skills>|(?:Available skills:)([\s\S]*?)(?:<\/skills>|\n+(?=<RULE|<user_rules|\n#[^#]|$))/i,
      (skillsContent) => this.filterListItems(skillsContent, queryTerms, 'skills')
    );

    // 2. Identify and prune large subagent catalogs
    processed = this.pruneSection(
      processed,
      /<subagents>([\s\S]*?)<\/subagents>|(?:Available subagents:)([\s\S]*?)(?:<\/subagents>|\n+(?=<RULE|<user_rules|\n#[^#]|$))/i,
      (subagentsContent) => this.filterListItems(subagentsContent, queryTerms, 'subagents')
    );

    // 3. Prune repetitive user rule injections if bloated
    processed = this.pruneRuleBlocks(processed, queryTerms);

    const prunedTokens = estimateTokens(processed);
    const tokensSaved = Math.max(0, originalTokens - prunedTokens);

    // Verify cache prefix stability
    const prefixLen = Math.min(this.staticPrefixLength, systemPrompt.length, processed.length);
    const cachePrefixPreserved = systemPrompt.substring(0, prefixLen) === processed.substring(0, prefixLen);

    return {
      originalSystem: systemPrompt,
      prunedSystem: processed,
      originalTokensEstimated: originalTokens,
      prunedTokensEstimated: prunedTokens,
      tokensSaved,
      cachePrefixPreserved
    };
  }

  private pruneSection(
    fullText: string,
    sectionRegex: RegExp,
    filterFn: (content: string) => string
  ): string {
    return fullText.replace(sectionRegex, (match, ...args) => {
      const groups = args.slice(0, -2);
      const content = groups.find((g) => typeof g === 'string' && g.length > 0);
      if (!content || content.length < 100) {
        return match;
      }
      const filtered = filterFn(content);
      return match.replace(content, filtered);
    });
  }

  private filterListItems(
    content: string,
    queryTerms: string[],
    itemType: 'skills' | 'subagents'
  ): string {
    const lines = content.split('\n');
    const keptLines: string[] = [];
    const omittedNames: string[] = [];

    let currentItem = '';
    let currentName = '';

    for (const line of lines) {
      // Matches list items starting with "- name", "* name", or "### name"
      const itemMatch = line.match(/^\s*(?:[-*]|###)\s*([a-zA-Z0-9_-]+)/);
      if (itemMatch) {
        if (currentItem) {
          if (this.isItemRelevant(currentItem, queryTerms, currentName)) {
            keptLines.push(currentItem);
          } else {
            omittedNames.push(currentName);
          }
        }
        currentName = itemMatch[1];
        currentItem = line;
      } else if (currentItem) {
        currentItem += '\n' + line;
      } else {
        keptLines.push(line);
      }
    }

    if (currentItem) {
      if (this.isItemRelevant(currentItem, queryTerms, currentName)) {
        keptLines.push(currentItem);
      } else {
        omittedNames.push(currentName);
      }
    }

    // Always keep up to 2 items even if no direct match, to give the agent awareness
    if (keptLines.length === 0 && lines.length > 0) {
      keptLines.push(...lines.slice(0, 3));
    }

    let result = keptLines.join('\n');
    if (omittedNames.length > 0) {
      result += `\n> [ProxyMCP]: ${omittedNames.length} unused ${itemType} pruned from context. Available on demand.`;
    }

    return result;
  }

  private isCriticalRule(content: string, rulePath: string): boolean {
    const combined = `${rulePath}\n${content}`;
    return CRITICAL_RULE_PATTERNS.some((pattern) => pattern.test(combined));
  }

  private isRuleRelevant(rulePath: string, content: string, queryTerms: string[]): boolean {
    if (queryTerms.length === 0) return true;

    const pathLower = rulePath.toLowerCase();
    const contentLower = content.toLowerCase();

    return queryTerms.some((term) => {
      if (GENERIC_DEV_TERMS.has(term)) return false;
      return pathLower.includes(term) || contentLower.includes(term);
    });
  }

  private isItemRelevant(itemText: string, queryTerms: string[], itemName?: string): boolean {
    if (queryTerms.length === 0) return false;

    // 1. Exact or partial match with the item's name/identifier
    if (itemName) {
      const itemLower = itemName.toLowerCase();
      if (
        queryTerms.some(
          (term) =>
            itemLower === term ||
            itemLower.includes(term) ||
            term.includes(itemLower)
        )
      ) {
        return true;
      }
    }

    // 2. Check title / summary line without generic dev stopwords
    const firstLine = itemText.toLowerCase().split('\n')[0];
    return queryTerms.some((term) => {
      if (GENERIC_DEV_TERMS.has(term)) return false;
      return firstLine.includes(term);
    });
  }

  private pruneRuleBlocks(fullText: string, queryTerms: string[]): string {
    // Matches XML-style <RULE[...]>[content]</RULE[...]>
    return fullText.replace(/<RULE\[(.*?)\]>([\s\S]*?)<\/RULE\[\1\]>/g, (match, rulePath, content) => {
      // 1. Invariant safety & compliance rules must NEVER be pruned
      if (this.isCriticalRule(content, rulePath)) {
        return match;
      }

      // 2. If the user query is relevant to any part of the rule content, keep it
      if (this.isRuleRelevant(rulePath, content, queryTerms)) {
        return match;
      }

      // 3. For long (>500 chars), non-critical, non-matched rules, condense into a structured summary
      if (content.length > 500) {
        const titleMatch = content.match(/^#+\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : rulePath;
        const keyPoints = content
          .split('\n')
          .filter((line: string) => /^\s*(?:[-*]|\d+\.)\s+/.test(line))
          .slice(0, 3)
          .map((l: string) => l.trim().replace(/^[-*\d.]+\s*/, ''))
          .join('; ');
        const summary = keyPoints ? ` Key topics: ${keyPoints}.` : '';

        return `<RULE[${rulePath}]>\n# ${title}\n<!-- [ProxyMCP Condensed Rule]: Full guidelines retained in repository files.${summary} -->\n</RULE[${rulePath}]>`;
      }

      return match;
    });
  }
}

export const contextPruner = new ContextPruner();

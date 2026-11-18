import { estimateTokens, extractMeaningfulTerms } from './context-pruner.js';

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, any>;
  [key: string]: any;
}

export interface ToolPruneResult {
  originalTools: ToolDefinition[];
  prunedTools: ToolDefinition[];
  originalTokensEstimated: number;
  prunedTokensEstimated: number;
  tokensSaved: number;
  omittedToolNames: string[];
}

export class ToolPruner {
  private maxActiveTools: number;
  private coreToolVerbs: Set<string>;
  private dependencies: Map<string, string[]>;

  constructor(options?: {
    maxActiveTools?: number;
    coreTools?: string[];
    dependencies?: Record<string, string[]>;
  }) {
    this.maxActiveTools = options?.maxActiveTools ?? 4;
    this.coreToolVerbs = new Set(
      options?.coreTools ?? ['read_file', 'edit_file', 'write_file', 'run_command']
    );
    this.dependencies = new Map(Object.entries(options?.dependencies ?? {}));
  }

  /**
   * Sets a DAG dependency rule (e.g. 'refund_payment' requires ['lookup_customer', 'get_transaction'])
   */
  setDependency(tool: string, prerequisites: string[]) {
    this.dependencies.set(tool, prerequisites);
  }

  pruneTools(tools: ToolDefinition[], userQuery: string): ToolPruneResult {
    if (!tools || tools.length <= this.maxActiveTools) {
      const tokens = this.calculateToolsTokens(tools);
      return {
        originalTools: tools || [],
        prunedTools: tools || [],
        originalTokensEstimated: tokens,
        prunedTokensEstimated: tokens,
        tokensSaved: 0,
        omittedToolNames: []
      };
    }

    const originalTokens = this.calculateToolsTokens(tools);
    const queryTerms = extractMeaningfulTerms(userQuery);

    const coreTools: ToolDefinition[] = [];
    const matchedTools: ToolDefinition[] = [];
    const otherTools: ToolDefinition[] = [];

    for (const tool of tools) {
      if (this.coreToolVerbs.has(tool.name)) {
        coreTools.push(tool);
      } else if (this.isToolRelevant(tool, queryTerms)) {
        matchedTools.push(tool);
      } else {
        otherTools.push(tool);
      }
    }

    // Expand DAG dependencies for matched tools
    const neededToolNames = new Set<string>();
    for (const tool of matchedTools) {
      neededToolNames.add(tool.name);
      const deps = this.dependencies.get(tool.name);
      if (deps) {
        for (const dep of deps) {
          neededToolNames.add(dep);
        }
      }
    }

    // Pull in tools that were identified as dependencies
    for (const tool of otherTools) {
      if (neededToolNames.has(tool.name) && !matchedTools.some((t) => t.name === tool.name)) {
        matchedTools.push(tool);
      }
    }

    // Assemble pruned set: core tools + matched tools (including DAG dependencies)
    const selectedTools: ToolDefinition[] = [...coreTools, ...matchedTools];

    // If NO tools were matched at all, provide up to maxActiveTools fallback tools
    if (selectedTools.length === 0 && otherTools.length > 0) {
      selectedTools.push(...otherTools.slice(0, this.maxActiveTools));
    }

    // Invert to find omitted tools
    const selectedNames = new Set(selectedTools.map((t) => t.name));
    const omittedToolNames = tools
      .map((t) => t.name)
      .filter((name) => !selectedNames.has(name));

    // Inject the lightweight meta-tool for on-demand tool activation if tools were omitted
    if (omittedToolNames.length > 0) {
      selectedTools.push(this.createMetaTool(omittedToolNames));
    }

    const prunedTokens = this.calculateToolsTokens(selectedTools);
    const tokensSaved = Math.max(0, originalTokens - prunedTokens);

    return {
      originalTools: tools,
      prunedTools: selectedTools,
      originalTokensEstimated: originalTokens,
      prunedTokensEstimated: prunedTokens,
      tokensSaved,
      omittedToolNames
    };
  }

  private calculateToolsTokens(tools: ToolDefinition[]): number {
    if (!tools || tools.length === 0) return 0;
    return estimateTokens(JSON.stringify(tools));
  }

  private isToolRelevant(tool: ToolDefinition, queryTerms: string[]): boolean {
    if (queryTerms.length === 0) return false;
    const nameLower = tool.name.toLowerCase();
    const descLower = (tool.description || '').toLowerCase();
    return queryTerms.some((term) => nameLower.includes(term) || descLower.includes(term));
  }

  private createMetaTool(omittedToolNames: string[]): ToolDefinition {
    return {
      name: 'proxymcp_request_capability',
      description: `Request additional tool capabilities on demand. Available omitted tools: ${omittedToolNames.slice(0, 15).join(', ')}${omittedToolNames.length > 15 ? '...' : ''}`,
      input_schema: {
        type: 'object',
        properties: {
          requested_tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of tool names you want to load into context'
          },
          intent: {
            type: 'string',
            description: 'Brief reason or action you intend to perform'
          }
        },
        required: ['requested_tools']
      }
    };
  }
}

export const toolPruner = new ToolPruner();


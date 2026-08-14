/**
 * Subagent type registry.
 *
 * A "subagent" is a fresh, isolated agent loop that the main (leader) agent can
 * delegate a focused sub-task to. Each type below is a small config bundle: a
 * worker system prompt, a tool allow-list, and an iteration budget. The leader
 * picks a type via the `spawn_subagent` tool; the subagent runs to completion
 * and returns a single answer.
 */

/** Configuration for one subagent type. */
export interface SubagentTypeConfig {
  /** Help text shown to the leader so it knows when to pick this type. */
  whenToUse: string;
  /** Self-contained worker system prompt for the subagent. */
  systemPrompt: string;
  /** Allow-list of tool names (must match registry names) the subagent may use. */
  tools: string[];
  /** Maximum agent loop iterations for the subagent. */
  maxIterations: number;
}

/**
 * Tools a subagent may never receive. The delegate tool is listed here so a
 * subagent can never spawn its own subagents — delegation is one level deep.
 */
export const SUBAGENT_DISALLOWED_TOOLS = new Set<string>(['spawn_subagent']);

/**
 * Read-only tools available to a general-purpose subagent. Deliberately excludes
 * write/edit/memory-mutation tools: subagents run in parallel and must not race
 * on approval prompts or side effects.
 */
const READ_ONLY_TOOLS = [
  'get_financials',
  'get_market_data',
  'read_filings',
  'stock_screener',
  'web_search',
  'x_search',
  'web_fetch',
  'read_file',
  'memory_search',
  'memory_get',
];

/**
 * Authoritative financial-data tools the verifier may use to independently
 * re-fetch a figure. Deliberately excludes web/x search and memory — a claim is
 * verified against the source-of-truth vendors, never against the web or a prior
 * remembered value. get_options_chain and run_quality_screen are conditionally
 * registered (absent when their key / local project is missing); stock_screener is
 * always registered but returns an unsupported result on the SEC backend. Either
 * way the allow-list is intersected with the live registry, so any name that isn't
 * registered is simply absent from the verifier's tools.
 */
const VERIFIER_TOOLS = [
  'get_financials',
  'get_market_data',
  'read_filings',
  'stock_screener',
  'get_options_chain',
  'run_quality_screen',
];

const WORKER_PREAMBLE =
  'You are a subagent working on a single sub-task assigned by an orchestrator. ' +
  'You run in isolation: you cannot see the main conversation and you cannot ' +
  'delegate to other subagents. Complete only the assigned task. Your final ' +
  'message is returned verbatim to the orchestrator, so make it a complete, ' +
  'self-contained answer — state your findings and conclusions directly, not a ' +
  'description of what you did.';

export const SUBAGENT_TYPES: Record<string, SubagentTypeConfig> = {
  'general-purpose': {
    whenToUse: 'Multi-step research or analysis on one focused sub-task.',
    systemPrompt: `${WORKER_PREAMBLE}\n\nYou are a general-purpose research worker. Use the available tools to gather and analyze whatever the task requires, then report your findings.`,
    tools: READ_ONLY_TOOLS,
    maxIterations: 8,
  },
  research: {
    whenToUse: 'Gather and synthesize external information on a single topic.',
    systemPrompt: `${WORKER_PREAMBLE}\n\nYou are a research worker. Gather information from the web, news, and filings, cross-check sources, and synthesize a clear, sourced summary of what you found.`,
    tools: ['web_search', 'x_search', 'web_fetch', 'read_filings', 'get_market_data'],
    maxIterations: 8,
  },
  analysis: {
    whenToUse: 'Quantitative financial analysis on specific companies.',
    systemPrompt: `${WORKER_PREAMBLE}\n\nYou are a financial analysis worker. Pull the relevant financials, metrics, and market data, then deliver a focused quantitative analysis with the numbers that support it.`,
    tools: ['get_financials', 'get_market_data', 'stock_screener', 'read_filings'],
    maxIterations: 8,
  },
  'financial-data-verifier': {
    whenToUse:
      'Cross-check a specific financial figure (a ratio, price, margin, growth rate, market cap, debt level, IV, etc.) against authoritative tool data BEFORE you state it. Give it the ticker, the metric, and the value you are about to surface.',
    systemPrompt:
      `${WORKER_PREAMBLE}\n\n` +
      'You are a financial-data VERIFIER. Your one job is to independently confirm or refute a ' +
      'specific financial figure before it is stated to a user. You are given a ticker, the metric ' +
      'in question, and the value about to be surfaced.\n\n' +
      'Method: fetch the figure YOURSELF from the authoritative tools — get_financials for ' +
      'statement lines and ratios, get_market_data for prices / insider / institutional data, ' +
      'read_filings for a number stated in an SEC filing, get_options_chain for IV/greeks, ' +
      'run_quality_screen for screen-gate metrics. Compare the tool-sourced value against the ' +
      'claimed one. NEVER accept the claimed number on faith, and NEVER invent or estimate a value ' +
      'from your own knowledge — if the tools do not return the figure, it is UNAVAILABLE.\n\n' +
      'Return exactly one verdict:\n' +
      '- VERIFIED — the tool value matches the claim (allow small rounding or reporting-period ' +
      'differences, but note them).\n' +
      '- MISMATCH — they differ; state BOTH the claimed value and the correct tool-sourced value.\n' +
      '- UNAVAILABLE — no tool returns this figure; say so plainly and do not guess.\n\n' +
      'Always cite the exact tool and the number it returned (with its period/date). Be terse and decisive.',
    tools: VERIFIER_TOOLS,
    maxIterations: 6,
  },
};

export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/** The subagent types the leader may choose from. */
export const SUBAGENT_TYPE_NAMES = Object.keys(SUBAGENT_TYPES) as [string, ...string[]];

/** Resolve a type's tool allow-list with disallowed tools stripped defensively. */
export function resolveSubagentTools(typeKey: string): string[] {
  const cfg = SUBAGENT_TYPES[typeKey] ?? SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  return cfg.tools.filter(t => !SUBAGENT_DISALLOWED_TOOLS.has(t));
}

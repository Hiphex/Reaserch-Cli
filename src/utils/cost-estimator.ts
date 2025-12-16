/**
 * Cost Estimator - Estimates API costs before running research
 * Uses dynamic pricing from OpenRouter API
 * Includes costs for: planning, sub-agents, summarizer, synthesis, and Exa searches
 */

import type { Model } from '../clients/openrouter.js';
import { DEFAULTS } from '../config.js';

/**
 * Summarizer model ID (from summarizer.ts)
 */
export const SUMMARIZER_MODEL_ID = 'google/gemini-2.0-flash-001';

/**
 * Exa API pricing (as of Dec 2025)
 * - Search: $5 per 1,000 searches (auto/neural, 1-25 results)
 * - Contents (text): $1 per 1,000 pages
 * - Contents (highlights): $1 per 1,000 pages
 * - Contents (summary): $1 per 1,000 pages
 */
export const EXA_PRICING = {
    searchPer1k: 5.0,         // $5 per 1,000 searches
    contentTextPer1k: 1.0,    // $1 per 1,000 pages for text
    contentHighlightsPer1k: 1.0,
    contentSummaryPer1k: 1.0,
} as const;

/**
 * Estimated token usage for different phases
 */
export const TOKEN_ESTIMATES = {
    planning: {
        input: 500,       // System prompt + user query
        output: 800,      // Research plan JSON
    },
    subAgent: {
        input: 2000,      // Context + sources
        output: 1500,     // Analysis
    },
    summarizer: {
        input: 1200,      // Text chunk to summarize
        output: 30,       // Very short summary (~5-10 words)
    },
    synthesis: {
        input: 8000,      // All findings combined
        output: 4000,     // Final report
    },
} as const;

export interface CostBreakdown {
    planning: number;
    subAgents: number;
    summarizer: number;
    synthesis: number;
    exaSearches: number;
    exaContents: number;
    total: number;
    details: {
        numSearches: number;
        numResults: number;
        numSubAgents: number;
        numSummaries: number;
        mainModel: string;
        summarizerModel: string;
    };
}

/**
 * Calculate cost for a model based on token usage
 * Uses OpenRouter's per-token pricing from the model object
 */
function calculateModelCost(
    model: Model | undefined,
    inputTokens: number,
    outputTokens: number
): number {
    if (!model) return 0;

    // OpenRouter pricing is per-token
    const inputCost = inputTokens * model.pricing.prompt;
    const outputCost = outputTokens * model.pricing.completion;

    return inputCost + outputCost;
}

/**
 * Calculate Exa search costs
 */
function calculateExaCost(
    numSearches: number,
    numResultsPerSearch: number = DEFAULTS.exaNumResults
): { searchCost: number; contentsCost: number } {
    // Search cost: $5 per 1,000 searches
    const searchCost = (numSearches / 1000) * EXA_PRICING.searchPer1k;

    // Contents cost: we request text, highlights, and summary for each result
    const totalPages = numSearches * numResultsPerSearch;
    const contentsCost =
        (totalPages / 1000) * EXA_PRICING.contentTextPer1k +
        (totalPages / 1000) * EXA_PRICING.contentHighlightsPer1k +
        (totalPages / 1000) * EXA_PRICING.contentSummaryPer1k;

    return { searchCost, contentsCost };
}

export interface EstimateOptions {
    numSteps?: number;           // Number of research steps (default: 4)
    numFollowUps?: number;       // Expected follow-up searches (default: 2)
    numSubAgents?: number;       // Number of sub-agents (default: 0 for basic research)
    resultsPerSearch?: number;   // Results per search (default: 8)
}

/**
 * Estimate total research cost before execution
 * Uses actual model pricing from OpenRouter API
 */
export function estimateCost(
    mainModel: Model | undefined,
    summarizerModel: Model | undefined,
    options: EstimateOptions = {}
): CostBreakdown {
    const numSteps = options.numSteps ?? 4;
    const numFollowUps = options.numFollowUps ?? 2;
    const numSubAgents = options.numSubAgents ?? 0;
    const resultsPerSearch = options.resultsPerSearch ?? DEFAULTS.exaNumResults;

    const totalSearches = numSteps + numFollowUps;

    // Planning phase cost (main model)
    const planningCost = calculateModelCost(
        mainModel,
        TOKEN_ESTIMATES.planning.input,
        TOKEN_ESTIMATES.planning.output
    );

    // Sub-agents cost (main model, if using agent mode)
    const subAgentsCost = numSubAgents * calculateModelCost(
        mainModel,
        TOKEN_ESTIMATES.subAgent.input,
        TOKEN_ESTIMATES.subAgent.output
    );

    // Summarizer cost (Gemini 2.0 Flash, ~5 summaries max per phase)
    // Max 5 summaries per summarizer config, used for reasoning display
    const numSummaries = Math.min(5, totalSearches);
    const summarizerCost = calculateModelCost(
        summarizerModel,
        numSummaries * TOKEN_ESTIMATES.summarizer.input,
        numSummaries * TOKEN_ESTIMATES.summarizer.output
    );

    // Synthesis phase cost (main model)
    const synthesisCost = calculateModelCost(
        mainModel,
        TOKEN_ESTIMATES.synthesis.input,
        TOKEN_ESTIMATES.synthesis.output
    );

    // Exa costs
    const { searchCost, contentsCost } = calculateExaCost(totalSearches, resultsPerSearch);

    const total =
        planningCost +
        subAgentsCost +
        summarizerCost +
        synthesisCost +
        searchCost +
        contentsCost;

    return {
        planning: planningCost,
        subAgents: subAgentsCost,
        summarizer: summarizerCost,
        synthesis: synthesisCost,
        exaSearches: searchCost,
        exaContents: contentsCost,
        total,
        details: {
            numSearches: totalSearches,
            numResults: totalSearches * resultsPerSearch,
            numSubAgents,
            numSummaries,
            mainModel: mainModel?.id ?? 'unknown',
            summarizerModel: summarizerModel?.id ?? SUMMARIZER_MODEL_ID,
        },
    };
}

/**
 * Format cost breakdown for display
 */
export function formatCostBreakdown(cost: CostBreakdown): string {
    const fmt = (n: number) => `$${n.toFixed(4)}`;
    const lines: string[] = [];

    lines.push('Estimated cost breakdown:');
    lines.push(`├─ Planning (${cost.details.mainModel}): ${fmt(cost.planning)}`);

    if (cost.subAgents > 0) {
        lines.push(`├─ Sub-agents (×${cost.details.numSubAgents}): ${fmt(cost.subAgents)}`);
    }

    lines.push(`├─ Summarizer (${cost.details.summarizerModel}): ${fmt(cost.summarizer)}`);
    lines.push(`├─ Synthesis: ${fmt(cost.synthesis)}`);
    lines.push(`├─ Exa searches (×${cost.details.numSearches}): ${fmt(cost.exaSearches)}`);
    lines.push(`├─ Exa contents (${cost.details.numResults} pages): ${fmt(cost.exaContents)}`);
    lines.push(`└─ Total: ${fmt(cost.total)}`);

    return lines.join('\n');
}

/**
 * Get a simple one-line cost estimate
 */
export function formatCostSimple(cost: CostBreakdown): string {
    return `~$${cost.total.toFixed(3)} (${cost.details.numSearches} searches)`;
}


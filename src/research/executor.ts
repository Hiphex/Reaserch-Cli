/**
 * Research Executor - Executes search steps in parallel batches
 */

import { ExaClient, type ExaSearchResponse } from '../clients/exa.js';
import type { ResearchStep, ResearchPlan } from './planner.js';
import { envPositiveInt } from '../utils/env.js';

export interface StepResult {
    step: ResearchStep;
    response: ExaSearchResponse;
    sourceSummaries: string[];
}

export type ProgressCallback = (step: ResearchStep, index: number) => void;

export class ResearchExecutor {
    private exaClient: ExaClient;
    private numResults: number;
    private followUpNumResults: number;

    constructor(
        exaClient: ExaClient,
        options: { numResults?: number; followUpNumResults?: number } = {}
    ) {
        this.exaClient = exaClient;
        this.numResults = options.numResults ?? envPositiveInt(process.env.EXA_NUM_RESULTS, 8);
        this.followUpNumResults = options.followUpNumResults ?? envPositiveInt(process.env.EXA_FOLLOWUP_NUM_RESULTS, 5);
    }

    /**
     * Execute all research steps in parallel
     */
    async executeAll(
        plan: ResearchPlan,
        onProgress?: ProgressCallback
    ): Promise<StepResult[]> {
        const results: StepResult[] = [];

        // Execute all searches in parallel using Promise.all
        const searchPromises = plan.steps.map(async (step, index) => {
            // Update status to in progress
            step.status = 'inProgress';
            onProgress?.(step, index);

            try {
                const response = await this.exaClient.search(step.searchQuery, {
                    type: 'deep',
                    numResults: this.numResults,
                    contents: {
                        text: true,
                        highlights: {
                            numSentences: 3,
                            highlightsPerUrl: 3,
                            query: step.question,
                        },
                        summary: {
                            query: step.question,
                        },
                    },
                });

                // Extract summaries from results
                const sourceSummaries = response.results
                    .filter((r) => r.summary || r.highlights?.length)
                    .map((r) => {
                        const summary = r.summary || r.highlights?.join(' ') || '';
                        return `[${r.title}](${r.url}): ${summary}`;
                    });

                step.status = 'complete';
                step.results = response;
                onProgress?.(step, index);

                return {
                    step,
                    response,
                    sourceSummaries,
                };
            } catch (error) {
                step.status = 'error';
                onProgress?.(step, index);
                throw error;
            }
        });

        // Wait for all searches to complete
        const searchResults = await Promise.all(searchPromises);
        results.push(...searchResults);

        return results;
    }

    /**
     * Execute a single follow-up search
     */
    async executeFollowUp(query: string): Promise<ExaSearchResponse> {
        return this.exaClient.search(query, {
            type: 'deep',
            numResults: this.followUpNumResults,
            contents: {
                text: true,
                highlights: {
                    numSentences: 3,
                    highlightsPerUrl: 2,
                },
                summary: {
                    query,
                },
            },
        });
    }
}

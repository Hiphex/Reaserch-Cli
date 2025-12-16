/**
 * Research Synthesizer - Combines search results into a final report
 */

import { OpenRouterClient, type Message } from '../clients/openrouter.js';
import type { ChatOptions } from '../clients/openrouter.js';
import { SYNTHESIS_PROMPT } from './prompts.js';
import type { StepResult } from './executor.js';

export class ResearchSynthesizer {
    private client: OpenRouterClient;
    private model: string;
    private options: ChatOptions;

    constructor(client: OpenRouterClient, model: string, options: ChatOptions = {}) {
        this.client = client;
        this.model = model;
        this.options = options;
    }

    /**
     * Synthesize all research results into a final report (streaming)
     */
    async *synthesize(
        mainQuestion: string,
        results: StepResult[]
    ): AsyncGenerator<string, void, unknown> {
        // Build context from all results
        const context = this.buildContext(results);

        const messages: Message[] = [
            { role: 'system', content: SYNTHESIS_PROMPT },
            {
                role: 'user',
                content: `Research Question: "${mainQuestion}"

${context}

Please synthesize these findings into a comprehensive research report.`,
            },
        ];

        // Stream the response
        yield* this.client.chatStream(this.model, messages, {
            temperature: this.options.temperature,
            maxTokens: this.options.maxTokens,
            topP: this.options.topP,
            topK: this.options.topK,
            frequencyPenalty: this.options.frequencyPenalty,
            presencePenalty: this.options.presencePenalty,
            seed: this.options.seed,
            reasoning: this.options.reasoning,
            includeReasoning: this.options.includeReasoning,
        });
    }

    /**
     * Build context string from research results
     */
    private buildContext(results: StepResult[]): string {
        const sections: string[] = [];

        results.forEach((result, index) => {
            const sourceNum = index + 1;
            const step = result.step;

            sections.push(`## Research Step ${sourceNum}: ${step.question}`);
            sections.push(`Purpose: ${step.purpose}\n`);

            if (result.response.results.length === 0) {
                sections.push('No results found for this query.\n');
                return;
            }

            sections.push('### Sources Found:\n');

            result.response.results.forEach((source, srcIndex) => {
                sections.push(`**[Source ${sourceNum}.${srcIndex + 1}] ${source.title}**`);
                sections.push(`URL: ${source.url}`);

                if (source.publishedDate) {
                    sections.push(`Published: ${source.publishedDate}`);
                }

                if (source.summary) {
                    sections.push(`Summary: ${source.summary}`);
                } else if (source.highlights?.length) {
                    sections.push(`Key excerpts:`);
                    source.highlights.forEach((h) => sections.push(`- ${h}`));
                }

                sections.push('');
            });

            sections.push('---\n');
        });

        return sections.join('\n');
    }

    /**
     * Synthesize with reasoning display (streams both content and reasoning)
     */
    async *synthesizeWithReasoning(
        mainQuestion: string,
        results: StepResult[]
    ): AsyncGenerator<{ type: 'content' | 'reasoning'; text: string }, void, unknown> {
        const context = this.buildContext(results);

        const messages: Message[] = [
            { role: 'system', content: SYNTHESIS_PROMPT },
            {
                role: 'user',
                content: `Research Question: "${mainQuestion}"

${context}

Please synthesize these findings into a comprehensive research report.`,
            },
        ];

        yield* this.client.chatStreamWithReasoning(this.model, messages, {
            temperature: this.options.temperature,
            maxTokens: this.options.maxTokens,
            topP: this.options.topP,
            topK: this.options.topK,
            frequencyPenalty: this.options.frequencyPenalty,
            presencePenalty: this.options.presencePenalty,
            seed: this.options.seed,
            reasoning: this.options.reasoning,
            includeReasoning: true,
        });
    }

    /**
     * Non-streaming synthesis for simpler use cases
     */
    async synthesizeSync(
        mainQuestion: string,
        results: StepResult[]
    ): Promise<string> {
        let report = '';
        for await (const chunk of this.synthesize(mainQuestion, results)) {
            report += chunk;
        }
        return report;
    }
}


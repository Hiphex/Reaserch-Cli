/**
 * Research Planner - Generates research plans from user queries
 */

import { OpenRouterClient, type Message } from '../clients/openrouter.js';
import type { ChatOptions } from '../clients/openrouter.js';
import { getPlanningPrompt } from './prompts.js';

export interface ResearchStep {
    id: number;
    question: string;
    searchQuery: string;
    purpose: string;
    status: 'pending' | 'inProgress' | 'complete' | 'error';
    results?: any;
}

export interface ResearchPlan {
    mainQuestion: string;
    steps: ResearchStep[];
    expectedInsights: string[];
}

export class ResearchPlanner {
    private client: OpenRouterClient;
    private model: string;
    private options: ChatOptions;

    constructor(client: OpenRouterClient, model: string, options: ChatOptions = {}) {
        this.client = client;
        this.model = model;
        this.options = options;
    }

    /**
     * Generate a research plan from a user query
     */
    async createPlan(query: string): Promise<ResearchPlan> {
        const messages: Message[] = [
            { role: 'system', content: getPlanningPrompt() },
            { role: 'user', content: `Research query: "${query}"` },
        ];

        const response = await this.client.chat(this.model, messages, {
            temperature: this.options.temperature,
            // Let model use its full context - no artificial limit
            topP: this.options.topP,
            topK: this.options.topK,
            frequencyPenalty: this.options.frequencyPenalty,
            presencePenalty: this.options.presencePenalty,
            seed: this.options.seed,
            reasoning: this.options.reasoning,
            includeReasoning: this.options.includeReasoning,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error('No response from planning model');
        }

        return this.parsePlanResponse(content);
    }

    /**
     * Generate a research plan with streaming reasoning for live display
     */
    async createPlanWithReasoning(
        query: string,
        onReasoning: (text: string) => void
    ): Promise<ResearchPlan> {
        const messages: Message[] = [
            { role: 'system', content: getPlanningPrompt() },
            { role: 'user', content: `Research query: "${query}"` },
        ];

        let content = '';

        for await (const event of this.client.chatStreamWithReasoning(this.model, messages, {
            temperature: this.options.temperature,
            // Let model use its full context - no artificial limit
            topP: this.options.topP,
            topK: this.options.topK,
            frequencyPenalty: this.options.frequencyPenalty,
            presencePenalty: this.options.presencePenalty,
            seed: this.options.seed,
            reasoning: this.options.reasoning,
            includeReasoning: true,
        })) {
            if (event.type === 'reasoning') {
                onReasoning(event.text);
            } else if (event.type === 'content') {
                content += event.text;
            }
        }

        if (!content) {
            throw new Error('No response from planning model');
        }

        return this.parsePlanResponse(content);
    }

    /**
     * Parse the plan response JSON with improved error handling
     */
    private parsePlanResponse(content: string): ResearchPlan {
        // Clean up the content - remove markdown code blocks if present
        let cleanContent = content.trim();
        if (cleanContent.startsWith('```json')) {
            cleanContent = cleanContent.slice(7);
        } else if (cleanContent.startsWith('```')) {
            cleanContent = cleanContent.slice(3);
        }
        if (cleanContent.endsWith('```')) {
            cleanContent = cleanContent.slice(0, -3);
        }
        cleanContent = cleanContent.trim();

        // Try multiple parsing strategies
        const parseStrategies = [
            // 1. Direct parse
            () => JSON.parse(cleanContent),
            // 2. Find JSON object in content
            () => {
                const match = cleanContent.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('No JSON object found');
                return JSON.parse(match[0]);
            },
            // 3. Fix common issues: trailing commas, missing quotes
            () => {
                const fixed = cleanContent
                    .replace(/,\s*([}\]])/g, '$1')  // Remove trailing commas
                    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');  // Quote unquoted keys
                const match = fixed.match(/\{[\s\S]*\}/);
                if (!match) throw new Error('No JSON object found after fixes');
                return JSON.parse(match[0]);
            },
        ];

        let lastError: Error | null = null;
        for (const strategy of parseStrategies) {
            try {
                const parsed = strategy();

                if (!parsed.steps || !Array.isArray(parsed.steps)) {
                    continue;
                }

                const steps: ResearchStep[] = parsed.steps.map((step: any, index: number) => ({
                    id: step.id ?? index + 1,
                    question: step.question || `Step ${index + 1}`,
                    searchQuery: step.searchQuery || step.question || '',
                    purpose: step.purpose || '',
                    status: 'pending' as const,
                }));

                return {
                    mainQuestion: parsed.mainQuestion || 'Research query',
                    steps,
                    expectedInsights: parsed.expectedInsights || [],
                };
            } catch (e) {
                lastError = e as Error;
            }
        }

        throw new Error(`Failed to parse research plan: ${lastError?.message}\n\nRaw content:\n${cleanContent.slice(0, 500)}`);
    }
}


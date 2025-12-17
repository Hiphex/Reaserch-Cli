import { z } from 'zod';
import { OpenRouterClient, type Message, type ChatOptions } from '../clients/openrouter.js';
import { getPlanningPrompt } from './prompts.js';

const ResearchStepSchema = z.object({
    id: z.number().int().positive().optional(),
    question: z.string().min(1),
    searchQuery: z.string().optional(),
    purpose: z.string().optional(),
    status: z.enum(['pending', 'inProgress', 'complete', 'error']).optional(),
    results: z.any().optional(),
});

const ResearchPlanSchema = z.object({
    mainQuestion: z.string(),
    steps: z.array(ResearchStepSchema),
    expectedInsights: z.array(z.string()).optional(),
});

export type ResearchStep = z.infer<typeof ResearchStepSchema> & {
    // Ensure these specific Runtime transformations are respected
    id: number;
    status: 'pending' | 'inProgress' | 'complete' | 'error';
};
export type ResearchPlan = Omit<z.infer<typeof ResearchPlanSchema>, 'steps'> & {
    steps: ResearchStep[];
};

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
     * Parse the plan response JSON with Zod validation
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

        // Try parsing JSON
        let rawJson: any;
        try {
            rawJson = JSON.parse(cleanContent);
        } catch {
            // Try fixes: trailing commas, missing quotes
            const fixed = cleanContent
                .replace(/,\s*([}\]])/g, '$1')  // Remove trailing commas
                .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');  // Quote unquoted keys
            try {
                rawJson = JSON.parse(fixed);
            } catch (e) {
                // Try finding JSON object in content as last resort
                const match = cleanContent.match(/\{[\s\S]*\}/);
                if (match) {
                    try { rawJson = JSON.parse(match[0]); } catch { }
                }
                if (!rawJson) {
                    throw new Error(`Failed to parse JSON for research plan: ${(e as Error).message}`);
                }
            }
        }

        const result = ResearchPlanSchema.safeParse(rawJson);

        if (!result.success) {
            // Provide a better error message
            const errorMsg = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
            throw new Error(`Invalid research plan structure: ${errorMsg}`);
        }

        const parsed = result.data;

        // Post-process to ensure runtime guarantees (filling in defaults)
        const steps: ResearchStep[] = parsed.steps.map((step, index) => ({
            ...step,
            id: step.id ?? index + 1,
            question: step.question,
            searchQuery: step.searchQuery || step.question,
            purpose: step.purpose || '',
            status: 'pending',
            // results undefined by default
        }));

        return {
            mainQuestion: parsed.mainQuestion,
            steps,
            expectedInsights: parsed.expectedInsights || [],
        };
    }
}


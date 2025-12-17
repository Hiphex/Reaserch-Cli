/**
 * Reasoning Summarizer - Uses a fast model to summarize reasoning tokens
 * No hardcoded limits by default - user can configure limits if needed
 */

import { OpenRouterClient, type Message } from './openrouter.js';

// Fast, cheap model for summarization
export const SUMMARIZER_MODEL = 'google/gemini-2.0-flash-001';

const SUMMARIZE_PROMPT = `You are a concise summarizer. Given a snippet of an AI's internal reasoning/thinking, summarize what it's doing RIGHT NOW in 5-10 words maximum. Be specific.

Examples:
- "Analyzing current AI model benchmarks..."
- "Comparing GPT-4 vs Claude capabilities..."
- "Examining scaling law limitations..."
- "Synthesizing findings on safety research..."

Rules:
- Present tense
- One line only (no newlines)
- No quotes, no bullets
- No extra commentary`;

export interface SummarizerOptions {
    /** Number of characters to buffer before summarizing (default: 800) */
    bufferThreshold?: number;
    /** Max summaries per phase, undefined = unlimited (default: unlimited) */
    maxSummaries?: number;
    /** Minimum seconds between summaries, undefined = no limit (default: no limit) */
    minGapSeconds?: number;
    /** Max tokens for summary output, undefined = model default (default: model default) */
    maxTokens?: number;
}

export class ReasoningSummarizer {
    private client: OpenRouterClient;
    private buffer: string = '';
    private lastSummary: string = '';
    private bufferThreshold: number;
    private summaryCache: Set<string> = new Set();

    // Throttling (all optional)
    private lastSummaryTime: number = 0;
    private summaryCount: number = 0;
    private maxSummaries?: number;
    private minGapMs?: number;
    private maxTokens?: number;

    constructor(client: OpenRouterClient, options: SummarizerOptions = {}) {
        this.client = client;
        this.bufferThreshold = options.bufferThreshold ?? 800;
        // No limits by default - user must explicitly set them
        this.maxSummaries = options.maxSummaries;
        this.minGapMs = options.minGapSeconds !== undefined ? options.minGapSeconds * 1000 : undefined;
        this.maxTokens = options.maxTokens;
    }

    /**
     * Add reasoning text to buffer
     * Returns a summary if buffer threshold is reached AND throttle allows
     */
    async addReasoning(text: string): Promise<string | null> {
        this.buffer += text;

        // Check if we've hit max summaries (only if limit is set)
        if (this.maxSummaries !== undefined && this.summaryCount >= this.maxSummaries) {
            return null;
        }

        // Check buffer threshold
        if (this.buffer.length < this.bufferThreshold) {
            return null;
        }

        // Check time-based throttle (only if limit is set)
        if (this.minGapMs !== undefined) {
            const now = Date.now();
            if (now - this.lastSummaryTime < this.minGapMs) {
                return null;
            }
        }

        const summary = await this.summarizeBuffer();
        this.buffer = this.buffer.slice(-200); // Keep some context

        if (summary) {
            this.lastSummaryTime = Date.now();
            this.summaryCount++;
        }

        return summary;
    }

    /**
     * Summarize the current buffer using Gemini Flash
     */
    private async summarizeBuffer(): Promise<string | null> {
        if (this.buffer.length < 100) return null;

        try {
            const messages: Message[] = [
                { role: 'system', content: SUMMARIZE_PROMPT },
                { role: 'user', content: this.buffer.slice(-1200) },
            ];

            const chatOptions: { temperature: number; stop: string[]; maxTokens?: number } = {
                temperature: 0.3,
                stop: ['\n'],
            };

            // Only set maxTokens if user specified it
            if (this.maxTokens !== undefined) {
                chatOptions.maxTokens = this.maxTokens;
            }

            const response = await this.client.chat(SUMMARIZER_MODEL, messages, chatOptions);

            const summary = response.choices[0]?.message?.content?.trim();

            if (summary && summary.length > 5 && summary !== this.lastSummary) {
                // Avoid duplicates
                const key = summary.slice(0, 20).toLowerCase();
                if (this.summaryCache.has(key)) {
                    return null;
                }
                this.summaryCache.add(key);
                this.lastSummary = summary;
                return summary;
            }

            return null;
        } catch (error) {
            // Log errors to help debug (they're not critical but useful to see)
            if (process.env.DEBUG) {
                console.error('[Summarizer Error]', error instanceof Error ? error.message : error);
            }
            return null;
        }
    }

    /**
     * Flush any remaining buffer
     */
    async flush(): Promise<string | null> {
        // Check max summaries limit if set
        if (this.maxSummaries !== undefined && this.summaryCount >= this.maxSummaries) {
            this.buffer = '';
            return null;
        }

        if (this.buffer.length > 200) {
            const summary = await this.summarizeBuffer();
            this.buffer = '';
            if (summary) {
                this.summaryCount++;
            }
            return summary;
        }
        this.buffer = '';
        return null;
    }

    /**
     * Reset the summarizer state for a new phase
     */
    reset(): void {
        this.buffer = '';
        this.lastSummary = '';
        this.summaryCache.clear();
        this.summaryCount = 0;
        this.lastSummaryTime = 0;
    }
}

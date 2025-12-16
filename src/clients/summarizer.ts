/**
 * Reasoning Summarizer - Uses a fast model to summarize reasoning tokens
 * Throttled to prevent spam: max 5 summaries, minimum 5 seconds between each
 */

import { OpenRouterClient, type Message } from './openrouter.js';

// Fast, cheap model for summarization
const SUMMARIZER_MODEL = 'google/gemini-2.0-flash-001';

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

export class ReasoningSummarizer {
    private client: OpenRouterClient;
    private buffer: string = '';
    private lastSummary: string = '';
    private bufferThreshold: number;
    private summaryCache: Set<string> = new Set();

    // Throttling
    private lastSummaryTime: number = 0;
    private summaryCount: number = 0;
    private maxSummaries: number;
    private minGapMs: number;

    constructor(client: OpenRouterClient, options: {
        bufferThreshold?: number;
        maxSummaries?: number;
        minGapSeconds?: number;
    } = {}) {
        this.client = client;
        this.bufferThreshold = options.bufferThreshold ?? 800;  // Larger buffer
        this.maxSummaries = options.maxSummaries ?? 5;          // Max 5 summaries per phase
        this.minGapMs = (options.minGapSeconds ?? 5) * 1000;    // Min 5 seconds between
    }

    /**
     * Add reasoning text to buffer
     * Returns a summary if buffer threshold is reached AND throttle allows
     */
    async addReasoning(text: string): Promise<string | null> {
        this.buffer += text;

        // Check if we've hit max summaries
        if (this.summaryCount >= this.maxSummaries) {
            return null;
        }

        // Check buffer threshold
        if (this.buffer.length < this.bufferThreshold) {
            return null;
        }

        // Check time-based throttle
        const now = Date.now();
        if (now - this.lastSummaryTime < this.minGapMs) {
            return null;
        }

        const summary = await this.summarizeBuffer();
        this.buffer = this.buffer.slice(-200); // Keep more context

        if (summary) {
            this.lastSummaryTime = now;
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

            const response = await this.client.chat(SUMMARIZER_MODEL, messages, {
                maxTokens: 30,
                temperature: 0.3,
                stop: ['\n'],
            });

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
     * Flush any remaining buffer (only if under max and gap allows)
     */
    async flush(): Promise<string | null> {
        if (this.summaryCount >= this.maxSummaries) {
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

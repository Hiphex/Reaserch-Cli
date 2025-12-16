/**
 * Live Thinking Display - Shows model reasoning in real-time with summaries
 */

import { colors, icons } from './theme.js';
import type { OpenRouterClient } from '../clients/openrouter.js';

export interface ThinkingDisplayOptions {
    showFullReasoning?: boolean;
    updateInterval?: number;  // ms between summary updates
    maxReasoningChars?: number;
}

/**
 * Create a live thinking display that shows progress
 */
export class ThinkingDisplay {
    private currentPhase: string = '';
    private thinkingBuffer: string = '';
    private lastSummary: string = '';
    private updateTimer: NodeJS.Timeout | null = null;
    private client: OpenRouterClient | null = null;
    private options: ThinkingDisplayOptions;
    private lineCount: number = 0;

    constructor(client?: OpenRouterClient, options: ThinkingDisplayOptions = {}) {
        this.client = client || null;
        this.options = {
            showFullReasoning: false,
            updateInterval: 3000,
            maxReasoningChars: 500,
            ...options,
        };
    }

    /**
     * Start a new phase (e.g., "Planning", "Searching", "Synthesizing")
     */
    startPhase(phase: string): void {
        this.currentPhase = phase;
        this.thinkingBuffer = '';
        this.lineCount = 0;
        this.clearLine();
        process.stdout.write(`${colors.muted(icons.arrow)} ${colors.secondary(phase)}...`);
    }

    /**
     * Update with new reasoning tokens
     */
    addReasoning(text: string): void {
        this.thinkingBuffer += text;

        // Show a brief preview of what's being thought about
        if (this.thinkingBuffer.length > 50 && !this.updateTimer) {
            this.showThinkingPreview();
        }
    }

    /**
     * Show a brief preview of current thinking
     */
    private showThinkingPreview(): void {
        const preview = this.extractKeyPhrase(this.thinkingBuffer);
        if (preview && preview !== this.lastSummary) {
            this.lastSummary = preview;
            this.clearLine();
            process.stdout.write(`${colors.muted(icons.arrow)} ${colors.secondary(this.currentPhase)}: ${colors.muted(preview)}`);
        }
    }

    /**
     * Extract a key phrase from reasoning text (simple extraction without LLM)
     */
    private extractKeyPhrase(text: string): string {
        // Clean up the text
        const cleaned = text.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');

        // Look for action phrases
        const actionPatterns = [
            /(?:I (?:need to|should|will|am going to|'ll)) ([^.!?]+)/i,
            /(?:Let me|Let's) ([^.!?]+)/i,
            /(?:First|Now|Next),? ([^.!?]+)/i,
            /(?:Analyzing|Considering|Evaluating|Looking at|Examining) ([^.!?]+)/i,
            /(?:The key|The main|Important) ([^.!?]+)/i,
        ];

        for (const pattern of actionPatterns) {
            const match = cleaned.match(pattern);
            if (match && match[1]) {
                const phrase = match[1].trim();
                if (phrase.length > 10 && phrase.length < 80) {
                    return this.capitalize(phrase.slice(0, 60)) + (phrase.length > 60 ? '...' : '');
                }
            }
        }

        // Fallback: get the last meaningful sentence fragment
        const sentences = cleaned.split(/[.!?]+/).filter(s => s.trim().length > 15);
        if (sentences.length > 0) {
            const lastSentence = sentences[sentences.length - 1].trim();
            return lastSentence.slice(0, 60) + (lastSentence.length > 60 ? '...' : '');
        }

        return '';
    }

    /**
     * Capitalize first letter
     */
    private capitalize(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Complete the current phase
     */
    completePhase(message?: string): void {
        this.clearLine();
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        console.log(`${colors.success('✓')} ${message || this.currentPhase}`);
        this.thinkingBuffer = '';
        this.lastSummary = '';
    }

    /**
     * Update phase status without completing
     */
    updateStatus(status: string): void {
        this.clearLine();
        process.stdout.write(`${colors.muted(icons.arrow)} ${colors.secondary(this.currentPhase)}: ${colors.muted(status)}`);
    }

    /**
     * Show an intermediate thinking update
     */
    showThought(thought: string): void {
        this.clearLine();
        console.log(`  ${colors.muted('💭')} ${colors.muted(thought)}`);
        this.lineCount++;
    }

    /**
     * Clear the current line
     */
    private clearLine(): void {
        process.stdout.write('\r\x1b[K');
    }

    /**
     * Get the accumulated reasoning
     */
    getReasoning(): string {
        return this.thinkingBuffer;
    }
}

/**
 * Simple progress indicator that cycles through phases
 */
export function createThinkingIndicator(): {
    update: (text: string) => void;
    complete: (text?: string) => void;
    fail: (text?: string) => void;
} {
    let currentText = '';

    const clearLine = () => process.stdout.write('\r\x1b[K');

    return {
        update: (text: string) => {
            clearLine();
            currentText = text;
            process.stdout.write(`${colors.muted(icons.arrow)} ${text}`);
        },
        complete: (text?: string) => {
            clearLine();
            console.log(`${colors.success('✓')} ${text || currentText}`);
        },
        fail: (text?: string) => {
            clearLine();
            console.log(`${colors.error('✗')} ${text || currentText}`);
        },
    };
}

/**
 * Format a research flow step with consistent styling
 */
export function formatStep(phase: 'thinking' | 'planning' | 'searching' | 'analyzing' | 'writing', detail?: string): string {
    const phaseLabels: Record<string, string> = {
        thinking: '🧠 Thinking',
        planning: '📋 Planning',
        searching: '🔍 Searching',
        analyzing: '🔬 Analyzing',
        writing: '✍️  Writing',
    };

    const label = phaseLabels[phase] || phase;
    return detail ? `${label}: ${detail}` : label;
}

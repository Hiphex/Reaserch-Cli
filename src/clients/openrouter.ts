/**
 * OpenRouter API Client
 * Provides access to multiple LLM models through a unified interface
 */

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const DEFAULT_LIST_TIMEOUT_MS = 60_000;
const DEFAULT_CHAT_TIMEOUT_MS = 300_000;
const DEFAULT_STREAM_TIMEOUT_MS = 900_000;

function envTimeoutMs(value: string | undefined, fallback: number): number {
    const parsed = value ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();

    if (parentSignal) {
        if (parentSignal.aborted) {
            controller.abort();
        } else {
            parentSignal.addEventListener('abort', onAbort, { once: true });
        }
    }

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutId);
            if (parentSignal && !parentSignal.aborted) {
                parentSignal.removeEventListener('abort', onAbort);
            }
        },
    };
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function isAbortError(error: Error): boolean {
    return error.name === 'AbortError';
}

export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatOptions {
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
    stop?: string[];
    reasoning?: {
        effort?: 'low' | 'medium' | 'high';
    };
    includeReasoning?: boolean;
}

export interface Model {
    id: string;
    name: string;
    description?: string;
    contextLength: number;
    maxCompletionTokens?: number;
    supportedParameters?: string[];
    pricing: {
        prompt: number;
        completion: number;
    };
}

export interface ChatResponse {
    id: string;
    choices: {
        message: {
            role: string;
            content: string;
        };
        finishReason: string;
    }[];
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export class OpenRouterClient {
    private apiKey: string;

    constructor(apiKey: string) {
        if (!apiKey || apiKey.trim() === '') {
            throw new Error(
                'OPENROUTER_API_KEY is required.\n' +
                'Get your API key at: https://openrouter.ai\n' +
                'Then run: research init'
            );
        }
        this.apiKey = apiKey.trim();
    }

    /**
     * Fetch with retry logic and exponential backoff
     */
    private async fetchWithRetry(
        url: string,
        options: RequestInit,
        retries = MAX_RETRIES,
        timeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS
    ): Promise<Response> {
        let lastError: Error | null = null;
        let lastResponse: Response | null = null;

        for (let attempt = 0; attempt < retries; attempt++) {
            const resolvedTimeoutMs = envTimeoutMs(process.env.OPENROUTER_TIMEOUT_MS, timeoutMs);
            const { signal, cleanup } = createTimeoutSignal(resolvedTimeoutMs, options.signal ?? undefined);
            try {
                const response = await fetch(url, { ...options, signal });
                lastResponse = response;

                // Don't retry client errors (4xx except 429), only server errors (5xx) and rate limits
                if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
                    return response;
                }

                // Rate limit or server error - wait and retry
                const delay = response.status === 429
                    ? INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt + 1)  // Longer delay for rate limits
                    : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
                if (attempt < retries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                const err = toError(error);
                lastError = isAbortError(err)
                    ? new Error(`Request timed out after ${resolvedTimeoutMs}ms`)
                    : err;

                // Network error - wait and retry
                if (attempt < retries - 1) {
                    const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } finally {
                cleanup();
            }
        }

        if (lastResponse) return lastResponse;
        throw lastError || new Error('Max retries exceeded');
    }

    /**
     * Parse API error response for better error messages
     */
    private async parseError(response: Response): Promise<string> {
        try {
            const text = await response.text();
            try {
                const json = JSON.parse(text);
                return json.error?.message || json.message || json.error || text;
            } catch {
                return text;
            }
        } catch {
            return `HTTP ${response.status}`;
        }
    }

    /**
     * Fetch list of available models
     */
    async listModels(): Promise<Model[]> {
        const response = await this.fetchWithRetry(`${OPENROUTER_API_BASE}/models`, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
            },
        }, MAX_RETRIES, DEFAULT_LIST_TIMEOUT_MS);

        if (!response.ok) {
            const errorMessage = await this.parseError(response);

            if (response.status === 401) {
                throw new Error(
                    'OpenRouter API authentication failed.\n' +
                    'Please check your OPENROUTER_API_KEY is valid.\n' +
                    'Run: research init'
                );
            }

            throw new Error(`OpenRouter API error: ${response.status} - ${errorMessage}`);
        }

        const data = await response.json();
        return data.data.map((model: any) => ({
            id: model.id,
            name: model.name || model.id,
            description: model.description,
            contextLength: model.context_length ?? model.top_provider?.context_length ?? 0,
            maxCompletionTokens: model.top_provider?.max_completion_tokens ?? model.max_completion_tokens,
            supportedParameters: Array.isArray(model.supported_parameters) ? model.supported_parameters : undefined,
            pricing: {
                prompt: parseFloat(model.pricing?.prompt || '0'),
                completion: parseFloat(model.pricing?.completion || '0'),
            },
        }));
    }

    /**
     * Send a chat completion request (non-streaming)
     */
    async chat(
        model: string,
        messages: Message[],
        options: ChatOptions = {}
    ): Promise<ChatResponse> {
        const body: any = {
            model,
            messages,
            stream: false,
            top_p: options.topP,
            top_k: options.topK,
            frequency_penalty: options.frequencyPenalty,
            presence_penalty: options.presencePenalty,
            seed: options.seed,
            stop: options.stop,
        };
        if (typeof options.temperature === 'number') body.temperature = options.temperature;
        if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens;
        if (options.reasoning) body.reasoning = options.reasoning;
        if (typeof options.includeReasoning === 'boolean') body.include_reasoning = options.includeReasoning;

        const response = await this.fetchWithRetry(`${OPENROUTER_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                'HTTP-Referer': 'https://github.com/deep-research-cli',
                'X-Title': 'Deep Research CLI',
            },
            body: JSON.stringify(body),
        }, MAX_RETRIES, DEFAULT_CHAT_TIMEOUT_MS);

        if (!response.ok) {
            const errorMessage = await this.parseError(response);

            if (response.status === 401) {
                throw new Error(
                    'OpenRouter API authentication failed.\n' +
                    'Please check your OPENROUTER_API_KEY is valid.\n' +
                    'Run: research init'
                );
            }

            throw new Error(`OpenRouter API error: ${response.status} - ${errorMessage}`);
        }

        const data = await response.json();
        return {
            id: data.id,
            choices: data.choices.map((choice: any) => ({
                message: {
                    role: choice.message.role,
                    content: choice.message.content,
                },
                finishReason: choice.finish_reason,
            })),
            usage: {
                promptTokens: data.usage?.prompt_tokens || 0,
                completionTokens: data.usage?.completion_tokens || 0,
                totalTokens: data.usage?.total_tokens || 0,
            },
        };
    }

    /**
     * Send a streaming chat completion request
     */
    async *chatStream(
        model: string,
        messages: Message[],
        options: ChatOptions = {}
    ): AsyncGenerator<string, void, unknown> {
        for await (const event of this.chatStreamWithReasoning(model, messages, options)) {
            if (event.type === 'content') {
                yield event.text;
            }
        }
    }

    /**
     * Stream event type for detailed streaming
     */
    /**
     * Send a streaming chat completion request with reasoning support
     * Yields both content and reasoning tokens with their types
     */
    async *chatStreamWithReasoning(
        model: string,
        messages: Message[],
        options: ChatOptions = {}
    ): AsyncGenerator<{ type: 'content' | 'reasoning'; text: string }, void, unknown> {
        const body: any = {
            model,
            messages,
            stream: true,
            top_p: options.topP,
            top_k: options.topK,
            frequency_penalty: options.frequencyPenalty,
            presence_penalty: options.presencePenalty,
            seed: options.seed,
            stop: options.stop,
        };
        if (typeof options.temperature === 'number') body.temperature = options.temperature;
        if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens;
        if (options.reasoning) body.reasoning = options.reasoning;
        if (typeof options.includeReasoning === 'boolean') body.include_reasoning = options.includeReasoning;

        const response = await this.fetchWithRetry(`${OPENROUTER_API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                'HTTP-Referer': 'https://github.com/deep-research-cli',
                'X-Title': 'Deep Research CLI',
            },
            body: JSON.stringify(body),
        }, MAX_RETRIES, DEFAULT_STREAM_TIMEOUT_MS);

        if (!response.ok) {
            const errorMessage = await this.parseError(response);
            throw new Error(`OpenRouter API error: ${response.status} - ${errorMessage}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') return;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;

                        // Check for reasoning content (varies by model)
                        const reasoning = delta?.reasoning_content || delta?.reasoning;
                        if (reasoning) {
                            yield { type: 'reasoning', text: reasoning };
                        }

                        // Regular content
                        const content = delta?.content;
                        if (content) {
                            yield { type: 'content', text: content };
                        }
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        }
    }
}

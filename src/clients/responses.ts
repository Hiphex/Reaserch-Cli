/**
 * OpenRouter Responses API Client (Beta)
 * Provides access to the new Responses API with reasoning, tool calling, and web search
 */

const RESPONSES_API_BASE = 'https://openrouter.ai/api/v1/responses';

// Input types
export interface TextContent {
    type: 'input_text';
    text: string;
}

export interface InputMessage {
    type: 'message';
    role: 'user' | 'assistant';
    id?: string;
    status?: 'completed' | 'in_progress';
    content: (TextContent | OutputTextContent)[];
}

export interface OutputTextContent {
    type: 'output_text';
    text: string;
    annotations?: Annotation[];
}

export interface Annotation {
    type: 'url_citation';
    url: string;
    start_index: number;
    end_index: number;
}

export interface FunctionCall {
    type: 'function_call';
    id: string;
    call_id: string;
    name: string;
    arguments: string;
}

export interface FunctionCallOutput {
    type: 'function_call_output';
    id: string;
    call_id: string;
    output: string;
}

export type InputItem = InputMessage | FunctionCall | FunctionCallOutput;

// Reasoning configuration
export interface ReasoningConfig {
    effort: 'minimal' | 'low' | 'medium' | 'high';
}

// Web search plugin
export interface WebSearchPlugin {
    id: 'web';
    max_results?: number;
}

// Tool definition
export interface FunctionTool {
    type: 'function';
    name: string;
    description: string;
    strict?: boolean | null;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

// Request options
export interface ResponsesRequestOptions {
    model: string;
    input: string | InputItem[];
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stream?: boolean;
    reasoning?: ReasoningConfig;
    plugins?: WebSearchPlugin[];
    tools?: FunctionTool[];
    toolChoice?: 'auto' | 'none' | { type: 'function'; name: string };
}

// Response types
export interface ReasoningOutput {
    type: 'reasoning';
    id: string;
    encrypted_content?: string;
    summary?: string[];
}

export interface MessageOutput {
    type: 'message';
    id: string;
    status: 'completed' | 'in_progress';
    role: 'assistant';
    content: OutputTextContent[];
}

export interface FunctionCallResponseOutput {
    type: 'function_call';
    id: string;
    call_id: string;
    name: string;
    arguments: string;
}

export type OutputItem = ReasoningOutput | MessageOutput | FunctionCallResponseOutput;

export interface ResponsesResponse {
    id: string;
    object: 'response';
    created_at: number;
    model: string;
    output_text?: string;
    output: OutputItem[];
    usage: {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        output_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
    status: 'completed' | 'in_progress' | 'failed';
}

export class OpenRouterResponsesClient {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private getHeaders(accept?: string): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://github.com/deep-research-cli',
            'X-Title': 'Deep Research CLI',
        };
        if (accept) headers.Accept = accept;
        return headers;
    }

    extractTextAndCitations(response: ResponsesResponse): { text: string; citations: Annotation[] } {
        const citations: Annotation[] = [];
        const parts: string[] = [];

        const output = Array.isArray(response.output) ? response.output : [];
        for (const item of output) {
            if (item?.type !== 'message') continue;
            const message = item as MessageOutput;
            for (const content of message.content ?? []) {
                if (content?.type !== 'output_text') continue;
                if (typeof content.text === 'string') parts.push(content.text);
                if (Array.isArray(content.annotations)) {
                    citations.push(...content.annotations.filter((a) => a && typeof a.url === 'string'));
                }
            }
        }

        const text = parts.join('');
        if (text.trim().length > 0 || citations.length > 0) return { text, citations };

        const fallback = typeof response.output_text === 'string' ? response.output_text : '';
        return { text: fallback, citations: [] };
    }

    /**
     * Send a request to the Responses API (non-streaming)
     */
    async create(options: ResponsesRequestOptions): Promise<ResponsesResponse> {
        const response = await fetch(RESPONSES_API_BASE, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                model: options.model,
                input: options.input,
                max_output_tokens: options.maxOutputTokens ?? 9000,
                temperature: options.temperature,
                top_p: options.topP,
                stream: false,
                reasoning: options.reasoning,
                plugins: options.plugins,
                tools: options.tools,
                tool_choice: options.toolChoice,
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Responses API error: ${error.error?.message || response.status}`);
        }

        return response.json();
    }

    /**
     * Send a streaming request to the Responses API
     */
    async *createStream(
        options: ResponsesRequestOptions
    ): AsyncGenerator<StreamEvent, void, unknown> {
        const response = await fetch(RESPONSES_API_BASE, {
            method: 'POST',
            headers: this.getHeaders('text/event-stream'),
            body: JSON.stringify({
                model: options.model,
                input: options.input,
                max_output_tokens: options.maxOutputTokens ?? 9000,
                temperature: options.temperature,
                top_p: options.topP,
                stream: true,
                reasoning: options.reasoning,
                plugins: options.plugins,
                tools: options.tools,
                tool_choice: options.toolChoice,
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Responses API error: ${error.error?.message || response.status}`);
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
                        const parsed = JSON.parse(data) as StreamEvent;
                        yield parsed;
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        }
    }

    /**
     * Simple text request with optional reasoning
     */
    async reason(
        model: string,
        prompt: string,
        effort: ReasoningConfig['effort'] = 'medium'
    ): Promise<{ text: string; reasoning?: string[] }> {
        const response = await this.create({
            model,
            input: prompt,
            reasoning: { effort },
        });

        const reasoningOutput = response.output.find((o) => o.type === 'reasoning') as ReasoningOutput;
        const { text } = this.extractTextAndCitations(response);
        const reasoning = reasoningOutput?.summary;

        return { text, reasoning };
    }

    /**
     * Web search request
     */
    async searchWeb(
        model: string,
        query: string,
        maxResults: number = 5
    ): Promise<{ text: string; citations: Annotation[] }> {
        const response = await this.create({
            model,
            input: query,
            plugins: [{ id: 'web', max_results: maxResults }],
        });

        return this.extractTextAndCitations(response);
    }

    /**
     * Streaming text generation (yields text chunks)
     */
    async *streamText(
        model: string,
        input: string | InputItem[],
        options?: { reasoning?: ReasoningConfig; plugins?: WebSearchPlugin[] }
    ): AsyncGenerator<string, void, unknown> {
        for await (const event of this.createStream({
            model,
            input,
            reasoning: options?.reasoning,
            plugins: options?.plugins,
        })) {
            if (
                (event.type === 'response.content_part.delta' || event.type === 'response.output_text.delta') &&
                event.delta
            ) {
                yield event.delta;
            }
        }
    }
}

// Stream event types
export interface StreamEvent {
    type: string;
    response_id?: string;
    output_index?: number;
    content_index?: number;
    delta?: string;
    item?: any;
    response?: ResponsesResponse;
}

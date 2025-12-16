/**
 * Exa Search API Client
 * Provides semantic search and content retrieval capabilities
 */

const EXA_API_BASE = 'https://api.exa.ai';
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 90_000;

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

export interface ExaSearchOptions {
    type?: 'auto' | 'neural' | 'deep' | 'fast';
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    startPublishedDate?: string;
    endPublishedDate?: string;
    category?: 'company' | 'research paper' | 'news' | 'pdf' | 'github' | 'tweet';
    contents?: {
        text?: boolean;
        highlights?: {
            numSentences?: number;
            highlightsPerUrl?: number;
            query?: string;
        };
        summary?: {
            query?: string;
        };
    };
}

export interface ExaSearchResult {
    id: string;
    url: string;
    title: string;
    score: number;
    publishedDate?: string;
    author?: string;
    text?: string;
    highlights?: string[];
    summary?: string;
}

export interface ExaSearchResponse {
    requestId: string;
    resolvedSearchType: string;
    results: ExaSearchResult[];
}

export class ExaClient {
    private apiKey: string;

    constructor(apiKey: string) {
        if (!apiKey || apiKey.trim() === '') {
            throw new Error(
                'EXA_API_KEY is required.\n' +
                'Get your API key at: https://exa.ai\n' +
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
        timeoutMs: number = DEFAULT_TIMEOUT_MS
    ): Promise<Response> {
        let lastError: Error | null = null;
        let lastResponse: Response | null = null;

        for (let attempt = 0; attempt < retries; attempt++) {
            const resolvedTimeoutMs = envTimeoutMs(process.env.EXA_TIMEOUT_MS, timeoutMs);
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
                    ? INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt + 1)
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
                return json.message || json.error || text;
            } catch {
                return text;
            }
        } catch {
            return `HTTP ${response.status}`;
        }
    }

    /**
     * Perform a semantic search
     */
    async search(query: string, options: ExaSearchOptions = {}): Promise<ExaSearchResponse> {
        const response = await this.fetchWithRetry(`${EXA_API_BASE}/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
            },
            body: JSON.stringify({
                query,
                type: options.type || 'deep',
                numResults: options.numResults || 10,
                includeDomains: options.includeDomains,
                excludeDomains: options.excludeDomains,
                startPublishedDate: options.startPublishedDate,
                endPublishedDate: options.endPublishedDate,
                category: options.category,
                contents: options.contents || {
                    text: true,
                    highlights: {
                        numSentences: 3,
                        highlightsPerUrl: 3,
                    },
                    summary: {
                        query: query,
                    },
                },
            }),
        });

        if (!response.ok) {
            const errorMessage = await this.parseError(response);

            if (response.status === 401) {
                throw new Error(
                    'Exa API authentication failed.\n' +
                    'Please check your EXA_API_KEY is valid.\n' +
                    'Run: research init'
                );
            }

            if (response.status === 429) {
                throw new Error(
                    'Exa API rate limit exceeded.\n' +
                    'Please wait a moment and try again.'
                );
            }

            throw new Error(`Exa API error: ${response.status} - ${errorMessage}`);
        }

        return response.json();
    }

    /**
     * Execute multiple searches in parallel (batch)
     */
    async searchBatch(
        queries: string[],
        options: ExaSearchOptions = {}
    ): Promise<Map<string, ExaSearchResponse>> {
        const results = new Map<string, ExaSearchResponse>();

        const searchPromises = queries.map(async (query) => {
            const response = await this.search(query, options);
            return { query, response };
        });

        const responses = await Promise.all(searchPromises);

        for (const { query, response } of responses) {
            results.set(query, response);
        }

        return results;
    }

    /**
     * Get full page contents for given URLs (scraping)
     * Uses Exa's /contents endpoint for full text extraction
     */
    async getContents(urls: string[], options: { summary?: boolean } = {}): Promise<ExaSearchResult[]> {
        if (urls.length === 0) return [];

        const response = await this.fetchWithRetry(`${EXA_API_BASE}/contents`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
            },
            body: JSON.stringify({
                ids: urls,
                text: true,
                summary: options.summary ?? true,
            }),
        });

        if (!response.ok) {
            const errorMessage = await this.parseError(response);
            throw new Error(`Exa contents API error: ${response.status} - ${errorMessage}`);
        }

        const data = await response.json();
        return data.results || [];
    }
}

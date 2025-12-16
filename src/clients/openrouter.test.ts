/**
 * Unit tests for OpenRouter API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenRouterClient } from './openrouter.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OpenRouterClient', () => {
    let client: OpenRouterClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new OpenRouterClient('test-api-key');
    });

    describe('constructor', () => {
        it('should create a client with API key', () => {
            const testClient = new OpenRouterClient('my-api-key');
            expect(testClient).toBeDefined();
        });

        it('should throw an error if API key is empty', () => {
            expect(() => new OpenRouterClient('')).toThrow('OPENROUTER_API_KEY is required');
        });

        it('should throw an error if API key is whitespace only', () => {
            expect(() => new OpenRouterClient('   ')).toThrow('OPENROUTER_API_KEY is required');
        });
    });

    describe('listModels', () => {
        it('should fetch and parse models list', async () => {
            const mockModels = {
                data: [
                    {
                        id: 'anthropic/claude-3.5-sonnet',
                        name: 'Claude 3.5 Sonnet',
                        description: 'Latest Claude model',
                        context_length: 200000,
                        top_provider: { max_completion_tokens: 8192 },
                        supported_parameters: ['temperature', 'max_tokens'],
                        pricing: { prompt: '0.000003', completion: '0.000015' },
                    },
                    {
                        id: 'openai/gpt-4o',
                        name: 'GPT-4o',
                        context_length: 128000,
                        pricing: { prompt: '0.000005', completion: '0.000015' },
                    },
                ],
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockModels),
            });

            const models = await client.listModels();

            expect(mockFetch).toHaveBeenCalledWith(
                'https://openrouter.ai/api/v1/models',
                expect.objectContaining({
                    headers: { Authorization: 'Bearer test-api-key' },
                })
            );

            expect(models).toHaveLength(2);
            expect(models[0].id).toBe('anthropic/claude-3.5-sonnet');
            expect(models[0].contextLength).toBe(200000);
            expect(models[0].maxCompletionTokens).toBe(8192);
            expect(models[0].pricing.prompt).toBe(0.000003);
        });

        it('should throw on API error', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
                text: () => Promise.resolve('Forbidden'),
            });

            await expect(client.listModels()).rejects.toThrow('OpenRouter API error: 403');
        });
    });

    describe('chat', () => {
        it('should send chat completion request', async () => {
            const mockResponse = {
                id: 'gen-123',
                choices: [
                    {
                        message: { role: 'assistant', content: 'Hello!' },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 5,
                    total_tokens: 15,
                },
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            const result = await client.chat('anthropic/claude-3.5-sonnet', [
                { role: 'user', content: 'Hi' },
            ]);

            expect(mockFetch).toHaveBeenCalledWith(
                'https://openrouter.ai/api/v1/chat/completions',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test-api-key',
                        'Content-Type': 'application/json',
                    }),
                })
            );

            expect(result.choices[0].message.content).toBe('Hello!');
            expect(result.usage.totalTokens).toBe(15);
        });

        it('should include optional parameters', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () =>
                    Promise.resolve({
                        id: '123',
                        choices: [{ message: { role: 'assistant', content: 'Ok' }, finish_reason: 'stop' }],
                        usage: {},
                    }),
            });

            await client.chat(
                'anthropic/claude-3.5-sonnet',
                [{ role: 'user', content: 'Hi' }],
                {
                    temperature: 0.5,
                    maxTokens: 1000,
                    topP: 0.9,
                    reasoning: { effort: 'high' },
                }
            );

            const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(callBody.temperature).toBe(0.5);
            expect(callBody.max_tokens).toBe(1000);
            expect(callBody.top_p).toBe(0.9);
            expect(callBody.reasoning).toEqual({ effort: 'high' });
        });
    });
});

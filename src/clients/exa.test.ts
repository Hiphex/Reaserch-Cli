/**
 * Unit tests for Exa Search API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExaClient } from './exa.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ExaClient', () => {
    let client: ExaClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new ExaClient('test-api-key');
    });

    describe('constructor', () => {
        it('should create a client with API key', () => {
            const testClient = new ExaClient('my-api-key');
            expect(testClient).toBeDefined();
        });

        it('should throw an error if API key is empty', () => {
            expect(() => new ExaClient('')).toThrow('EXA_API_KEY is required');
        });

        it('should throw an error if API key is whitespace only', () => {
            expect(() => new ExaClient('   ')).toThrow('EXA_API_KEY is required');
        });
    });

    describe('search', () => {
        it('should make a POST request to the search endpoint', async () => {
            const mockResponse = {
                requestId: 'req-123',
                resolvedSearchType: 'deep',
                results: [
                    {
                        id: '1',
                        url: 'https://example.com',
                        title: 'Example',
                        score: 0.95,
                        text: 'Example content',
                        highlights: ['highlight 1'],
                        summary: 'A summary',
                    },
                ],
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            const result = await client.search('test query');

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.exa.ai/search',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': 'test-api-key',
                    },
                })
            );

            expect(result.results).toHaveLength(1);
            expect(result.results[0].url).toBe('https://example.com');
        });

        it('should throw an error on authentication failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: () => Promise.resolve('Unauthorized'),
            });

            await expect(client.search('test query')).rejects.toThrow(
                'Exa API authentication failed'
            );
        });

        it('should use provided options', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ requestId: '123', results: [] }),
            });

            await client.search('test query', {
                numResults: 20,
                type: 'neural',
                includeDomains: ['example.com'],
            });

            const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(callBody.numResults).toBe(20);
            expect(callBody.type).toBe('neural');
            expect(callBody.includeDomains).toEqual(['example.com']);
        });
    });

    describe('searchBatch', () => {
        it('should execute multiple searches in parallel', async () => {
            const createMockResponse = (query: string) => ({
                requestId: `req-${query}`,
                resolvedSearchType: 'deep',
                results: [{ id: '1', url: `https://${query}.com`, title: query, score: 0.9 }],
            });

            mockFetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(createMockResponse('query1')),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve(createMockResponse('query2')),
                });

            const results = await client.searchBatch(['query1', 'query2']);

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(results.size).toBe(2);
            expect(results.get('query1')?.results[0].url).toBe('https://query1.com');
            expect(results.get('query2')?.results[0].url).toBe('https://query2.com');
        });
    });
});

/**
 * Integration tests for the research pipeline
 * Tests the full flow with mocked API responses
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResearchPlanner, type ResearchPlan } from '../research/planner.js';
import { ResearchExecutor } from '../research/executor.js';
import { ReasoningSummarizer, SUMMARIZER_MODEL } from '../clients/summarizer.js';

// Create mock factory for OpenRouter client
const createMockOpenRouterClient = () => ({
    chat: vi.fn().mockResolvedValue({
        choices: [{
            message: {
                content: JSON.stringify({
                    mainQuestion: 'Test question',
                    steps: [
                        {
                            question: 'Sub-question 1',
                            searchQuery: 'test search query 1',
                            purpose: 'Test purpose 1',
                        },
                        {
                            question: 'Sub-question 2',
                            searchQuery: 'test search query 2',
                            purpose: 'Test purpose 2',
                        },
                    ],
                }),
            },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
    chatStream: vi.fn(),
    chatStreamWithReasoning: vi.fn(),
    listModels: vi.fn().mockResolvedValue([
        {
            id: 'test-model',
            name: 'Test Model',
            pricing: { prompt: 0.001, completion: 0.002 },
            contextLength: 8000,
        },
    ]),
});

// Create mock factory for Exa client
const createMockExaClient = () => ({
    search: vi.fn().mockResolvedValue({
        results: [
            {
                url: 'https://example.com/1',
                title: 'Test Result 1',
                text: 'This is test content for result 1.',
                summary: 'Summary of result 1',
                highlights: ['Highlight 1'],
                score: 0.9,
            },
            {
                url: 'https://example.com/2',
                title: 'Test Result 2',
                text: 'This is test content for result 2.',
                summary: 'Summary of result 2',
                highlights: ['Highlight 2'],
                score: 0.8,
            },
        ],
    }),
    getContents: vi.fn().mockResolvedValue([]),
});

// Type aliases using ReturnType for proper typing
type MockOpenRouterClient = ReturnType<typeof createMockOpenRouterClient>;
type MockExaClient = ReturnType<typeof createMockExaClient>;

describe('Research Pipeline Integration', () => {
    let mockOpenRouter: MockOpenRouterClient;
    let mockExa: MockExaClient;

    beforeEach(() => {
        mockOpenRouter = createMockOpenRouterClient();
        mockExa = createMockExaClient();
        vi.clearAllMocks();
    });

    describe('ResearchPlanner', () => {
        it('should create a research plan from a query', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const planner = new ResearchPlanner(mockOpenRouter as any, 'test-model');
            const plan = await planner.createPlan('What is AI?');

            expect(plan).toBeDefined();
            expect(plan.mainQuestion).toBe('Test question');
            expect(plan.steps).toHaveLength(2);
            expect(plan.steps[0].question).toBe('Sub-question 1');
            expect(mockOpenRouter.chat).toHaveBeenCalledTimes(1);
        });

        it('should handle malformed JSON gracefully', async () => {
            mockOpenRouter.chat.mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: 'Invalid JSON response',
                    },
                }],
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const planner = new ResearchPlanner(mockOpenRouter as any, 'test-model');
            await expect(planner.createPlan('Test query')).rejects.toThrow();
        });
    });

    describe('ResearchExecutor', () => {
        it('should execute all search steps', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const executor = new ResearchExecutor(mockExa as any);

            const plan: ResearchPlan = {
                mainQuestion: 'Test question',
                expectedInsights: [],
                steps: [
                    { id: 1, question: 'Q1', searchQuery: 'query1', purpose: 'P1', status: 'pending' },
                    { id: 2, question: 'Q2', searchQuery: 'query2', purpose: 'P2', status: 'pending' },
                ],
            };

            const results = await executor.executeAll(plan);

            expect(results).toHaveLength(2);
            expect(mockExa.search).toHaveBeenCalledTimes(2);
            expect(results[0].response.results).toHaveLength(2);
        });

        it('should report progress via callback', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const executor = new ResearchExecutor(mockExa as any);
            const progressCalls: number[] = [];

            const plan: ResearchPlan = {
                mainQuestion: 'Test question',
                expectedInsights: [],
                steps: [
                    { id: 1, question: 'Q1', searchQuery: 'query1', purpose: 'P1', status: 'pending' },
                ],
            };

            await executor.executeAll(plan, (step, index) => {
                progressCalls.push(index);
            });

            expect(progressCalls.length).toBeGreaterThan(0);
        });
    });

    describe('Full Pipeline', () => {
        it('should run planning -> execution without errors', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const planner = new ResearchPlanner(mockOpenRouter as any, 'test-model');
            const plan = await planner.createPlan('Test research topic');

            expect(plan.steps.length).toBeGreaterThan(0);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const executor = new ResearchExecutor(mockExa as any);
            const results = await executor.executeAll(plan);

            expect(results.length).toBe(plan.steps.length);
            expect(results.every(r => r.response.results.length > 0)).toBe(true);
        });
    });
});

describe('ReasoningSummarizer - No Hardcoded Limits', () => {
    it('SUMMARIZER_MODEL should be Gemini 2.0 Flash', () => {
        expect(SUMMARIZER_MODEL).toBe('google/gemini-2.0-flash-001');
    });

    it('should not throttle when no limits are configured', async () => {
        const mockClient = createMockOpenRouterClient();
        // Mock chat to return a summary
        mockClient.chat.mockResolvedValue({
            choices: [{ message: { content: 'Analyzing test data...' } }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });

        // Create summarizer with NO limits (all undefined)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const summarizer = new ReasoningSummarizer(mockClient as any, {
            bufferThreshold: 100, // Low threshold so we trigger summarization
            // maxSummaries: undefined - no limit
            // minGapSeconds: undefined - no limit
            // maxTokens: undefined - no limit
        });

        // Add enough text to trigger summarization multiple times
        const longText = 'This is a long reasoning text that should trigger summarization. '.repeat(10);

        // Call addReasoning multiple times - they should all proceed without throttling
        for (let i = 0; i < 5; i++) {
            summarizer.reset(); // Reset to clear state
            await summarizer.addReasoning(longText);
        }

        // The mock should have been called multiple times without throttling
        expect(mockClient.chat.mock.calls.length).toBe(5);
    });

    it('should respect maxSummaries when explicitly set', async () => {
        const mockClient = createMockOpenRouterClient();
        let chatCallCount = 0;
        mockClient.chat.mockImplementation(async () => {
            chatCallCount++;
            return {
                choices: [{ message: { content: `Summary ${chatCallCount}` } }],
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            };
        });

        // Create summarizer WITH an explicit limit of 2 summaries
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const summarizer = new ReasoningSummarizer(mockClient as any, {
            bufferThreshold: 50,
            maxSummaries: 2, // Only allow 2 summaries total
        });

        const text = 'This is reasoning text for testing. '.repeat(5);

        // First summary - should work
        const result1 = await summarizer.addReasoning(text);
        expect(result1).toBe('Summary 1');

        // Second summary - should also work (we've hit exactly 2)
        const result2 = await summarizer.addReasoning(text);
        expect(result2).toBe('Summary 2');

        // Third call - should be blocked by maxSummaries limit
        const result3 = await summarizer.addReasoning(text);
        expect(result3).toBeNull();

        // Fourth call - also blocked
        const result4 = await summarizer.addReasoning(text);
        expect(result4).toBeNull();

        // Only 2 actual chat API calls should have been made
        expect(chatCallCount).toBe(2);
    });

    it('should allow unlimited summaries when maxSummaries is undefined', async () => {
        const mockClient = createMockOpenRouterClient();
        let callCount = 0;
        mockClient.chat.mockImplementation(async () => {
            callCount++;
            return {
                choices: [{ message: { content: `Summary ${callCount}` } }],
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            };
        });

        // Create summarizer with NO maxSummaries limit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const summarizer = new ReasoningSummarizer(mockClient as any, {
            bufferThreshold: 50,
            // maxSummaries is undefined = no limit
        });

        const text = 'This is a reasonably long text for testing summarization. '.repeat(3);

        // Make many calls - they should all be allowed since no limit
        for (let i = 0; i < 10; i++) {
            summarizer.reset(); // Reset to clear count and buffer each time
            await summarizer.addReasoning(text);
        }

        // Chat should have been called for each iteration (10 times)
        expect(mockClient.chat.mock.calls.length).toBe(10);
    });
});

/**
 * Sub-Research Agent - Handles individual research tasks in parallel
 */

import { OpenRouterClient, type Message, type ChatOptions } from '../clients/openrouter.js';
import { ExaClient, type ExaSearchResult } from '../clients/exa.js';
import type { ResearchStep } from '../research/planner.js';
import { envBool, envIntOrInfinity, envNonNegativeInt, envPositiveInt } from '../utils/env.js';

// Sensible defaults and hard caps to prevent unbounded API calls
// Users can override via env vars or constructor options (still clamped to hard max)
const DEFAULT_MAX_SEARCH_ROUNDS = 5;
const HARD_MAX_SEARCH_ROUNDS = 50;
const DEFAULT_MAX_EXPANDED_URLS = 5;
const HARD_MAX_EXPANDED_URLS = 50;
const DEFAULT_MAX_RECURSION_DEPTH = 2;
const HARD_MAX_RECURSION_DEPTH = 5;

const SUB_AGENT_MODEL = 'qwen/qwen3-235b-a22b-2507';

const getSubAgentPrompt = () => `You are a focused research agent. Your job is to thoroughly research ONE specific topic and produce a detailed summary.

Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

You will receive:
1. A research question
2. Search results with sources

Your task:
1. Analyze all sources carefully
2. Extract key facts, data, and insights
3. Note any contradictions or gaps
4. Write a comprehensive summary (300-500 words)

Format your response as:

## Key Findings
- [Bullet points of main discoveries]

## Details
[Narrative summary with specific data points and citations]

## Sources Used
[List the most valuable sources]

## Gaps or Uncertainties
[Any areas that need more research]

Be specific. Include numbers, dates, and quotes when available.`;

const getExpansionPrompt = (maxUrls: number) => `Based on the sources provided, identify up to ${maxUrls} URLs that would benefit from deeper reading to get more complete information. 
Return a JSON array of URLs, or empty array if the current sources are sufficient.
Example: ["https://example.com/article1", "https://example.com/article2"]
Only return the JSON array, nothing else.`;

const FOLLOW_UP_QUERY_PROMPT = `You propose ONE additional web search query to gather NEW information for a research question.

Return ONLY JSON:
{"query": "your search query"}

Rules:
- If no further search is needed, return: {"query": ""}
- The query MUST be meaningfully different from prior queries.
- Avoid duplicating the same intent with minor wording changes.
- Prefer specific keywords, entities, datasets, reports, or “site:”/filetype hints only if helpful.
- Keep it concise (<= 18 words).`;

const SUB_TOPIC_IDENTIFICATION_PROMPT = `You are analyzing research findings to determine if any sub-topics require deeper, separate investigation.

Given the research question and current findings, identify 1-2 complex sub-topics that would significantly benefit from dedicated research.

Conditions for suggesting sub-topics:
- The sub-topic is complex enough to warrant its own research thread
- Current sources mention it but don't provide sufficient depth
- Understanding this sub-topic is critical to answering the main question

Return ONLY JSON:
{"subTopics": [{"question": "focused research question", "searchQuery": "optimized search query", "reason": "why this needs deeper research"}]}

If no sub-topics need deeper research, return: {"subTopics": []}`;

export interface SubAgentReport {
    step: ResearchStep;
    summary: string;
    sources: ExaSearchResult[];
    expandedSources?: ExaSearchResult[];
    keyInsights: string[];
}

export class SubResearchAgent {
    private chatClient: OpenRouterClient;
    private exaClient: ExaClient;
    private model: string;
    private options: ChatOptions;
    private numResults: number;
    private expansionCandidates: number;
    private maxExpandedUrls: number;
    private expandSourcesByDefault: boolean;
    private maxSearchRounds: number;
    private sourceTextChars: number;
    private expandedTextChars: number;
    private maxTotalSourceChars: number;
    private currentDepth: number;
    private maxRecursionDepth: number;

    // Track if user requested unlimited (before clamping) for UI display
    private userRequestedUnlimitedRounds: boolean;

    constructor(
        chatClient: OpenRouterClient,
        exaClient: ExaClient,
        options: {
            model?: string;
            chatOptions?: ChatOptions;
            numResults?: number;
            expansionCandidates?: number;
            maxExpandedUrls?: number;
            expandSources?: boolean;
            maxSearchRounds?: number;
            sourceTextChars?: number;
            expandedTextChars?: number;
            maxTotalSourceChars?: number;
            depth?: number;
            maxRecursionDepth?: number;
        } = {}
    ) {
        this.chatClient = chatClient;
        this.exaClient = exaClient;
        this.model = options.model || SUB_AGENT_MODEL;
        this.options = options.chatOptions || {};
        this.numResults = typeof options.numResults === 'number' ? options.numResults : envPositiveInt(process.env.SUBAGENT_NUM_RESULTS, 10);
        this.expansionCandidates = typeof options.expansionCandidates === 'number'
            ? options.expansionCandidates
            : envPositiveInt(process.env.SUBAGENT_EXPANSION_CANDIDATES, 8);
        // maxExpandedUrls: user value clamped to hard limit, or default
        const rawMaxExpanded = typeof options.maxExpandedUrls === 'number'
            ? options.maxExpandedUrls
            : envIntOrInfinity(process.env.SUBAGENT_MAX_EXPANDED_URLS, DEFAULT_MAX_EXPANDED_URLS);
        this.maxExpandedUrls = Math.min(
            Math.max(0, Number.isFinite(rawMaxExpanded) ? rawMaxExpanded : HARD_MAX_EXPANDED_URLS),
            HARD_MAX_EXPANDED_URLS
        );

        this.expandSourcesByDefault = typeof options.expandSources === 'boolean'
            ? options.expandSources
            : envBool(process.env.SUBAGENT_EXPAND_SOURCES, true);

        // maxSearchRounds: user value clamped to hard limit, or default
        const rawMaxRounds = typeof options.maxSearchRounds === 'number'
            ? options.maxSearchRounds
            : envIntOrInfinity(process.env.SUBAGENT_MAX_SEARCH_ROUNDS, DEFAULT_MAX_SEARCH_ROUNDS);
        // Capture user's intent before clamping (for UI display)
        this.userRequestedUnlimitedRounds = !Number.isFinite(rawMaxRounds);
        this.maxSearchRounds = Math.min(
            Math.max(1, Number.isFinite(rawMaxRounds) ? rawMaxRounds : HARD_MAX_SEARCH_ROUNDS),
            HARD_MAX_SEARCH_ROUNDS
        );
        this.sourceTextChars = typeof options.sourceTextChars === 'number'
            ? options.sourceTextChars
            : envNonNegativeInt(process.env.SUBAGENT_SOURCE_TEXT_CHARS, 2200);
        this.expandedTextChars = typeof options.expandedTextChars === 'number'
            ? options.expandedTextChars
            : envNonNegativeInt(process.env.SUBAGENT_EXPANDED_TEXT_CHARS, 4500);
        this.maxTotalSourceChars = typeof options.maxTotalSourceChars === 'number'
            ? options.maxTotalSourceChars
            : envIntOrInfinity(process.env.SUBAGENT_MAX_TOTAL_SOURCE_CHARS, 65_000);

        // Recursion depth control (0 disables recursive research)
        this.currentDepth = typeof options.depth === 'number' ? options.depth : 0;
        const rawMaxDepth = typeof options.maxRecursionDepth === 'number'
            ? options.maxRecursionDepth
            : envNonNegativeInt(process.env.SUBAGENT_MAX_RECURSION_DEPTH, DEFAULT_MAX_RECURSION_DEPTH);
        this.maxRecursionDepth = Math.min(Math.max(0, rawMaxDepth), HARD_MAX_RECURSION_DEPTH);
    }

    /**
     * Research a single step and return findings
     */
    async research(
        step: ResearchStep,
        options: {
            expandSources?: boolean;
            onStatus?: (status: string) => void;
        } = {}
    ): Promise<SubAgentReport> {
        const reportStatus = options.onStatus || (() => { });
        const expandSources = typeof options.expandSources === 'boolean' ? options.expandSources : this.expandSourcesByDefault;

        const normalizeQueryKey = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();
        const usedQueryKeys = new Set<string>();
        const queriesUsed: string[] = [];

        const mergedByUrl = new Map<string, ExaSearchResult>();
        const mergeResult = (next: ExaSearchResult) => {
            const url = String(next.url || '').trim();
            if (!url) return;
            const existing = mergedByUrl.get(url);
            if (!existing) {
                mergedByUrl.set(url, next);
                return;
            }
            mergedByUrl.set(url, {
                ...existing,
                ...next,
                text: next.text && next.text.length > (existing.text?.length || 0) ? next.text : existing.text,
                summary: next.summary && next.summary.length > (existing.summary?.length || 0) ? next.summary : existing.summary,
                highlights: Array.isArray(next.highlights) && next.highlights.length > (existing.highlights?.length || 0)
                    ? next.highlights
                    : existing.highlights,
                score: Math.max(existing.score ?? 0, next.score ?? 0),
            });
        };

        // 1. One or more searches (sub-agent can stop early)
        let currentQuery = step.searchQuery || step.question;
        for (let round = 1; round <= this.maxSearchRounds; round++) {
            const key = normalizeQueryKey(currentQuery);
            if (!key || usedQueryKeys.has(key)) break;
            usedQueryKeys.add(key);
            queriesUsed.push(currentQuery);

            // Show round number - use "unlimited" style if user requested it (even though we clamp)
            const statusText = this.userRequestedUnlimitedRounds
                ? `Searching (round ${round})...`
                : this.maxSearchRounds > 1
                    ? `Searching (${round}/${this.maxSearchRounds})...`
                    : 'Searching...';
            reportStatus(statusText);
            const searchResponse = await this.exaClient.search(currentQuery, {
                numResults: this.numResults,
                type: 'deep',
                contents: {
                    text: true,
                    highlights: { numSentences: 4, highlightsPerUrl: 4 },
                    summary: { query: step.question },
                },
            });

            searchResponse.results.forEach(mergeResult);

            if (round >= this.maxSearchRounds) break;

            reportStatus('Checking for additional sources...');
            const nextQuery = await this.suggestFollowUpQuery(step, queriesUsed, Array.from(mergedByUrl.values()));
            if (!nextQuery) break;
            const nextKey = normalizeQueryKey(nextQuery);
            if (!nextKey || usedQueryKeys.has(nextKey)) break;
            currentQuery = nextQuery;
        }

        const searchResults = Array.from(mergedByUrl.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        let expandedSources: ExaSearchResult[] = [];

        // 2. Optionally expand promising sources
        if (expandSources && this.maxExpandedUrls > 0 && searchResults.length > 0) {
            reportStatus(`Found ${searchResults.length} sources, checking for deep reads...`);
            const urlsToExpand = await this.identifySourcesForExpansion(searchResults, step.question);
            if (urlsToExpand.length > 0) {
                reportStatus(`Reading ${urlsToExpand.length} pages in depth...`);
                expandedSources = await this.exaClient.getContents(urlsToExpand);
            }
        }

        // 3. Analyze and summarize
        const expandedByUrl = new Map<string, ExaSearchResult>();
        expandedSources.forEach((s) => {
            const url = String(s.url || '').trim();
            if (url) expandedByUrl.set(url, s);
        });
        const expandedUrlSet = new Set<string>(expandedByUrl.keys());

        const mergedForAnalysis = searchResults.map((s) => expandedByUrl.get(s.url) ?? s);
        expandedByUrl.forEach((s, url) => {
            if (!mergedForAnalysis.some((x) => x.url === url)) mergedForAnalysis.push(s);
        });

        const allSources = mergedForAnalysis;
        reportStatus(`Analyzing ${allSources.length} sources...`);
        let summary = await this.analyzeSources(step, allSources, expandedUrlSet);

        // 4. Extract key insights
        reportStatus('Extracting insights...');
        const keyInsights = this.extractKeyInsights(summary);

        // 5. Recursive research for complex sub-topics (if depth allows)
        if (this.currentDepth < this.maxRecursionDepth) {
            reportStatus('Checking for complex sub-topics...');
            const subTopics = await this.identifySubTopics(step, summary, searchResults);

            if (subTopics.length > 0) {
                reportStatus(`Found ${subTopics.length} sub-topic(s) requiring deeper research...`);

                for (const subTopic of subTopics) {
                    reportStatus(`[Child] Researching: ${subTopic.question.slice(0, 40)}...`);

                    // Create a child agent with incremented depth
                    const childAgent = new SubResearchAgent(this.chatClient, this.exaClient, {
                        model: this.model,
                        chatOptions: this.options,
                        numResults: this.numResults,
                        expansionCandidates: this.expansionCandidates,
                        maxExpandedUrls: this.maxExpandedUrls,
                        expandSources: this.expandSourcesByDefault,
                        maxSearchRounds: Math.max(1, this.maxSearchRounds - 1), // Fewer rounds for child
                        sourceTextChars: this.sourceTextChars,
                        expandedTextChars: this.expandedTextChars,
                        maxTotalSourceChars: this.maxTotalSourceChars,
                        depth: this.currentDepth + 1,
                        maxRecursionDepth: this.maxRecursionDepth,
                    });

                    const childStep: ResearchStep = {
                        id: step.id * 100 + subTopics.indexOf(subTopic) + 1,
                        question: subTopic.question,
                        searchQuery: subTopic.searchQuery,
                        purpose: subTopic.reason,
                        status: 'pending',
                    };

                    try {
                        const childReport = await childAgent.research(childStep, {
                            expandSources: this.expandSourcesByDefault,
                            onStatus: (status) => reportStatus(`  [Child] ${status}`),
                        });

                        // Append child findings to this step's summary
                        summary += `\n\n---\n\n### Sub-Research: ${subTopic.question}\n\n${childReport.summary}`;
                        keyInsights.push(...childReport.keyInsights);
                        searchResults.push(...childReport.sources);
                    } catch {
                        // Child research failed - continue without it
                        reportStatus(`  [Child] Sub-research failed, continuing...`);
                    }
                }
            }
        }

        reportStatus('Complete');
        return {
            step,
            summary,
            sources: searchResults,
            expandedSources: expandedSources.length > 0 ? expandedSources : undefined,
            keyInsights: keyInsights.slice(0, 10), // Cap insights after combining with child insights
        };
    }

    /**
     * Identify which sources would benefit from full page reading
     */
    private async identifySourcesForExpansion(sources: ExaSearchResult[], question: string): Promise<string[]> {
        if (this.maxExpandedUrls <= 0 || this.expansionCandidates <= 0) return [];
        try {
            const sourceList = sources
                .slice(0, this.expansionCandidates)
                .map((s, i) => `${i + 1}. ${s.title} (${s.url})\n   ${s.summary || s.highlights?.join(' ') || ''}`)
                .join('\n');

            const messages: Message[] = [
                { role: 'system', content: getExpansionPrompt(this.maxExpandedUrls) },
                { role: 'user', content: `Question: ${question}\n\nSources:\n${sourceList}` },
            ];

            const response = await this.chatClient.chat(this.model, messages, {
                temperature: 0.2,
            });

            const content = response.choices[0]?.message?.content?.trim();
            if (!content) return [];

            // Parse JSON array
            const match = content.match(/\[[\s\S]*\]/);
            if (match) {
                const urls = JSON.parse(match[0]);
                return urls
                    .filter((u: any) => typeof u === 'string')
                    .map((u: string) => u.trim())
                    .filter((u: string) => u.length > 0)
                    .slice(0, this.maxExpandedUrls);
            }

            return [];
        } catch {
            return [];
        }
    }

    /**
     * Analyze sources and produce summary
     */
    private async analyzeSources(step: ResearchStep, sources: ExaSearchResult[], expandedUrls: Set<string>): Promise<string> {
        const sliceText = (input: string, maxChars: number) => {
            if (maxChars <= 0) return '';
            if (input.length <= maxChars) return input;
            return input.slice(0, maxChars);
        };

        const isFiniteBudget = Number.isFinite(this.maxTotalSourceChars);
        let remaining = isFiniteBudget ? Math.max(0, Math.trunc(this.maxTotalSourceChars)) : Number.POSITIVE_INFINITY;

        const sourceContextParts: string[] = [];
        for (let i = 0; i < sources.length; i++) {
            const s = sources[i];
            const rawText = s.text || s.highlights?.join('\n') || s.summary || '';
            const perSourceCap = expandedUrls.has(s.url) ? this.expandedTextChars : this.sourceTextChars;
            const cap = isFiniteBudget ? Math.min(perSourceCap, remaining) : perSourceCap;
            const content = sliceText(rawText, cap);

            sourceContextParts.push(`[Source ${i + 1}] ${s.title}\nURL: ${s.url}\n${content}`);

            if (isFiniteBudget) {
                remaining = Math.max(0, remaining - content.length);
                if (remaining <= 0) break;
            }
        }

        const sourceContext = sourceContextParts.join('\n\n---\n\n');

        const messages: Message[] = [
            { role: 'system', content: getSubAgentPrompt() },
            {
                role: 'user',
                content: `Research Question: ${step.question}\n\nPurpose: ${step.purpose}\n\n---\n\nSOURCES:\n\n${sourceContext}`,
            },
        ];

        const response = await this.chatClient.chat(this.model, messages, {
            temperature: 0.4,
            ...this.options,
        });

        return response.choices[0]?.message?.content?.trim() || '';
    }

    private brief(input: string, maxLen: number): string {
        const text = String(input ?? '').replace(/\s+/g, ' ').trim();
        if (text.length <= maxLen) return text;
        if (maxLen <= 1) return '…';
        return text.slice(0, maxLen - 1) + '…';
    }

    private async suggestFollowUpQuery(step: ResearchStep, priorQueries: string[], sources: ExaSearchResult[]): Promise<string | null> {
        try {
            const queryList = priorQueries.map((q, i) => `${i + 1}. ${q}`).join('\n');
            const topSources = sources
                .slice(0, 6)
                .map((s, i) => {
                    const snippet = this.brief(s.summary || s.highlights?.[0] || s.text || '', 220);
                    return `${i + 1}. ${this.brief(s.title, 90)} (${s.url})${snippet ? ` — ${snippet}` : ''}`;
                })
                .join('\n');

            const messages: Message[] = [
                { role: 'system', content: FOLLOW_UP_QUERY_PROMPT },
                {
                    role: 'user',
                    content:
                        `Research question: ${step.question}\n` +
                        `Purpose: ${step.purpose}\n\n` +
                        `Queries already used:\n${queryList}\n\n` +
                        `Top sources so far:\n${topSources}\n`,
                },
            ];

            const response = await this.chatClient.chat(this.model, messages, { temperature: 0.2 });
            const content = response.choices[0]?.message?.content?.trim() || '';

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const raw = jsonMatch ? jsonMatch[0] : content;

            try {
                const parsed = JSON.parse(raw);
                const q = typeof parsed?.query === 'string' ? parsed.query.trim() : '';
                return q.length > 0 ? q : null;
            } catch {
                const q = content.trim();
                if (!q) return null;
                if (q.startsWith('{') || q.startsWith('[')) return null;
                return q.length > 0 ? q : null;
            }
        } catch {
            return null;
        }
    }

    /**
     * Extract key insights from summary
     */
    private extractKeyInsights(summary: string): string[] {
        const insights: string[] = [];

        // Look for bullet points under "Key Findings"
        const keyFindingsMatch = summary.match(/## Key Findings\n([\s\S]*?)(?=\n## |$)/);
        if (keyFindingsMatch) {
            const bullets = keyFindingsMatch[1].match(/^- .+$/gm);
            if (bullets) {
                insights.push(...bullets.map(b => b.slice(2).trim()));
            }
        }

        return insights.slice(0, 5);
    }

    /**
     * Identify sub-topics that would benefit from dedicated recursive research
     */
    private async identifySubTopics(
        step: ResearchStep,
        summary: string,
        sources: ExaSearchResult[]
    ): Promise<Array<{ question: string; searchQuery: string; reason: string }>> {
        // Don't recurse if we're already at max depth
        if (this.currentDepth >= this.maxRecursionDepth) {
            return [];
        }

        try {
            const sourceList = sources
                .slice(0, 6)
                .map((s, i) => `${i + 1}. ${s.title} - ${s.summary || s.highlights?.[0] || ''}`.slice(0, 200))
                .join('\n');

            const messages: Message[] = [
                { role: 'system', content: SUB_TOPIC_IDENTIFICATION_PROMPT },
                {
                    role: 'user',
                    content: `Research Question: ${step.question}\n\nCurrent Summary:\n${summary.slice(0, 1500)}\n\nSources Found:\n${sourceList}`,
                },
            ];

            const response = await this.chatClient.chat(this.model, messages, { temperature: 0.3 });
            const content = response.choices[0]?.message?.content?.trim() || '';

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed.subTopics)) {
                    return parsed.subTopics
                        .filter((t: any) => t && typeof t.question === 'string' && t.question.trim())
                        .slice(0, 2) // Max 2 sub-topics per level
                        .map((t: any) => ({
                            question: t.question.trim(),
                            searchQuery: t.searchQuery?.trim() || t.question.trim(),
                            reason: t.reason?.trim() || 'Needs deeper research',
                        }));
                }
            }

            return [];
        } catch {
            return [];
        }
    }
}

/**
 * Agent status for live display
 */
export interface AgentStatus {
    index: number;
    question: string;
    status: string;
    complete: boolean;
    sources: number;
    failed: boolean;
}

/**
 * Run multiple sub-agents in parallel with live status updates
 */
export async function runParallelResearch(
    steps: ResearchStep[],
    chatClient: OpenRouterClient,
    exaClient: ExaClient,
    callbacks: {
        onProgress?: (completed: number, total: number, step: ResearchStep) => void;
        onStatusUpdate?: (statuses: AgentStatus[]) => void;
    } = {},
    options: {
        expandSources?: boolean;
        model?: string;
        numResults?: number;
        expansionCandidates?: number;
        maxExpandedUrls?: number;
        maxSearchRounds?: number;
        sourceTextChars?: number;
        expandedTextChars?: number;
        maxTotalSourceChars?: number;
        concurrency?: number;
    } = {}
): Promise<SubAgentReport[]> {
    const agent = new SubResearchAgent(chatClient, exaClient, {
        model: options.model,
        numResults: options.numResults,
        expansionCandidates: options.expansionCandidates,
        maxExpandedUrls: options.maxExpandedUrls,
        expandSources: options.expandSources,
        maxSearchRounds: options.maxSearchRounds,
        sourceTextChars: options.sourceTextChars,
        expandedTextChars: options.expandedTextChars,
        maxTotalSourceChars: options.maxTotalSourceChars,
    });

    // Track status for each agent
    const statuses: AgentStatus[] = steps.map((step, index) => ({
        index,
        question: step.question,
        status: 'Waiting...',
        complete: false,
        sources: 0,
        failed: false,
    }));

    const updateStatus = (index: number, status: string, complete = false, sources?: number, failed?: boolean) => {
        statuses[index].status = status;
        statuses[index].complete = complete;
        if (typeof sources === 'number') statuses[index].sources = sources;
        if (typeof failed === 'boolean') statuses[index].failed = failed;
        if (callbacks.onStatusUpdate) {
            callbacks.onStatusUpdate([...statuses]);
        }
    };

    const runOne = async (step: ResearchStep, index: number): Promise<SubAgentReport> => {
        try {
            const report = await agent.research(step, {
                expandSources: options.expandSources,
                onStatus: (status) => updateStatus(index, status, false),
            });
            const totalSources = report.sources.length + (report.expandedSources?.length || 0);
            updateStatus(index, 'Complete', true, totalSources, false);
            if (callbacks.onProgress) {
                callbacks.onProgress(
                    statuses.filter(s => s.complete).length,
                    steps.length,
                    step
                );
            }
            return report;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const short = message.split('\n')[0]?.trim() || 'Sub-agent failed';
            updateStatus(index, `Error: ${short}`, true, 0, true);
            if (callbacks.onProgress) {
                callbacks.onProgress(
                    statuses.filter(s => s.complete).length,
                    steps.length,
                    step
                );
            }
            const summary = `## Key Findings
- Sub-agent failed to complete

## Details
${message}

## Sources Used
- (none)

## Gaps or Uncertainties
- This sub-topic could not be completed due to an error.`;
            return {
                step,
                summary,
                sources: [],
                expandedSources: undefined,
                keyInsights: [],
            };
        }
    };

    const requestedConcurrency = typeof options.concurrency === 'number'
        ? options.concurrency
        : envPositiveInt(process.env.SUBAGENT_CONCURRENCY, steps.length || 1);
    const concurrency = Math.max(1, Math.min(requestedConcurrency, steps.length || 1));

    const results: SubAgentReport[] = new Array(steps.length);
    let nextIndex = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= steps.length) break;
            results[index] = await runOne(steps[index], index);
        }
    });

    await Promise.all(workers);
    return results;
}

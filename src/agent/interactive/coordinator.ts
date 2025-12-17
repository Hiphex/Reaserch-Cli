/**
 * Coordinator for Deep Research Agent
 * Separates core logic from UI (inquirer, console)
 */

import { Config, DEFAULTS } from '../../config.js';
import { OpenRouterClient, ChatOptions } from '../../clients/openrouter.js';
import { OpenRouterResponsesClient, Annotation, StreamEvent } from '../../clients/responses.js';
import { ExaClient } from '../../clients/exa.js';
import { ResearchPlanner, type ResearchPlan } from '../../research/planner.js';
import { runParallelResearch, SubAgentReport, AgentStatus } from '../sub-agent.js';
import { FactChecker } from '../fact-checker.js';
import { ReasoningSummarizer, SUMMARIZER_MODEL_ID } from '../../clients/summarizer.js';
import { envPositiveInt, envNonNegativeInt, envBool, envIntOrInfinity } from '../../utils/env.js';
import { estimateCost, CostBreakdown } from '../../utils/cost-estimator.js';

export interface AgentCallbacks {
    onStatusUpdate?: (status: string) => void;
    onSubAgentStatus?: (statuses: AgentStatus[]) => void;
    onReasoning?: (text: string) => void;
    onStreamOutput?: (text: string) => void;
    onToolCall?: (event: StreamEvent) => void;
}

export interface ResearchResult {
    text: string;
    sources: string[];
    reasoning?: string[];
}

export interface DeepResearchResult {
    markdown: string;
    reportTopics: SubAgentReport[];
    costEstimate?: CostBreakdown;
}

export class AgentCoordinator {
    private config: Config;
    private apiKey: string;
    private model: string;
    private chatClient: OpenRouterClient;
    private responsesClient: OpenRouterResponsesClient;
    private exaClient: ExaClient;

    constructor(config: Config, model?: string) {
        this.config = config;
        this.apiKey = config.openrouterApiKey;
        this.model = model || config.defaultModel || DEFAULTS.model;

        this.chatClient = new OpenRouterClient(this.apiKey);
        this.responsesClient = new OpenRouterResponsesClient(this.apiKey);
        this.exaClient = new ExaClient(config.exaApiKey);
    }

    public getModel() {
        return this.model;
    }

    public getChatClient() {
        return this.chatClient;
    }

    public getResponsesClient() {
        return this.responsesClient;
    }

    public updateConfig(newConfig: Config) {
        this.config = newConfig;
        if (newConfig.openrouterApiKey !== this.apiKey) {
            this.apiKey = newConfig.openrouterApiKey;
            this.chatClient = new OpenRouterClient(this.apiKey);
            this.responsesClient = new OpenRouterResponsesClient(this.apiKey);
        }
        if (newConfig.exaApiKey !== this.exaClient['apiKey']) { // simplistic check, realistically just re-init
            this.exaClient = new ExaClient(newConfig.exaApiKey);
        }
        this.model = newConfig.defaultModel || this.model;
    }

    public setModel(model: string) {
        this.model = model;
    }

    /**
     * Create a research plan from a topic (Phase 1: Planning)
     * Returns the plan for user review/editing before execution
     */
    async createResearchPlan(
        topic: string,
        callbacks: AgentCallbacks = {}
    ): Promise<{ plan: ResearchPlan; summarizer: ReasoningSummarizer }> {
        const modelOptions = this.getModelChatOptions();

        callbacks.onStatusUpdate?.('Planning research...');
        const summarizer = new ReasoningSummarizer(this.chatClient);
        const planner = new ResearchPlanner(this.chatClient, this.model, modelOptions);

        const plan = await planner.createPlanWithReasoning(topic, async (text) => {
            const summary = await summarizer.addReasoning(text);
            if (summary) callbacks.onReasoning?.(summary);
        });

        // Flush reasoning
        const finalPlanThought = await summarizer.flush();
        if (finalPlanThought) callbacks.onReasoning?.(finalPlanThought);
        summarizer.reset();

        return { plan, summarizer };
    }

    /**
     * Execute a research plan (Phase 2: Execution + Synthesis)
     * Accepts a (potentially user-edited) plan
     */
    async executeResearchPlan(
        plan: ResearchPlan,
        callbacks: AgentCallbacks = {},
        options: { dryRun?: boolean; summarizer?: ReasoningSummarizer } = {}
    ): Promise<DeepResearchResult> {
        const modelOptions = this.getModelChatOptions();
        const summarizer = options.summarizer ?? new ReasoningSummarizer(this.chatClient);

        // Cost estimation for dry run
        if (options.dryRun) {
            const models = await this.chatClient.listModels();
            const mainModel = models.find(m => m.id === this.model);
            const summarizerModel = models.find(m => m.id === SUMMARIZER_MODEL_ID);

            const costEstimate = estimateCost(mainModel, summarizerModel, {
                numSteps: plan.steps.length,
                numFollowUps: this.config.autoFollowup ? 2 : 0,
            });

            return { markdown: 'Dry run complete', reportTopics: [], costEstimate };
        }

        // Execute research steps
        callbacks.onStatusUpdate?.('Executing research steps...');

        const subAgentNumResults = envPositiveInt(process.env.SUBAGENT_NUM_RESULTS, this.config.exaNumResults);
        const subAgentExpansionCandidates = envPositiveInt(process.env.SUBAGENT_EXPANSION_CANDIDATES, 8);
        const subAgentMaxExpandedUrls = envNonNegativeInt(process.env.SUBAGENT_MAX_EXPANDED_URLS, 5);
        const subAgentExpandSources = envBool(process.env.SUBAGENT_EXPAND_SOURCES, true) && subAgentMaxExpandedUrls > 0;
        const subAgentMaxSearchRounds = envPositiveInt(process.env.SUBAGENT_MAX_SEARCH_ROUNDS, 2);
        const subAgentSourceTextChars = envNonNegativeInt(process.env.SUBAGENT_SOURCE_TEXT_CHARS, 2200);
        const subAgentExpandedTextChars = envNonNegativeInt(process.env.SUBAGENT_EXPANDED_TEXT_CHARS, 4500);
        const subAgentMaxTotalSourceChars = envIntOrInfinity(process.env.SUBAGENT_MAX_TOTAL_SOURCE_CHARS, 65_000);
        const subAgentConcurrency = envPositiveInt(process.env.SUBAGENT_CONCURRENCY, plan.steps.length);

        // Initial execution
        let allReports = await runParallelResearch(
            plan.steps,
            this.chatClient,
            this.exaClient,
            {
                onStatusUpdate: callbacks.onSubAgentStatus
            },
            {
                expandSources: subAgentExpandSources,
                numResults: subAgentNumResults,
                expansionCandidates: subAgentExpansionCandidates,
                maxExpandedUrls: subAgentMaxExpandedUrls,
                maxSearchRounds: subAgentMaxSearchRounds,
                sourceTextChars: subAgentSourceTextChars,
                expandedTextChars: subAgentExpandedTextChars,
                maxTotalSourceChars: subAgentMaxTotalSourceChars,
                concurrency: subAgentConcurrency,
            }
        );

        // Gap Analysis & Follow-up
        let additionalRounds = 0;
        const maxAdditionalRounds = this.config.maxFollowupSteps;
        const executedQueries = new Set<string>();
        const normalizeQueryKey = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

        allReports.forEach(r => {
            const key = normalizeQueryKey(String(r.step.searchQuery ?? ''));
            if (key) executedQueries.add(key);
        });

        while (additionalRounds < maxAdditionalRounds) {
            callbacks.onStatusUpdate?.('Evaluating research gaps...');

            const evaluation = await this.evaluateResearchGaps(plan.mainQuestion, allReports);

            // Filter valid gaps
            const gaps = (evaluation.gaps || []).filter(gap => {
                if (!gap || typeof gap !== 'object') return false;
                const raw = gap as any;
                const query = typeof raw.query === 'string' ? raw.query.trim() : (typeof raw.searchQuery === 'string' ? raw.searchQuery.trim() : '');
                if (!query) return false;

                const key = normalizeQueryKey(query);
                if (!key || executedQueries.has(key)) return false;

                return true;
            }).map((gap: any, i) => ({
                id: plan.steps.length + allReports.length + i + 1,
                question: gap.question || `Follow-up: ${gap.query}`,
                searchQuery: gap.query || gap.searchQuery,
                purpose: gap.purpose || 'Fill knowledge gap',
                status: 'pending' as const
            }));

            if (!evaluation.needsMore || gaps.length === 0) {
                break;
            }

            // Execute gaps
            gaps.forEach(g => executedQueries.add(normalizeQueryKey(g.searchQuery!)));
            callbacks.onStatusUpdate?.(`Found ${gaps.length} gaps. Researching...`);

            const additionalReports = await runParallelResearch(
                gaps,
                this.chatClient,
                this.exaClient,
                {
                    onStatusUpdate: (statuses) => {
                        callbacks.onSubAgentStatus?.(statuses);
                    }
                },
                {
                    expandSources: subAgentExpandSources,
                    numResults: subAgentNumResults,
                    expansionCandidates: subAgentExpansionCandidates,
                    maxExpandedUrls: subAgentMaxExpandedUrls,
                    maxSearchRounds: subAgentMaxSearchRounds,
                    sourceTextChars: subAgentSourceTextChars,
                    expandedTextChars: subAgentExpandedTextChars,
                    maxTotalSourceChars: subAgentMaxTotalSourceChars,
                    concurrency: envPositiveInt(process.env.SUBAGENT_CONCURRENCY, gaps.length),
                }
            );

            allReports = [...allReports, ...additionalReports];
            additionalRounds++;
        }

        // Synthesize report
        callbacks.onStatusUpdate?.('Synthesizing report...');

        const synthesisContext = this.buildSynthesisContext(plan.mainQuestion, allReports);
        const synthMessages = [
            { role: 'system' as const, content: this.getSynthesisPrompt() },
            { role: 'user' as const, content: synthesisContext },
        ];

        let report = '';
        const shouldStream = Boolean(this.config.streamOutput && process.env.STREAM_OUTPUT !== '0');

        if (shouldStream) {
            const result = await this.chatClient.chatStreamWithReasoning(this.model, synthMessages, {
                ...modelOptions,
                includeReasoning: true,
            });

            for await (const event of result) {
                if (event.type === 'reasoning') {
                    const summary = await summarizer.addReasoning(event.text);
                    if (summary) callbacks.onReasoning?.(summary);
                } else if (event.type === 'content') {
                    if (report === '') {
                        const finalThought = await summarizer.flush();
                        if (finalThought) callbacks.onReasoning?.(finalThought);
                    }
                    report += event.text;
                    callbacks.onStreamOutput?.(event.text);
                }
            }
        } else {
            const response = await this.chatClient.chat(this.model, synthMessages, modelOptions);
            report = response.choices[0]?.message?.content || '';
        }

        // Verification pass: fact-check claims against sources
        callbacks.onStatusUpdate?.('Verifying claims against sources...');
        const allSources = allReports.flatMap(r => [...r.sources, ...(r.expandedSources || [])]);
        const factChecker = new FactChecker(this.chatClient);
        const verification = await factChecker.verify(report, allSources);

        // Append verification summary to report
        if (verification.totalClaims > 0) {
            const verificationMarkdown = factChecker.formatAsMarkdown(verification);
            report += verificationMarkdown;
        }

        return { markdown: report, reportTopics: allReports };
    }

    /**
     * Run a deep research report (combines planning + execution)
     * Kept for backwards compatibility; use createResearchPlan + executeResearchPlan for interactive editing
     */
    async runDeepResearch(
        topic: string,
        callbacks: AgentCallbacks = {},
        options: { dryRun?: boolean } = {}
    ): Promise<DeepResearchResult> {
        const { plan, summarizer } = await this.createResearchPlan(topic, callbacks);
        return this.executeResearchPlan(plan, callbacks, { ...options, summarizer });
    }

    /**
     * Run a quick answer (Search + Think)
     */
    async runQuickAnswer(
        query: string,
        callbacks: AgentCallbacks = {}
    ): Promise<ResearchResult> {
        const showToolCalls = this.shouldShowToolCalls();
        const streamAnswer = Boolean(this.config.streamOutput && process.env.STREAM_OUTPUT !== '0');

        // Web Search
        const searchResult = await this.searchWeb(query, callbacks, { showToolCalls });

        // Contextual Answer
        return this.analyzeWithContext(query, searchResult, callbacks, { showToolCalls, streamAnswer });
    }

    private async searchWeb(
        query: string,
        callbacks: AgentCallbacks,
        options: { showToolCalls?: boolean } = {}
    ): Promise<{ text: string; citations: Annotation[] }> {
        const showToolCalls = Boolean(options.showToolCalls);
        const maxResults = envPositiveInt(process.env.AGENT_WEB_MAX_RESULTS, 5);

        try {
            let finalResponse: any | undefined;

            for await (const event of this.responsesClient.createStream({
                model: this.model,
                input: query,
                plugins: [{ id: 'web', max_results: maxResults }],
            })) {
                if (showToolCalls) callbacks.onToolCall?.(event);

                if (event.type === 'response.completed' && event.response) {
                    finalResponse = event.response;
                    break;
                }
            }

            if (!finalResponse) {
                return await this.responsesClient.searchWeb(this.model, query, maxResults);
            }

            return this.responsesClient.extractTextAndCitations(finalResponse);
        } catch (error) {
            // If web search fails, return empty result (allow fallback to reasoning only)
            console.error('[WebSearch Error]', error);
            return { text: '', citations: [] };
        }
    }

    private async analyzeWithContext(
        query: string,
        searchResult: { text: string; citations: Annotation[] },
        callbacks: AgentCallbacks,
        options: { showToolCalls?: boolean; streamAnswer?: boolean } = {}
    ): Promise<ResearchResult> {
        const streamAnswer = Boolean(options.streamAnswer);
        const showToolCalls = Boolean(options.showToolCalls);
        const modelOptions = this.getModelChatOptions();

        const context = searchResult.text
            ? `Web research:\n\n${searchResult.text}\n\nAnswer: ${query}`
            : query; // Simple query if no search results

        try {
            let finalResponse: any | undefined;
            let answerText = '';
            let startedOutput = false;
            let fallbackReasoning: string[] | undefined;

            for await (const event of this.responsesClient.createStream({
                model: this.model,
                input: context,
                reasoning: { effort: this.config.modelReasoningEffort },
            })) {
                if (showToolCalls) callbacks.onToolCall?.(event);

                if (
                    (event.type === 'response.output_text.delta' || event.type === 'response.content_part.delta') &&
                    typeof event.delta === 'string'
                ) {
                    if (!startedOutput) startedOutput = true;
                    answerText += event.delta;
                    if (streamAnswer) callbacks.onStreamOutput?.(event.delta);
                }

                if (event.type === 'response.completed' && event.response) {
                    finalResponse = event.response;
                    break;
                }
            }

            // Handling case where stream didn't yield text or failed
            if (answerText.trim().length === 0) {
                const extracted = finalResponse
                    ? this.responsesClient.extractTextAndCitations(finalResponse)
                    : { text: '', citations: [] };

                if (extracted.text?.trim()) {
                    answerText = extracted.text;
                } else {
                    // Fallback reasoning call
                    const fallback = await this.responsesClient.reason(this.model, context, this.config.modelReasoningEffort);
                    answerText = fallback.text;
                    fallbackReasoning = fallback.reasoning;
                }

                // If we weren't streaming but now have text, send it
                if (streamAnswer && !startedOutput && answerText.trim()) {
                    callbacks.onStreamOutput?.(answerText);
                }
            }

            const sources = searchResult.citations
                ? [...new Set(searchResult.citations.map(c => c.url))]
                : [];

            return {
                text: answerText,
                sources,
                reasoning: fallbackReasoning ??
                    ((finalResponse?.output?.find((o: any) => o.type === 'reasoning')?.summary as string[] | undefined) ?? undefined)
            };

        } catch {
            // Fallback to standard chat
            const messages = [
                { role: 'system' as const, content: 'You are a helpful research assistant. Provide comprehensive, well-structured answers.' },
                { role: 'user' as const, content: context },
            ];

            if (streamAnswer) {
                let text = '';
                for await (const chunk of this.chatClient.chatStream(this.model, messages, modelOptions)) {
                    callbacks.onStreamOutput?.(chunk);
                    text += chunk;
                }

                const sources = searchResult.citations ? [...new Set(searchResult.citations.map(c => c.url))] : [];
                return { text, sources };
            } else {
                const response = await this.chatClient.chat(this.model, messages, modelOptions);
                const text = response.choices[0]?.message?.content || '';
                const sources = searchResult.citations ? [...new Set(searchResult.citations.map(c => c.url))] : [];
                return { text, sources };
            }
        }
    }

    private async evaluateResearchGaps(
        mainQuestion: string,
        reports: SubAgentReport[]
    ): Promise<{ needsMore: boolean; gaps: any[] }> {
        const maxGaps = envPositiveInt(process.env.AGENT_MAX_GAPS_PER_ROUND, 5);

        const summaries = reports.map((r, i) => {
            const sourceCount = r.sources.length + (r.expandedSources?.length || 0);
            const didFail = r.summary.includes('Sub-agent failed to complete');
            const topInsights = r.keyInsights.slice(0, 3).filter(Boolean);

            const findings = didFail
                ? 'Status: FAILED (agent error)'
                : topInsights.length > 0
                    ? `Key findings: ${topInsights.join('; ')}`
                    : sourceCount === 0
                        ? 'Key findings: (no sources found)'
                        : 'Key findings: (no bullet insights extracted)';

            return `Topic ${i + 1}: ${r.step.question}\nQuery: ${r.step.searchQuery}\nSources: ${sourceCount}\n${findings}`;
        }).join('\n\n');

        const evaluationPrompt = `You are reviewing research findings to determine if they are comprehensive enough.

Main Question: "${mainQuestion}"

Research Completed:
${summaries}

Evaluate:
1. Are there critical gaps or unanswered questions that would significantly improve the report?
2. Are there contradictions that need resolution with additional sources?
3. Is there insufficient depth on any crucial aspect?

Important constraints:
- Do NOT suggest a query that duplicates any "Query:" already listed above.
- Ensure each suggested "query" is unique and non-empty.

If the research is comprehensive, respond with exactly: {"needsMore": false, "gaps": []}

If more research is needed, respond with JSON like:
{
  "needsMore": true,
  "gaps": [
    {"question": "What specific data shows...", "query": "search query for exa", "purpose": "To fill gap in..."}
  ]
}

Maximum ${maxGaps} gaps. Only suggest if truly necessary for a quality report. Be conservative.
Respond ONLY with JSON.`;

        try {
            const response = await this.chatClient.chat(this.model, [
                { role: 'system', content: 'You evaluate research completeness. Respond only with JSON.' },
                { role: 'user', content: evaluationPrompt },
            ], { temperature: 0.3 });

            const content = response.choices[0]?.message?.content?.trim() || '';
            const jsonMatch = content.match(/\{[\s\S]*\}/);

            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    needsMore: Boolean(parsed.needsMore),
                    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, maxGaps) : [],
                };
            }
        } catch (error) {
            console.error('[GapAnalysis Error]', error);
        }

        return { needsMore: false, gaps: [] };
    }

    private buildSynthesisContext(mainQuestion: string, reports: SubAgentReport[]): string {
        const sections: string[] = [];
        sections.push(`Main Research Question: "${mainQuestion}"\n`);
        sections.push('Below are the findings from parallel research on each sub-topic:\n');
        sections.push('---\n');

        reports.forEach((report, index) => {
            sections.push(`## Research Topic ${index + 1}: ${report.step.question}`);
            sections.push(`Purpose: ${report.step.purpose}\n`);
            sections.push(report.summary);
            sections.push('\n---\n');
        });

        sections.push('\nPlease synthesize all these findings into a comprehensive, well-structured research report.');

        return sections.join('\n');
    }

    private getSynthesisPrompt(): string {
        return `You are a senior research analyst synthesizing findings from multiple research threads into a comprehensive report.

Your task:
1. Integrate all sub-topic findings into a coherent narrative
2. Identify overarching themes and patterns
3. Note any contradictions or uncertainties
4. Provide clear conclusions and insights

Structure your report with:
- Executive Summary (2-3 paragraphs)
- Key Findings (organized by theme, not by sub-topic)
- Detailed Analysis
- Implications and Future Outlook
- Conclusion

Write in a professional, analytical tone. Be specific with data, quotes, and citations where available.
Do not simply concatenate the sub-reports - synthesize them into something greater than the sum of its parts.`;
    }

    private getModelChatOptions(): ChatOptions {
        const options: ChatOptions = {};

        if (typeof this.config.modelMaxTokens === 'number') options.maxTokens = this.config.modelMaxTokens;
        if (typeof this.config.modelTemperature === 'number') options.temperature = this.config.modelTemperature;
        if (typeof this.config.modelTopP === 'number') options.topP = this.config.modelTopP;
        if (typeof this.config.modelTopK === 'number') options.topK = this.config.modelTopK;
        if (typeof this.config.modelSeed === 'number') options.seed = this.config.modelSeed;
        if (typeof this.config.modelFrequencyPenalty === 'number') options.frequencyPenalty = this.config.modelFrequencyPenalty;
        if (typeof this.config.modelPresencePenalty === 'number') options.presencePenalty = this.config.modelPresencePenalty;

        options.reasoning = { effort: this.config.modelReasoningEffort };

        return options;
    }

    private shouldShowToolCalls(): boolean {
        const val = process.env.SHOW_TOOL_CALLS;
        if (val === undefined) return true;
        const normalized = val.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }
}

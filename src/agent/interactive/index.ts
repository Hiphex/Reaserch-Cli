/**
 * Deep Research Agent - Unified interactive experience
 * Automatically thinks + searches, with fallback for non-reasoning models
 */

import inquirer from 'inquirer';
import { OpenRouterResponsesClient, type Annotation, type StreamEvent } from '../../clients/responses.js';
import { OpenRouterClient, type ChatOptions } from '../../clients/openrouter.js';
import { ExaClient } from '../../clients/exa.js';
import { ResearchPlanner } from '../../research/planner.js';
import { ensureConfig, writeEnvVars, type Config, DEFAULTS } from '../../config.js';
import { colors, divider, icons } from '../../ui/theme.js';
import {
    createSpinner,
    renderMarkdown,
    showHeader,
    showError,
    showResearchPlan,
    showSynthesisHeader,
    showComplete,
} from '../../ui/components.js';
import { exportReport, formatChoices, getExtension, type ExportFormat } from '../../export/formats.js';
import { runParallelResearch, type SubAgentReport } from '../sub-agent.js';
import { ReasoningSummarizer } from '../../clients/summarizer.js';
import { envBool, envIntOrInfinity, envNonNegativeInt, envPositiveInt } from '../../utils/env.js';
import { AgentState, ConversationTurn, ResearchResult } from './state.js';
import { renderBox, renderInfoBox, visibleWidth, wrapText } from './ui.js';
import { getBoxInnerWidth } from '../../ui/theme.js';
import { estimateCost, formatCostBreakdown, SUMMARIZER_MODEL_ID } from '../../utils/cost-estimator.js';
import { writeFile } from 'fs/promises';

export class DeepResearchAgent {
    private responsesClient: OpenRouterResponsesClient;
    private chatClient: OpenRouterClient;
    private model: string;
    private apiKey: string;
    private config: Config;
    private turns: ConversationTurn[] = [];
    private lastQuery: string | null = null;
    private lastAnswer: ConversationTurn | null = null;
    private lastReport: { topic: string; markdown: string } | null = null;

    constructor(config: Config, model?: string) {
        this.config = config;
        this.apiKey = config.openrouterApiKey;
        this.model = model || config.defaultModel || DEFAULTS.model;
        this.responsesClient = new OpenRouterResponsesClient(this.apiKey);
        this.chatClient = new OpenRouterClient(this.apiKey);
    }

    private isEnabledEnvBool(value: string | undefined, defaultValue: boolean): boolean {
        if (value === undefined) return defaultValue;
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }

    private shouldShowToolCalls(): boolean {
        return this.isEnabledEnvBool(process.env.SHOW_TOOL_CALLS, true);
    }

    private shouldStreamAnswer(): boolean {
        return Boolean(this.config.streamOutput && process.env.STREAM_OUTPUT !== '0');
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

    /**
     * Start the interactive agent
     */
    async start(): Promise<void> {
        this.showWelcome();

        while (true) {
            const { input } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'input',
                    message: colors.primary('>'),
                },
            ]);

            const line = String(input ?? '').trim();
            if (!line) continue;

            if (line.startsWith('/')) {
                try {
                    const action = await this.handleCommand(line);
                    if (action === 'exit') return;
                } catch (error) {
                    showError(error instanceof Error ? error.message : String(error));
                }
                continue;
            }

            try {
                await this.runDeepReport(line);
            } catch (error) {
                showError(error instanceof Error ? error.message : String(error));
            }
            this.showNextHint();
        }
    }

    private showWelcome(): void {
        console.clear();
        showHeader({ title: 'Deep Research', model: this.model, showDivider: false });
        console.log();
        console.log(colors.muted('Ask any question to start researching.'));
        console.log(colors.muted('Type /help for commands, or /exit to quit.'));
        console.log();
    }

    /**
     * Run a quick answer on a query - automatically searches AND thinks
     */
    private async runQuickAnswer(query: string): Promise<void> {
        this.lastQuery = query;
        this.lastReport = null;
        console.log();
        console.log(`${colors.primary('Researching:')} ${query}`);
        console.log(colors.muted(divider()));

        const showToolCalls = this.shouldShowToolCalls();
        const streamAnswer = this.shouldStreamAnswer();

        // Phase 1: Web Search
        const searchResult = await this.searchWeb(query, { showToolCalls });

        // Phase 2: Analysis/Reasoning
        const analysisResult = await this.analyzeWithContext(query, searchResult, { showToolCalls, streamAnswer });

        // Store result
        const turn: ConversationTurn = { query, result: analysisResult };
        this.turns.push(turn);
        this.lastAnswer = turn;

        // Show result
        if (streamAnswer) {
            this.displayPostStream(analysisResult);
        } else {
            this.displayResult(analysisResult);
        }
    }

    private showHelp(): void {
        console.log();
        console.log(colors.primary('Commands'));
        console.log();
        console.log('  ' + colors.secondary('/save') + '              Export your report (PDF, Word, Markdown, etc.)');
        console.log('  ' + colors.secondary('/sources') + '           Show sources from the last report');
        console.log('  ' + colors.secondary('/new') + '               Start a fresh conversation');
        console.log('  ' + colors.secondary('/exit') + '              Quit');
        console.log();
        console.log(colors.muted('  Advanced:'));
        console.log(colors.muted('  /model             Change AI model'));
        console.log(colors.muted('  /params            Edit model parameters'));
        console.log(colors.muted('  /settings          Update defaults'));
        console.log(colors.muted('  /trace             Toggle activity display'));
        console.log(colors.muted('  /history           Show recent questions'));
        console.log(colors.muted('  /clear             Clear the screen'));
        console.log();
    }

    private showNextHint(): void {
        console.log(colors.muted('Tip: ask a follow-up, or /save to export your report.'));
        console.log();
    }

    private displayPostStream(result: ResearchResult): void {
        console.log();

        if (process.env.SHOW_REASONING === '1' && result.reasoning && result.reasoning.length > 0) {
            console.log(colors.muted('Reasoning summary (truncated):'));
            result.reasoning.slice(0, 3).forEach((step, i) => {
                const truncated = step.length > 200 ? step.slice(0, 200) + '…' : step;
                console.log(colors.muted(`  ${i + 1}. ${truncated}`));
            });
            console.log();
        }

        if (result.sources.length > 0) {
            console.log(colors.primary(`Sources (${result.sources.length})`));
            result.sources.slice(0, 5).forEach((url, i) => {
                console.log(colors.muted(`  ${i + 1}. ${url}`));
            });
            if (result.sources.length > 5) console.log(colors.muted(`  +${result.sources.length - 5} more`));
        }

        console.log(colors.muted(divider()));
    }

    private async handleCommand(line: string): Promise<'continue' | 'exit'> {
        const [rawCommand, ...rest] = line.slice(1).split(' ');
        const command = rawCommand.trim().toLowerCase();
        const args = rest.join(' ').trim();

        if (command === 'exit' || command === 'quit' || command === 'q') return 'exit';

        if (command === 'help' || command === '?') {
            this.showHelp();
            return 'continue';
        }

        if (command === 'clear' || command === 'cls') {
            this.showWelcome();
            return 'continue';
        }

        if (command === 'new' || command === 'reset') {
            this.turns = [];
            this.lastQuery = null;
            this.lastAnswer = null;
            this.lastReport = null;
            console.log(colors.success('Started a new conversation.'));
            return 'continue';
        }

        if (command === 'model') {
            await this.chooseModel();
            return 'continue';
        }

        if (command === 'params') {
            await this.editModelParams();
            return 'continue';
        }

        if (command === 'settings') {
            await this.runSettings();
            return 'continue';
        }

        if (command === 'trace') {
            const current = this.shouldShowToolCalls();
            const next = !current;
            process.env.SHOW_TOOL_CALLS = next ? '1' : '0';
            await writeEnvVars({ SHOW_TOOL_CALLS: next ? '1' : '0' });
            console.log(colors.success(`Tool-call/activity display: ${next ? 'on' : 'off'}`));
            return 'continue';
        }

        if (command === 'report') {
            const topic = args || await this.promptText('Report topic', this.lastQuery ?? undefined);
            await this.runDeepReport(topic);
            this.showNextHint();
            return 'continue';
        }

        if (command === 'save') {
            await this.saveLastOutput();
            return 'continue';
        }

        if (command === 'history') {
            this.showHistory();
            return 'continue';
        }

        if (command === 'sources') {
            this.showLastSources();
            return 'continue';
        }

        console.log(colors.warning(`Unknown command: /${command}`));
        console.log(colors.muted('Type /help to see available commands.'));
        return 'continue';
    }

    private async editModelParams(): Promise<void> {
        const spinner = createSpinner('Fetching model details...');
        spinner.start();
        const models = await this.chatClient.listModels();
        spinner.stop();

        const current = models.find((m) => m.id === this.model);
        const supported = new Set<string>((current?.supportedParameters ?? []).map((p) => String(p)));

        const currentValue = (value: number | undefined): string => (typeof value === 'number' ? String(value) : '');
        const isSupported = (param: string): boolean => supported.size === 0 || supported.has(param);

        const notes: string[] = [];
        const paramLines: string[] = [
            `Model: ${this.model}`,
            `Supported params: ${current?.supportedParameters?.length ? current.supportedParameters.join(', ') : 'unknown'}`,
            '',
            `MODEL_MAX_TOKENS=${currentValue(this.config.modelMaxTokens)}${isSupported('max_tokens') ? '' : ' (unsupported)'}`,
            `MODEL_TEMPERATURE=${currentValue(this.config.modelTemperature)}${isSupported('temperature') ? '' : ' (unsupported)'}`,
            `MODEL_TOP_P=${currentValue(this.config.modelTopP)}${isSupported('top_p') ? '' : ' (unsupported)'}`,
            `MODEL_TOP_K=${currentValue(this.config.modelTopK)}${isSupported('top_k') ? '' : ' (unsupported)'}`,
            `MODEL_SEED=${currentValue(this.config.modelSeed)}${isSupported('seed') ? '' : ' (unsupported)'}`,
            `MODEL_FREQUENCY_PENALTY=${currentValue(this.config.modelFrequencyPenalty)}${isSupported('frequency_penalty') ? '' : ' (unsupported)'}`,
            `MODEL_PRESENCE_PENALTY=${currentValue(this.config.modelPresencePenalty)}${isSupported('presence_penalty') ? '' : ' (unsupported)'}`,
        ];

        console.log();
        console.log(colors.primary('Model params'));
        console.log(colors.muted(divider()));
        paramLines.forEach((l) => console.log(colors.muted(l)));

        if (notes.length > 0) {
            console.log();
            notes.forEach((n) => console.log(colors.muted(n)));
        }

        console.log();
        console.log(colors.muted('Tip: press enter to keep a value, or type `default` to clear it.'));

        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'MODEL_MAX_TOKENS',
                message: 'Max tokens',
                default: currentValue(this.config.modelMaxTokens),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) && Number.isInteger(n) && n > 0
                        ? true
                        : 'Enter a positive integer or `default`';
                },
            },
            {
                type: 'input',
                name: 'MODEL_TEMPERATURE',
                message: 'Temperature',
                default: currentValue(this.config.modelTemperature),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) && n >= 0 ? true : 'Enter a number (>= 0) or `default`';
                },
            },
            {
                type: 'input',
                name: 'MODEL_TOP_P',
                message: 'Top-p',
                default: currentValue(this.config.modelTopP),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) && n >= 0 && n <= 1 ? true : 'Enter a number between 0 and 1, or `default`';
                },
            },
            {
                type: 'input',
                name: 'MODEL_TOP_K',
                message: 'Top-k',
                default: currentValue(this.config.modelTopK),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) && Number.isInteger(n) && n > 0
                        ? true
                        : 'Enter a positive integer or `default`';
                },
            },
            {
                type: 'input',
                name: 'MODEL_SEED',
                message: 'Seed',
                default: currentValue(this.config.modelSeed),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) && Number.isInteger(n) ? true : 'Enter an integer or `default`';
                },
            },
            {
                type: 'input',
                name: 'MODEL_FREQUENCY_PENALTY',
                message: 'Frequency penalty',
                default: currentValue(this.config.modelFrequencyPenalty),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) ? true : 'Enter a number or `default`';
                },
            },
            {
                type: 'input',
                name: 'MODEL_PRESENCE_PENALTY',
                message: 'Presence penalty',
                default: currentValue(this.config.modelPresencePenalty),
                validate: (input: string) => {
                    const v = input.trim().toLowerCase();
                    if (v === '' || v === 'default') return true;
                    const n = Number(v);
                    return Number.isFinite(n) ? true : 'Enter a number or `default`';
                },
            },
        ]);

        const updates: Record<string, string> = {};
        const unsupportedSet: string[] = [];

        const setNumber = (
            envKey: string,
            value: string,
            requestParam: string,
            current: number | undefined,
            setter: (v: number | undefined) => void,
            toNumber: (v: string) => number
        ) => {
            const trimmed = value.trim();
            if (trimmed === '') return; // keep existing
            if (trimmed.toLowerCase() === 'default') {
                if (current !== undefined) updates[envKey] = '';
                setter(undefined);
                return;
            }

            const parsed = toNumber(trimmed);
            if (current === parsed) return;
            updates[envKey] = String(parsed);
            setter(parsed);
            if (!isSupported(requestParam)) unsupportedSet.push(envKey);
        };

        setNumber(
            'MODEL_MAX_TOKENS',
            String(answers.MODEL_MAX_TOKENS ?? ''),
            'max_tokens',
            this.config.modelMaxTokens,
            (v) => (this.config.modelMaxTokens = v),
            (v) => Math.trunc(Number(v))
        );
        setNumber(
            'MODEL_TEMPERATURE',
            String(answers.MODEL_TEMPERATURE ?? ''),
            'temperature',
            this.config.modelTemperature,
            (v) => (this.config.modelTemperature = v),
            (v) => Number(v)
        );
        setNumber(
            'MODEL_TOP_P',
            String(answers.MODEL_TOP_P ?? ''),
            'top_p',
            this.config.modelTopP,
            (v) => (this.config.modelTopP = v),
            (v) => Number(v)
        );
        setNumber(
            'MODEL_TOP_K',
            String(answers.MODEL_TOP_K ?? ''),
            'top_k',
            this.config.modelTopK,
            (v) => (this.config.modelTopK = v),
            (v) => Math.trunc(Number(v))
        );
        setNumber(
            'MODEL_SEED',
            String(answers.MODEL_SEED ?? ''),
            'seed',
            this.config.modelSeed,
            (v) => (this.config.modelSeed = v),
            (v) => Math.trunc(Number(v))
        );
        setNumber(
            'MODEL_FREQUENCY_PENALTY',
            String(answers.MODEL_FREQUENCY_PENALTY ?? ''),
            'frequency_penalty',
            this.config.modelFrequencyPenalty,
            (v) => (this.config.modelFrequencyPenalty = v),
            (v) => Number(v)
        );
        setNumber(
            'MODEL_PRESENCE_PENALTY',
            String(answers.MODEL_PRESENCE_PENALTY ?? ''),
            'presence_penalty',
            this.config.modelPresencePenalty,
            (v) => (this.config.modelPresencePenalty = v),
            (v) => Number(v)
        );

        if (unsupportedSet.length > 0) {
            const { confirm } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Save unsupported params for ${this.model}? (${unsupportedSet.join(', ')})`,
                    default: false,
                },
            ]);
            if (!confirm) {
                console.log(colors.muted('Canceled.'));
                return;
            }
        }

        if (Object.keys(updates).length === 0) {
            console.log(colors.muted('No changes.'));
            return;
        }

        await writeEnvVars(updates);
        console.log(colors.success('Saved model params to .env'));
    }

    private async promptText(label: string, defaultValue?: string): Promise<string> {
        const { value } = await inquirer.prompt([
            {
                type: 'input',
                name: 'value',
                message: label,
                default: defaultValue,
                validate: (input: string) => input.trim().length > 0 || 'Required',
            },
        ]);
        return String(value ?? '').trim();
    }

    private async chooseModel(): Promise<void> {
        const spinner = createSpinner('Fetching OpenRouter models...');
        spinner.start();
        const models = await this.chatClient.listModels();
        spinner.stop();

        const { selectModelQuick } = await import('../../ui/model-selector.js');
        const selected = await selectModelQuick(models, { currentModel: this.model, showDetails: true });
        this.model = selected.id;

        const { save } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'save',
                message: 'Save as default model?',
                default: true,
            },
        ]);
        if (save) {
            await writeEnvVars({ DEFAULT_MODEL: this.model });
            console.log(colors.success(`Saved DEFAULT_MODEL=${this.model}`));
        }

        showHeader({ title: 'Deep Research Agent', model: this.model, showDivider: false });
        console.log(colors.muted(divider()));
    }

    private async runSettings(): Promise<void> {
        const updated = await ensureConfig(
            { exa: false, openrouter: false },
            { promptPreferences: true, preferencesMode: 'advanced' }
        );

        const apiKeyChanged = updated.openrouterApiKey && updated.openrouterApiKey !== this.apiKey;
        if (apiKeyChanged) {
            this.apiKey = updated.openrouterApiKey;
            this.responsesClient = new OpenRouterResponsesClient(this.apiKey);
            this.chatClient = new OpenRouterClient(this.apiKey);
        }

        this.config = updated;
        this.model = updated.defaultModel || this.model;

        console.log(colors.success('Updated settings.'));
        showHeader({ title: 'Deep Research Agent', model: this.model, showDivider: false });
        console.log(colors.muted(divider()));
    }

    /**
     * Search the web for information
     */
    private async searchWeb(
        query: string,
        options: { showToolCalls?: boolean } = {}
    ): Promise<{ text: string; citations: Annotation[] }> {
        const showToolCalls = Boolean(options.showToolCalls);
        const maxResults = envPositiveInt(process.env.AGENT_WEB_MAX_RESULTS, 5);
        const spinner = createSpinner('Web search (OpenRouter)…');
        spinner.start();

        if (showToolCalls) {
            spinner.stop();
            console.log(colors.muted(`${icons.search} Tool: web search (OpenRouter web plugin)`));
            spinner.start();
        }

        try {
            let finalResponse: any | undefined;
            let receivedAnyText = false;
            let outputChars = 0;

            for await (const event of this.responsesClient.createStream({
                model: this.model,
                input: query,
                plugins: [{ id: 'web', max_results: maxResults }],
            })) {
                this.maybeLogToolEvent(event, spinner, showToolCalls);

                if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
                    spinner.text = 'Web search: summarizing sources…';
                }

                if (
                    (event.type === 'response.output_text.delta' || event.type === 'response.content_part.delta') &&
                    typeof event.delta === 'string'
                ) {
                    receivedAnyText = true;
                    outputChars += event.delta.length;
                    if (outputChars === event.delta.length) {
                        spinner.text = 'Web search: summarizing sources…';
                    } else if (outputChars > 1500 && outputChars % 500 < event.delta.length) {
                        spinner.text = `Web search: summarizing sources… (${outputChars} chars)`;
                    }
                }

                if (event.type === 'response.completed' && event.response) {
                    finalResponse = event.response;
                    break;
                }
            }

            if (!finalResponse) {
                const fallback = await this.responsesClient.searchWeb(this.model, query, maxResults);
                spinner.succeed(colors.success(fallback.citations.length > 0 ? `Web: ${fallback.citations.length} sources` : 'Web search complete'));
                return fallback;
            }

            const extracted = this.responsesClient.extractTextAndCitations(finalResponse);
            if (!receivedAnyText && extracted.text.trim().length === 0) {
                spinner.warn(colors.warning('Web search returned no text; answering without sources'));
            } else {
                spinner.succeed(
                    colors.success(extracted.citations.length > 0 ? `Web: ${extracted.citations.length} sources` : 'Web search complete')
                );
            }

            return extracted;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            spinner.warn(colors.warning('Web search unavailable (OpenRouter web plugin); continuing without web sources'));
            if (showToolCalls) {
                const preview = message.length > 240 ? message.slice(0, 240).trimEnd() + '…' : message;
                console.log(colors.muted(`${icons.arrow} ${preview}`));
                console.log(colors.muted(`${icons.arrow} Note: this is separate from Exa (deep reports use EXA_API_KEY).`));
            }
            return { text: '', citations: [] };
        }
    }

    /**
     * Analyze with reasoning (falls back to regular chat for non-reasoning models)
     */
    private async analyzeWithContext(
        query: string,
        searchResult: { text: string; citations: Annotation[] },
        options: { showToolCalls?: boolean; streamAnswer?: boolean } = {}
    ): Promise<ResearchResult> {
        const showToolCalls = Boolean(options.showToolCalls);
        const streamAnswer = Boolean(options.streamAnswer);
        const modelOptions = this.getModelChatOptions();
        const spinner = createSpinner('Answer: thinking…');
        spinner.start();

        const truncate = (text: string, maxChars: number): string => {
            if (text.length <= maxChars) return text;
            return text.slice(0, maxChars).trimEnd() + '…';
        };

        const recentTurns = this.turns.slice(-2);
        const recentContext = recentTurns.length > 0
            ? recentTurns
                .map((t) => `Q: ${t.query}\nA: ${truncate(t.result.text, 800)}`)
                .join('\n\n')
            : '';

        const questionBlock = recentContext ? `Conversation context:\n${recentContext}\n\nNew question: ${query}` : query;

        const context = searchResult.text
            ? `${recentContext ? `Conversation context:\n${recentContext}\n\n` : ''}Web research:\n\n${searchResult.text}\n\nAnswer: ${query}`
            : questionBlock;

        try {
            // Try Responses API with reasoning (streamed)
            let finalResponse: any | undefined;
            let answerText = '';
            let startedOutput = false;
            let fallbackReasoning: string[] | undefined;

            for await (const event of this.responsesClient.createStream({
                model: this.model,
                input: context,
                reasoning: { effort: this.config.modelReasoningEffort },
            })) {
                this.maybeLogToolEvent(event, spinner, showToolCalls);

                if (
                    event.type === 'response.output_item.added' &&
                    (event.item?.type === 'reasoning' || event.item?.type === 'message')
                ) {
                    if (event.item?.type === 'reasoning') spinner.text = 'Answer: thinking…';
                    if (event.item?.type === 'message' && !startedOutput) spinner.text = 'Answer: writing…';
                }

                if (event.type === 'response.reasoning_text.delta') {
                    spinner.text = 'Answer: thinking…';
                }

                if (
                    (event.type === 'response.output_text.delta' || event.type === 'response.content_part.delta') &&
                    typeof event.delta === 'string'
                ) {
                    if (!startedOutput) {
                        startedOutput = true;
                        if (streamAnswer) {
                            spinner.stop();
                            console.log();
                            console.log(colors.primary('Answer'));
                            console.log(colors.muted(divider()));
                        } else {
                            spinner.text = 'Answer: writing…';
                        }
                    }

                    answerText += event.delta;
                    if (streamAnswer) process.stdout.write(event.delta);
                }

                if (event.type === 'response.completed' && event.response) {
                    finalResponse = event.response;
                    break;
                }
            }

            if (streamAnswer && startedOutput && !answerText.endsWith('\n')) process.stdout.write('\n');
            if (spinner.isSpinning) spinner.succeed(colors.success('Answer complete'));

            const extracted = finalResponse
                ? this.responsesClient.extractTextAndCitations(finalResponse)
                : { text: '', citations: [] };
            if (answerText.trim().length === 0 && extracted.text?.trim?.().length) {
                answerText = extracted.text;
            }

            if (answerText.trim().length === 0) {
                // Fallback if the stream didn't surface text for this model.
                const fallback = await this.responsesClient.reason(this.model, context, this.config.modelReasoningEffort);
                answerText = fallback.text;
                fallbackReasoning = fallback.reasoning;
                finalResponse = undefined;
            }

            if (streamAnswer && !startedOutput && answerText.trim().length > 0) {
                if (spinner.isSpinning) spinner.stop();
                console.log();
                console.log(colors.primary('Answer'));
                console.log(colors.muted(divider()));
                process.stdout.write(answerText);
                if (!answerText.endsWith('\n')) process.stdout.write('\n');
            }

            const sources = searchResult.citations
                ? [...new Set(searchResult.citations.map(c => c.url))]
                : [];

            return {
                text: answerText,
                sources,
                reasoning:
                    fallbackReasoning ??
                    ((finalResponse?.output?.find((o: any) => o.type === 'reasoning')?.summary as string[] | undefined) ??
                        undefined),
            };
        } catch {
            // Fallback to regular chat for non-reasoning models
            spinner.text = 'Answer: generating…';

            try {
                const messages = [
                    { role: 'system', content: 'You are a helpful research assistant. Provide comprehensive, well-structured answers.' },
                    { role: 'user', content: context },
                ] as const;

                const shouldStream = streamAnswer;
                let text = '';

                if (shouldStream) {
                    spinner.stop();
                    console.log();
                    console.log(colors.primary('Answer'));
                    console.log(colors.muted(divider()));

                    for await (const chunk of this.chatClient.chatStream(this.model, [...messages], modelOptions)) {
                        process.stdout.write(chunk);
                        text += chunk;
                    }
                    if (!text.endsWith('\n')) process.stdout.write('\n');
                } else {
                    const chatResponse = await this.chatClient.chat(this.model, [...messages], modelOptions);
                    text = chatResponse.choices[0]?.message?.content || '';
                }

                if (spinner.isSpinning) spinner.succeed(colors.success('Answer complete'));

                const sources = searchResult.citations
                    ? [...new Set(searchResult.citations.map(c => c.url))]
                    : [];

                return {
                    text,
                    sources,
                };
            } catch (chatError) {
                spinner.fail(colors.error('Failed to generate response'));
                throw chatError;
            }
        }
    }

    /**
     * Display the research result
     */
    private displayResult(result: ResearchResult): void {
        console.log();

        if (process.env.SHOW_REASONING === '1' && result.reasoning && result.reasoning.length > 0) {
            console.log(colors.muted('Reasoning (truncated):'));
            result.reasoning.slice(0, 3).forEach((step, i) => {
                const truncated = step.length > 200 ? step.slice(0, 200) + '…' : step;
                console.log(colors.muted(`  ${i + 1}. ${truncated}`));
            });
            console.log();
        }

        console.log(colors.primary('Answer'));
        console.log(colors.muted(divider()));
        const shouldRenderMarkdown = process.env.RENDER_MARKDOWN !== '0';
        if (shouldRenderMarkdown) {
            process.stdout.write(renderMarkdown(result.text));
            if (!result.text.endsWith('\n')) process.stdout.write('\n');
        } else {
            console.log(result.text);
        }

        // Show sources
        if (result.sources.length > 0) {
            console.log();
            console.log(colors.primary(`Sources (${result.sources.length})`));
            result.sources.slice(0, 5).forEach((url, i) => {
                console.log(colors.muted(`  ${i + 1}. ${url}`));
            });
            if (result.sources.length > 5) console.log(colors.muted(`  +${result.sources.length - 5} more`));
        }

        console.log(colors.muted(divider()));
    }

    private maybeLogToolEvent(event: StreamEvent, spinner: { isSpinning: boolean; stop: () => void; start: () => void }, enabled: boolean): void {
        if (!enabled) return;
        if (event.type !== 'response.output_item.added') return;

        const itemType = event.item?.type;
        if (itemType !== 'function_call') return;

        const name = String(event.item?.name || 'unknown');
        const rawArgs = typeof event.item?.arguments === 'string' ? event.item.arguments : '';

        let argsPreview = '';
        try {
            const parsed = rawArgs ? JSON.parse(rawArgs) : {};
            argsPreview = Object.keys(parsed).length ? ` ${colors.muted(JSON.stringify(parsed))}` : '';
        } catch {
            argsPreview = rawArgs ? ` ${colors.muted(rawArgs.slice(0, 120))}` : '';
        }

        const wasSpinning = spinner.isSpinning;
        if (wasSpinning) spinner.stop();
        console.log(colors.muted(`${icons.arrow} Tool call: ${name}${argsPreview}`));
        if (wasSpinning) spinner.start();
    }

    public async runDeepReport(query: string, options: { dryRun?: boolean; output?: string } = {}): Promise<void> {
        this.lastQuery = query;
        const updated = await ensureConfig({ exa: true, openrouter: true });

        const apiKeyChanged = updated.openrouterApiKey && updated.openrouterApiKey !== this.apiKey;
        if (apiKeyChanged) {
            this.apiKey = updated.openrouterApiKey;
            this.responsesClient = new OpenRouterResponsesClient(this.apiKey);
            this.chatClient = new OpenRouterClient(this.apiKey);
        }

        this.config = updated;

        const exaClient = new ExaClient(updated.exaApiKey);
        const modelOptions = this.getModelChatOptions();

        // Show query (welcome header already displayed model info)
        console.log();
        console.log(colors.primary(`Researching: "${query.slice(0, 60)}${query.length > 60 ? '...' : ''}"`));
        console.log(colors.muted(divider()));

        // Initialize reasoning summarizer
        const summarizer = new ReasoningSummarizer(this.chatClient);

        // Phase 1: Planning with Gemini-based reasoning summaries
        console.log();
        console.log(`${colors.muted('📋 Planning research...')}`);

        const planner = new ResearchPlanner(this.chatClient, this.model, modelOptions);
        const plan = await planner.createPlanWithReasoning(query, async (reasoning) => {
            const summary = await summarizer.addReasoning(reasoning);
            if (summary) {
                console.log(`  ${colors.muted('💭')} ${colors.muted(summary)}`);
            }
        });

        // Flush any remaining reasoning
        const finalPlanThought = await summarizer.flush();
        if (finalPlanThought) {
            console.log(`  ${colors.muted('💭')} ${colors.muted(finalPlanThought)}`);
        }
        summarizer.reset();

        console.log(`${colors.success('✓')} Plan ready (${plan.steps.length} research steps)`);

        showResearchPlan(plan);

        // Cost estimation (if dry-run or requested via interactive command in future)
        if (options.dryRun) {
            const models = await this.chatClient.listModels();
            const mainModel = models.find(m => m.id === this.model);
            const summarizerModel = models.find(m => m.id === SUMMARIZER_MODEL_ID);

            const costEstimate = estimateCost(mainModel, summarizerModel, {
                numSteps: plan.steps.length,
                numFollowUps: this.config.autoFollowup ? 2 : 0, // estimate for a couple rounds
            });

            console.log();
            console.log(colors.primary('Cost Estimate'));
            console.log(colors.muted(formatCostBreakdown(costEstimate)));
            console.log();
            console.log(colors.muted('Dry run complete. No searches executed.'));
            return;
        }

        // Phase 2: Parallel sub-agent research with in-place status updates
        console.log();

        // Agent status tracking
        const agentStates: AgentState[] = plan.steps.map(step => ({
            question: step.question,
            status: 'Waiting...',
            sources: 0,
            complete: false,
            failed: false,
        }));

        // Re-implementing the cursor logic locally here for now as it needs state
        let lastRender = '';
        const updateBoxWithCursor = (title: string, states: AgentState[]) => {
            const newRender = renderBox(title, states);
            if (newRender !== lastRender) {
                if (lastRender) {
                    const lines = lastRender.split('\n').length;
                    process.stdout.write(`\x1b[${lines}A\x1b[0J`);
                }
                console.log(newRender);
                lastRender = newRender;
            }
        };

        // Initial box
        updateBoxWithCursor('Sub-Agents Researching', agentStates);

        const subAgentNumResults = envPositiveInt(process.env.SUBAGENT_NUM_RESULTS, this.config.exaNumResults);
        const subAgentExpansionCandidates = envPositiveInt(process.env.SUBAGENT_EXPANSION_CANDIDATES, 8);
        const subAgentMaxExpandedUrls = envNonNegativeInt(process.env.SUBAGENT_MAX_EXPANDED_URLS, 5);
        const subAgentExpandSources = envBool(process.env.SUBAGENT_EXPAND_SOURCES, true) && subAgentMaxExpandedUrls > 0;
        const subAgentMaxSearchRounds = envPositiveInt(process.env.SUBAGENT_MAX_SEARCH_ROUNDS, 2);
        const subAgentSourceTextChars = envNonNegativeInt(process.env.SUBAGENT_SOURCE_TEXT_CHARS, 2200);
        const subAgentExpandedTextChars = envNonNegativeInt(process.env.SUBAGENT_EXPANDED_TEXT_CHARS, 4500);
        const subAgentMaxTotalSourceChars = envIntOrInfinity(process.env.SUBAGENT_MAX_TOTAL_SOURCE_CHARS, 65_000);
        const subAgentConcurrency = envPositiveInt(process.env.SUBAGENT_CONCURRENCY, plan.steps.length);

        const subAgentReports = await runParallelResearch(
            plan.steps,
            this.chatClient,
            exaClient,
            {
                onStatusUpdate: (statuses) => {
                    statuses.forEach(s => {
                        agentStates[s.index].status = s.status;
                        agentStates[s.index].complete = s.complete;
                        agentStates[s.index].sources = s.sources;
                        agentStates[s.index].failed = s.failed;
                    });
                    updateBoxWithCursor('Sub-Agents Researching', agentStates);
                },
                onProgress: () => { },
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

        // Update with actual source counts
        subAgentReports.forEach((report, i) => {
            agentStates[i].sources = report.sources.length + (report.expandedSources?.length || 0);
            agentStates[i].complete = true;
        });
        updateBoxWithCursor('Sub-Agents Researching', agentStates);

        // Final summary
        const totalSources = subAgentReports.reduce((sum, r) => sum + r.sources.length + (r.expandedSources?.length || 0), 0);
        console.log();
        console.log(`${colors.success('✓')} All ${plan.steps.length} research topics complete (${totalSources} sources)`);

        // Phase 3: Evaluate if more research needed
        let allReports = [...subAgentReports];
        const normalizeQueryKey = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();
        const executedQueries = new Set<string>();
        allReports.forEach((r) => {
            const key = normalizeQueryKey(String(r.step.searchQuery ?? ''));
            if (key) executedQueries.add(key);
        });
        let additionalRounds = 0;
        const maxAdditionalRounds = this.config.maxFollowupSteps;

        const boxWidth = getBoxInnerWidth();

        while (additionalRounds < maxAdditionalRounds) {
            console.log();
            console.log(colors.muted('🧠 Evaluating research completeness...'));

            const evaluation = await this.evaluateResearchGaps(plan.mainQuestion, allReports);

            const gaps = (() => {
                const seenQueries = new Set<string>();
                const result: Array<{ question: string; query: string; purpose: string }> = [];

                for (const gap of evaluation.gaps ?? []) {
                    if (!gap || typeof gap !== 'object') continue;
                    const raw = gap as any;

                    const query = typeof raw.query === 'string'
                        ? raw.query.trim()
                        : typeof raw.searchQuery === 'string'
                            ? raw.searchQuery.trim()
                            : '';
                    if (!query) continue;

                    const key = normalizeQueryKey(query);
                    if (!key || seenQueries.has(key) || executedQueries.has(key)) continue;
                    seenQueries.add(key);

                    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
                    const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim() : '';

                    result.push({
                        question: question || `Follow-up: ${query}`,
                        query,
                        purpose: purpose || 'Fill a remaining knowledge gap',
                    });
                }

                return result;
            })();

            if (!evaluation.needsMore || gaps.length === 0) {
                if (evaluation.needsMore && (evaluation.gaps?.length ?? 0) > 0 && gaps.length === 0) {
                    console.log(`  ${colors.success('✓')} No new actionable gaps (duplicates/already covered) - proceeding to synthesis`);
                } else {
                    console.log(`  ${colors.success('✓')} Research is comprehensive - proceeding to synthesis`);
                }
                break;
            }

            const gapLines: string[] = [];
            gaps.forEach((gap, i) => {
                const prefixPlain = `${i + 1}. `;
                const inset = '  ';
                const available = Math.max(0, boxWidth - visibleWidth(inset) - visibleWidth(prefixPlain));
                const wrapped = wrapText(gap.question, available);
                wrapped.forEach((part, idx) => {
                    const prefix = idx === 0 ? prefixPlain : ' '.repeat(prefixPlain.length);
                    gapLines.push(`${inset}${prefix}${part}`);
                });
            });
            console.log(renderInfoBox(`⚠ Gaps Found (${gaps.length})`, gapLines));

            // Convert gaps to research steps
            const gapSteps = gaps.map((gap, i) => ({
                id: plan.steps.length + i + 1,
                question: gap.question,
                searchQuery: gap.query,
                purpose: gap.purpose,
                status: 'pending' as const,
            }));
            gaps.forEach((gap) => executedQueries.add(normalizeQueryKey(gap.query)));

            // Spawn additional sub-agents with in-place updating box
            console.log();

            // Set up additional research states
            const additionalStates: AgentState[] = gapSteps.map(step => ({
                question: step.question,
                status: 'Waiting...',
                sources: 0,
                complete: false,
                failed: false,
            }));

            // Reset lastRender for new box
            lastRender = '';
            updateBoxWithCursor('Additional Research', additionalStates);

            const additionalReports = await runParallelResearch(
                gapSteps,
                this.chatClient,
                exaClient,
                {
                    onStatusUpdate: (statuses) => {
                        statuses.forEach(s => {
                            additionalStates[s.index].status = s.status;
                            additionalStates[s.index].complete = s.complete;
                            additionalStates[s.index].sources = s.sources;
                            additionalStates[s.index].failed = s.failed;
                        });
                        updateBoxWithCursor('Additional Research', additionalStates);
                    },
                    onProgress: () => { },
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
                    concurrency: envPositiveInt(process.env.SUBAGENT_CONCURRENCY, gapSteps.length),
                }
            );

            // Update with actual source counts
            additionalReports.forEach((report, i) => {
                additionalStates[i].sources = report.sources.length + (report.expandedSources?.length || 0);
                additionalStates[i].complete = true;
            });
            updateBoxWithCursor('Additional Research', additionalStates);

            allReports = [...allReports, ...additionalReports];
            additionalRounds++;

            const additionalSources = additionalReports.reduce((sum, r) => sum + r.sources.length + (r.expandedSources?.length || 0), 0);
            console.log();
            console.log(`${colors.success('✓')} Additional research complete (${additionalSources} more sources)`);
        }

        // Phase 4: Synthesize final report
        showSynthesisHeader();

        const shouldStream = this.shouldStreamAnswer();
        let report = '';

        // Build context from all reports (including additional research)
        const synthesisContext = this.buildSynthesisContext(plan.mainQuestion, allReports);

        const synthMessages = [
            { role: 'system' as const, content: this.getSynthesisPrompt() },
            { role: 'user' as const, content: synthesisContext },
        ];

        if (shouldStream) {
            // Stream the synthesis
            const result = await this.chatClient.chatStreamWithReasoning(this.model, synthMessages, {
                ...modelOptions,
                includeReasoning: true,
            });

            for await (const event of result) {
                if (event.type === 'reasoning') {
                    const summary = await summarizer.addReasoning(event.text);
                    if (summary) {
                        console.log(`  ${colors.muted('💭')} ${colors.muted(summary)}`);
                    }
                } else if (event.type === 'content') {
                    if (report === '') {
                        const finalThought = await summarizer.flush();
                        if (finalThought) {
                            console.log(`  ${colors.muted('💭')} ${colors.muted(finalThought)}`);
                        }
                        console.log(`${colors.success('✓')} Report ready`);
                        console.log();
                        console.log(colors.primary('Report'));
                        console.log(colors.muted(divider()));
                    }
                    process.stdout.write(event.text);
                    report += event.text;
                }
            }
            // Add newline after stream
            console.log();
        } else {
            const synthSpinner = createSpinner('Generating report...');
            synthSpinner.start();
            const response = await this.chatClient.chat(this.model, synthMessages, modelOptions);
            report = response.choices[0]?.message?.content || '';
            synthSpinner.stop();
            console.log(renderMarkdown(report));
        }

        // Save to file if requested
        if (options.output) {
            await writeFile(options.output, report, 'utf-8');
            showComplete(options.output);
        } else {
            // only show "Complete" if running in one-shot mode, otherwise we return to prompt
            if (options.output) showComplete(); // handled above
        }

        this.lastReport = { topic: query, markdown: report };
        // Collect all sources (including additional research)
        const sources = [
            ...new Set(
                allReports
                    .flatMap((r) => r.sources)
                    .map((s) => s.url)
                    .filter((u): u is string => typeof u === 'string' && u.length > 0)
            ),
        ];

        this.lastReport = { topic: query, markdown: report };
        const turn: ConversationTurn = { query, result: { text: report, sources } };
        this.turns.push(turn);
        this.lastAnswer = turn;

        if (sources.length > 0) {
            console.log();
            console.log(colors.primary(`Sources (${sources.length})`));
            sources.slice(0, 10).forEach((url, i) => console.log(colors.muted(`  ${i + 1}. ${url}`)));
            if (sources.length > 10) console.log(colors.muted(`  +${sources.length - 10} more`));
        }
    }

    /**
     * Show summary of sub-agent research
     */
    private showSubAgentSummary(reports: SubAgentReport[]): void {
        console.log();
        console.log(colors.muted('╭─ Research Summary ' + '─'.repeat(60) + '╮'));

        reports.forEach((r, i) => {
            const sourceCount = r.sources.length + (r.expandedSources?.length || 0);
            const question = r.step.question.slice(0, 65) + (r.step.question.length > 65 ? '...' : '');
            console.log(colors.muted('│ ') + `${colors.success('✔')} ${i + 1}/${reports.length} ${question} (${sourceCount} sources)`);
        });

        console.log(colors.muted('╰' + '─'.repeat(80) + '╯'));
    }

    /**
     * Build context for final synthesis from sub-agent reports
     */
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

    /**
     * Get the synthesis prompt
     */
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

    /**
     * Evaluate if more research is needed based on current findings
     */
    private async evaluateResearchGaps(
        mainQuestion: string,
        reports: SubAgentReport[]
    ): Promise<{ needsMore: boolean; gaps: Array<{ question: string; query: string; purpose: string }> }> {
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
        } catch {
            // If evaluation fails, proceed with synthesis
        }

        return { needsMore: false, gaps: [] };
    }

    private showHistory(): void {
        if (this.turns.length === 0) {
            console.log(colors.muted('No questions yet. Type a question to begin.'));
            return;
        }

        console.log();
        console.log(colors.primary('Recent questions'));
        console.log(colors.muted(divider()));
        this.turns.slice(-10).forEach((t, idx) => {
            const n = this.turns.length - Math.min(10, this.turns.length) + idx + 1;
            console.log(colors.muted(`${n}. `) + t.query);
        });
        console.log(colors.muted(divider()));
    }

    private showLastSources(): void {
        const sources = this.lastAnswer?.result.sources ?? [];
        if (sources.length === 0) {
            console.log(colors.muted('No sources yet. Ask a question first.'));
            return;
        }

        console.log();
        console.log(colors.primary(`All Sources (${sources.length})`));
        console.log(colors.muted(divider()));
        sources.forEach((url, i) => console.log(colors.muted(`  ${i + 1}. ${url}`)));
        console.log(colors.muted(divider()));
    }

    private async saveLastOutput(): Promise<void> {
        const hasAnswer = Boolean(this.lastAnswer?.result.text?.trim());
        const hasReport = Boolean(this.lastReport?.markdown?.trim());

        if (!hasAnswer && !hasReport) {
            console.log(colors.muted('Nothing to save yet. Ask a question first.'));
            return;
        }

        // Get the content to export
        let contents = '';
        let title = 'Research Report';

        if (hasReport) {
            contents = this.lastReport?.markdown ?? '';
            title = this.lastReport?.topic ?? 'Research Report';
        } else {
            const q = this.lastAnswer?.query ?? '';
            const a = this.lastAnswer?.result.text ?? '';
            const sources = this.lastAnswer?.result.sources ?? [];

            contents = `# ${q}\n\n${a}\n`;
            if (sources.length > 0) {
                contents += `\n## Sources\n\n${sources.map((u) => `- ${u}`).join('\n')}\n`;
            }
            title = q;
        }

        // Choose format
        console.log();
        const { format } = await inquirer.prompt([
            {
                type: 'list',
                name: 'format',
                message: 'Choose export format:',
                choices: formatChoices,
                default: 'markdown',
            },
        ]);

        // Generate filename suggestion with Gemini
        const ext = getExtension(format as ExportFormat);
        let suggestedName = '';

        try {
            const response = await this.chatClient.chat('google/gemini-2.0-flash-001', [
                { role: 'system', content: 'Generate a short, descriptive filename (3-5 words, lowercase, hyphens, no extension). Just output the filename, nothing else.' },
                { role: 'user', content: `Topic: ${title.slice(0, 100)}` },
            ], { temperature: 0.3 });

            const generated = response.choices[0]?.message?.content?.trim() || '';
            // Clean up the suggestion
            suggestedName = generated
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .replace(/\s+/g, '-')
                .slice(0, 50);
        } catch {
            // Fallback to simple name
        }

        const fallbackName = title.slice(0, 40).replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'report';
        const defaultFile = `${suggestedName || fallbackName}${ext}`;

        const { file } = await inquirer.prompt([
            {
                type: 'input',
                name: 'file',
                message: 'Filename:',
                default: defaultFile,
                validate: (input: string) => input.trim().length > 0 || 'Filename is required',
            },
        ]);

        const filename = String(file).trim();

        try {
            await exportReport(contents, {
                format: format as ExportFormat,
                outputPath: filename,
                title,
            });

            if (format === 'pdf') {
                console.log(colors.success(`Created print-ready HTML: ${filename.replace('.pdf', '.print.html')}`));
                console.log(colors.muted('Open it in your browser and print to PDF (Cmd+P → Save as PDF)'));
            } else {
                console.log(colors.success(`Saved to ${filename}`));
            }
        } catch (error) {
            console.log(colors.error(`Failed to export: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
}

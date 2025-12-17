/**
 * Deep Research Agent - Unified interactive experience
 * Automatically thinks + searches, with fallback for non-reasoning models
 */

import inquirer from 'inquirer';
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
import { SubAgentReport } from '../sub-agent.js';
import { envBool, envPositiveInt } from '../../utils/env.js';
import { AgentState, ConversationTurn, ResearchResult } from './state.js';
import { renderBox, renderInfoBox, visibleWidth, wrapText } from './ui.js';
import { getBoxInnerWidth } from '../../ui/theme.js';
import { formatCostBreakdown, SUMMARIZER_MODEL_ID } from '../../utils/cost-estimator.js';
import { writeFile } from 'fs/promises';
import { AgentCoordinator, DeepResearchResult, AgentCallbacks } from './coordinator.js';
import { StreamEvent } from '../../clients/responses.js';

export class DeepResearchAgent {
    private config: Config;
    private coordinator: AgentCoordinator;
    private turns: ConversationTurn[] = [];
    private lastQuery: string | null = null;
    private lastAnswer: ConversationTurn | null = null;
    private lastReport: { topic: string; markdown: string } | null = null;

    constructor(config: Config, model?: string) {
        this.config = config;
        this.coordinator = new AgentCoordinator(config, model);
    }

    private isEnabledEnvBool(value: string | undefined, defaultValue: boolean): boolean {
        if (value === undefined) return defaultValue;
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }

    private shouldShowToolCalls(): boolean {
        return this.isEnabledEnvBool(process.env.SHOW_TOOL_CALLS, true);
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
        showHeader({ title: 'Deep Research', model: this.coordinator.getModel(), showDivider: false });
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

        // Use coordinator.runQuickAnswer with simple callbacks; keep runQuickAnswer wrapper for compatibility
        const callbacks: AgentCallbacks = {
            onStreamOutput: (text) => process.stdout.write(text),
        };
        const result = await this.coordinator.runQuickAnswer(query, callbacks);

        // Store result
        const turn: ConversationTurn = { query, result };
        this.turns.push(turn);
        this.lastAnswer = turn;

        this.displayResult(result);
    }

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
        this.config = updated;
        this.coordinator.updateConfig(updated);

        // Show query
        console.log();
        console.log(colors.primary(`Researching: "${query.slice(0, 60)}${query.length > 60 ? '...' : ''}"`));
        console.log(colors.muted(divider()));

        console.log();
        console.log(`${colors.muted('📋 Planning research...')}`);

        // State for UI management
        let planSteps: any[] = []; // Will be populated when plan is ready
        let agentStates: AgentState[] = [];
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

        const result = await this.coordinator.runDeepResearch(query, {
            onReasoning: (text) => {
                // In phase 1 calling planner, we get reasoning
                // We could print it if we want
                // Original printed summaries
                console.log(`  ${colors.muted('💭')} ${colors.muted(text)}`);
            },
            onStatusUpdate: (status) => {
                console.log(colors.muted(status));
            },
            onSubAgentStatus: (statuses) => {
                // We need to map these statuses to our agentStates
                // Note: Coordinator passes us the statuses array
                // We need to know if we are in initial phase or additional phase to update the right box.
                // But Coordinator abstracts the loop.
                // This is where "Stateless Coordinator" vs "Rich UI" conflicts.
                // Ideally Coordinator should emit events that include "Phase" or "Step ID".

                // For now, let's blindly support a single box update or assume statuses are cumulative?
                // Actually runParallelResearch in Coordinator returns statuses for *that batch*.
                // And `agentStates` needs to track ALL steps.

                // If the coordinator passes `statuses` which contains `index`, we can update our local state.
                // However, we need to know the Total list of steps to init the box.
                // The coordinator does NOT expose the Plan explicitly before execution in `runDeepResearch`.
                // Refactoring to get the plan first would be better, OR we trust `statuses` to have enough info?
                // `statuses` has `index` which is 0-based for the batch.

                // Problem: We want the nice cursor-based box UI.
                // But we don't know the steps until Coordinator tells us?
                // Or we split `runDeepResearch` into granular calls in `index.ts`?
                // If `index.ts` calls `planner.createPlan`, then `coordinator.execute(plan)`, then `coordinator.synthesize(...)`.
                // This seems better than a monolithic `runDeepResearch` in Coordinator if we want rich UI control.

                // BUT the task was to refactor logic into Coordinator.
                // Let's settle for a simplified UI update for now, or...

                // Actually checking how `runParallelResearch` works:
                // It calls `onStatusUpdate` with `AgentStatus[]`.
                // It initializes `states` inside `runParallelResearch` for the batch.

                // If I want to maintain the "Rich UI", `runDeepResearch` inside coordinator is maybe too high level?
                // Or `runDeepResearch` should invoke callbacks with richer context.

                // Let's implement a simplified UI for now where we just print updates, or try to reconstruct the box.
                // If `statuses` is passed, we can render the box for THAT batch.

                // Let's try to render a box for whatever batch is running.
                const batchStates: AgentState[] = statuses.map(s => ({
                    question: s.question || `Step ${s.index + 1}`, // status usually doesn't carry question text unless we added it?
                    status: s.status,
                    sources: s.sources,
                    complete: s.complete,
                    failed: s.failed
                }));
                // We need the question text. `AgentStatus` has `question: string`?
                // Let's check `sub-agent.ts`.
                // Yes, `AgentStatus` has `question`.

                updateBoxWithCursor('Research Progress', batchStates);
            },
            onStreamOutput: (text) => process.stdout.write(text),
        }, { dryRun: options.dryRun });

        if (options.dryRun && result.costEstimate) {
            console.log();
            console.log(colors.primary('Cost Estimate'));
            console.log(colors.muted(formatCostBreakdown(result.costEstimate)));
            console.log();
            console.log(colors.muted('Dry run complete. No searches executed.'));
            return;
        }

        // Final output handling
        // ... (sources, saving to lastTurn etc)

        // Save to file if requested
        // Save to file if requested
        if (options.output) {
            await writeFile(options.output, result.markdown, 'utf-8');
            showComplete(options.output);
        } else {
            showComplete();
        }

        this.lastReport = { topic: query, markdown: result.markdown };
        const sources = [
            ...new Set(
                result.reportTopics
                    .flatMap((r) => r.sources)
                    .map((s) => s.url)
                    .filter((u): u is string => typeof u === 'string' && u.length > 0)
            ),
        ];

        const turn: ConversationTurn = { query, result: { text: result.markdown, sources } };
        this.turns.push(turn);
        this.lastAnswer = turn;

        if (sources.length > 0) {
            console.log();
            console.log(colors.primary(`Sources (${sources.length})`));
            sources.slice(0, 10).forEach((url, i) => console.log(colors.muted(`  ${i + 1}. ${url}`)));
            if (sources.length > 10) console.log(colors.muted(`  +${sources.length - 10} more`));
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
        const models = await this.coordinator.getChatClient().listModels();
        spinner.stop();

        const { selectModelQuick } = await import('../../ui/model-selector.js');
        const selected = await selectModelQuick(models, { currentModel: this.coordinator.getModel(), showDetails: true });
        this.coordinator.setModel(selected.id);

        const { save } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'save',
                message: 'Save as default model?',
                default: true,
            },
        ]);
        if (save) {
            await writeEnvVars({ DEFAULT_MODEL: selected.id });
            console.log(colors.success(`Saved DEFAULT_MODEL=${selected.id}`));
        }

        showHeader({ title: 'Deep Research Agent', model: selected.id, showDivider: false });
        console.log(colors.muted(divider()));
    }

    private async runSettings(): Promise<void> {
        const updated = await ensureConfig(
            { exa: false, openrouter: false },
            { promptPreferences: true, preferencesMode: 'advanced' }
        );
        this.config = updated;
        this.coordinator.updateConfig(updated);

        console.log(colors.success('Updated settings.'));
        showHeader({
            title: 'Deep Research Agent', model: this.coordinator.getModel(), showDivider: false
        });
        console.log(colors.muted(divider()));
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
            const response = await this.coordinator.getChatClient().chat('google/gemini-2.0-flash-001', [
                { role: 'system', content: 'Generate a short, descriptive filename (3-5 words, lowercase, hyphens, no extension). Just output the filename, nothing else.' },
                { role: 'user', content: `Topic: ${title.slice(0, 100)}` },
            ], { temperature: 0.3 });

            const generated = response.choices[0]?.message?.content?.trim() || '';
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

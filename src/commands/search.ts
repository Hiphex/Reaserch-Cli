import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { ensureConfig, loadConfig, validateConfig } from '../config.js';
import { ExaClient } from '../clients/exa.js';
import { OpenRouterClient, type ChatOptions } from '../clients/openrouter.js';
import { ResearchPlanner } from '../research/planner.js';
import { ResearchExecutor } from '../research/executor.js';
import { ResearchSynthesizer } from '../research/synthesizer.js';
import {
    showHeader,
    showResearchPlan,
    showProgressTree,
    showSynthesisHeader,
    showComplete,
    showError,
    createSpinner,
    streamOutput,
    renderMarkdown,
} from '../ui/components.js';
import { colors, icons } from '../ui/theme.js';
import { FOLLOW_UP_PROMPT } from '../research/prompts.js';
import { DeepResearchError } from '../errors.js';

function argvHas(flag: string): boolean {
    return process.argv.includes(flag);
}

function maybeShowSetupIntro(errors: string[]): void {
    const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!canPrompt || errors.length === 0) return;

    console.log();
    console.log(colors.primary('Quick setup'));
    console.log(colors.muted('Paste your API keys (they will be saved to .env).'));
    console.log(colors.muted(`Missing: ${errors.map(e => e.replace(' is not set', '')).join(', ')}`));
    console.log(colors.muted('Tip: run `research init` anytime to change defaults.'));
    console.log();
}

export const searchCommand = new Command('search')
    .description('Perform deep research on a topic')
    .argument('<query>', 'Research query or question')
    .option('-m, --model <model>', 'OpenRouter model to use')
    .option('-i, --interactive', 'Interactive model selection')
    .option('-o, --output <file>', 'Save report to file')
    .option('--no-stream', 'Disable streaming output')
    .option('--ui <mode>', 'UI mode: minimal | fancy | plain')
    .option('--render <mode>', 'Report rendering when not streaming: terminal | raw')
    .option('--dry-run', 'Show research plan and cost estimate without executing')
    .option('--estimate', 'Show detailed cost estimate before proceeding')
    .action(async (
        query: string,
        options: {
            model?: string;
            interactive?: boolean;
            output?: string;
            stream?: boolean;
            ui?: string;
            render?: string;
            dryRun?: boolean;
            estimate?: boolean;
        }
    ) => {
        try {
            const preflight = loadConfig();
            const earlyUiMode = options.ui || preflight.uiMode;
            if (earlyUiMode) process.env.UI_MODE = earlyUiMode;

            const validation = validateConfig(preflight, { exa: true, openrouter: true });
            if (!validation.valid) maybeShowSetupIntro(validation.errors);
            const config = await ensureConfig({ exa: true, openrouter: true });

            // Initialize clients
            const exaClient = new ExaClient(config.exaApiKey);
            const openRouterClient = new OpenRouterClient(config.openrouterApiKey);

            const uiMode = options.ui || config.uiMode;
            if (uiMode) process.env.UI_MODE = uiMode;

            // Select model
            let model = options.model || config.defaultModel;

            if (options.interactive) {
                const spinner = createSpinner('Fetching OpenRouter models...');
                spinner.start();

                const models = await openRouterClient.listModels();
                spinner.stop();

                const { selectModelQuick } = await import('../ui/model-selector.js');
                const selected = await selectModelQuick(models, { currentModel: model });
                model = selected.id;
            }

            // Show header
            showHeader({ model, query });

            // Phase 1: Planning
            const planSpinner = createSpinner('Analyzing query and creating research plan...');
            planSpinner.start();

            const modelOptions: ChatOptions = {
                maxTokens: config.modelMaxTokens,
                temperature: config.modelTemperature,
                topP: config.modelTopP,
                topK: config.modelTopK,
                seed: config.modelSeed,
                frequencyPenalty: config.modelFrequencyPenalty,
                presencePenalty: config.modelPresencePenalty,
                reasoning: { effort: config.modelReasoningEffort },
            };

            const planner = new ResearchPlanner(openRouterClient, model, modelOptions);
            const plan = await planner.createPlan(query);

            planSpinner.succeed(colors.success('Research plan created'));

            showResearchPlan(plan);

            // Cost estimation (if --estimate or --dry-run)
            if (options.estimate || options.dryRun) {
                const { estimateCost, formatCostBreakdown, SUMMARIZER_MODEL_ID } = await import('../utils/cost-estimator.js');
                const models = await openRouterClient.listModels();
                const mainModel = models.find(m => m.id === model);
                const summarizerModel = models.find(m => m.id === SUMMARIZER_MODEL_ID);

                const costEstimate = estimateCost(mainModel, summarizerModel, {
                    numSteps: plan.steps.length,
                    numFollowUps: config.autoFollowup ? 2 : 0,
                });

                console.log();
                console.log(colors.primary('Cost Estimate'));
                console.log(colors.muted(formatCostBreakdown(costEstimate)));

                if (options.dryRun) {
                    console.log();
                    console.log(colors.muted('Dry run complete. No searches executed.'));
                    return;
                }

                // Ask for confirmation if estimate is shown
                const inquirer = (await import('inquirer')).default;
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Proceed with research?',
                    default: true,
                }]);

                if (!proceed) {
                    console.log(colors.muted('Research cancelled.'));
                    return;
                }
            }

            // Phase 2: Execution (batch parallel searches)
            console.log();
            const searchSpinner = createSpinner('Executing research steps in parallel...');
            searchSpinner.start();

            const executor = new ResearchExecutor(exaClient, {
                numResults: config.exaNumResults,
                followUpNumResults: config.exaFollowupNumResults,
            });

            const results = await executor.executeAll(plan, (step, index) => {
                if (step.status === 'complete') {
                    searchSpinner.text = `Step ${index + 1}/${plan.steps.length} complete`;
                }
            });

            searchSpinner.succeed(colors.success(`All ${plan.steps.length} research steps complete`));

            const shouldAutoFollowUp = config.autoFollowup && process.env.AUTO_FOLLOWUP !== '0';
            const maxFollowUpsTotal = typeof config.maxFollowupSteps === 'number' ? Math.max(0, config.maxFollowupSteps) : Number.POSITIVE_INFINITY;

            if (shouldAutoFollowUp && maxFollowUpsTotal !== 0) {
                const truncate = (text: string, maxChars: number): string => {
                    const t = String(text ?? '');
                    if (t.length <= maxChars) return t;
                    return t.slice(0, maxChars).trimEnd() + '…';
                };

                const brief = (text: string, maxChars: number): string => truncate(String(text ?? ''), maxChars);
                const executedQueries = new Set<string>(
                    plan.steps
                        .map((s) => String(s.searchQuery ?? '').trim().toLowerCase())
                        .filter(Boolean)
                );

                type FollowUpGap = { question: string; searchQuery: string; priority: 'high' | 'medium' | 'low' };
                let followUpsUsed = 0;

                const buildFollowUpContext = (): string => {
                    const lines: string[] = [];
                    lines.push(`Main question: ${plan.mainQuestion}`);
                    lines.push('');
                    lines.push('Findings so far (high-level):');

                    results.forEach((r, idx) => {
                        lines.push(`\nStep ${idx + 1}: ${r.step.question}`);
                        lines.push(`Query: ${r.step.searchQuery}`);

                        const top = (r.response?.results ?? []).slice(0, 2);
                        if (top.length === 0) {
                            lines.push('Top sources: (none)');
                            return;
                        }

                        lines.push('Top sources:');
                        top.forEach((s) => {
                            const snippet = brief(s.summary || (s.highlights?.[0] ?? ''), 240);
                            lines.push(`- ${brief(s.title, 100)} (${s.url})${snippet ? ` — ${snippet}` : ''}`);
                        });
                    });

                    return lines.join('\n');
                };

                while (followUpsUsed < maxFollowUpsTotal) {
                    const remaining = maxFollowUpsTotal === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : maxFollowUpsTotal - followUpsUsed;
                    if (remaining <= 0) break;

                    const gapSpinner = createSpinner(
                        followUpsUsed === 0 ? 'Checking for research gaps (LLM)…' : 'Checking for more gaps (LLM)…'
                    );
                    gapSpinner.start();

                    let followUp: { hasGaps: boolean; gaps: FollowUpGap[] } | null = null;
                    try {
                        const response = await openRouterClient.chat(
                            model,
                            [
                                { role: 'system', content: FOLLOW_UP_PROMPT },
                                { role: 'user', content: buildFollowUpContext() },
                            ],
                            { ...modelOptions }
                        );

                        const content = response.choices[0]?.message?.content ?? '';
                        const trimmed = content.trim();
                        const json = (() => {
                            try {
                                return JSON.parse(trimmed);
                            } catch {
                                const match = trimmed.match(/\{[\s\S]*\}/);
                                if (!match) throw new Error('No JSON found');
                                return JSON.parse(match[0]);
                            }
                        })();

                        followUp = {
                            hasGaps: Boolean(json.hasGaps),
                            gaps: Array.isArray(json.gaps) ? json.gaps : [],
                        };
                    } catch {
                        followUp = null;
                    }

                    if (!followUp?.hasGaps) {
                        gapSpinner.succeed(colors.success('No major gaps detected'));
                        break;
                    }

                    const candidates = (followUp.gaps ?? [])
                        .filter((g) => g && typeof g.searchQuery === 'string' && g.searchQuery.trim().length > 0)
                        .map((g) => ({
                            question: String(g.question ?? '').trim() || 'Follow-up question',
                            searchQuery: String(g.searchQuery).trim(),
                            priority: (String(g.priority ?? 'medium').toLowerCase() as FollowUpGap['priority']) || 'medium',
                        }))
                        .filter((g) => g.priority === 'high' || g.priority === 'medium')
                        .filter((g) => !executedQueries.has(g.searchQuery.toLowerCase()));

                    const selected = candidates.slice(0, remaining);

                    if (selected.length === 0) {
                        gapSpinner.succeed(colors.success('No new actionable gaps'));
                        break;
                    }

                    gapSpinner.succeed(colors.success(`Found ${selected.length} follow-up gap${selected.length === 1 ? '' : 's'}`));

                    const deepenSpinner = createSpinner('Deepening research with Exa…');
                    deepenSpinner.start();

                    const followUpResults = await Promise.all(
                        selected.map(async (gap, i) => {
                            deepenSpinner.text = `Follow-up ${i + 1}/${selected.length}: ${brief(gap.searchQuery, 60)}`;
                            if (config.showToolCalls) {
                                deepenSpinner.stop();
                                console.log(colors.muted(`${icons.arrow} Tool: Exa follow-up  ${brief(gap.searchQuery, 160)}`));
                                deepenSpinner.start();
                            }

                            const response = await executor.executeFollowUp(gap.searchQuery);
                            const sourceSummaries = response.results
                                .filter((r) => r.summary || r.highlights?.length)
                                .map((r) => {
                                    const summary = r.summary || r.highlights?.join(' ') || '';
                                    return `[${r.title}](${r.url}): ${summary}`;
                                });

                            return { gap, response, sourceSummaries };
                        })
                    );

                    followUpResults.forEach((r) => {
                        const newStepId = plan.steps.length + 1;
                        const step = {
                            id: newStepId,
                            question: r.gap.question,
                            searchQuery: r.gap.searchQuery,
                            purpose: `Follow-up (${r.gap.priority} priority)`,
                            status: 'complete' as const,
                            results: r.response,
                        };
                        plan.steps.push(step);
                        results.push({ step, response: r.response, sourceSummaries: r.sourceSummaries });
                        executedQueries.add(r.gap.searchQuery.trim().toLowerCase());
                    });

                    followUpsUsed += followUpResults.length;
                    deepenSpinner.succeed(colors.success(`Added ${followUpResults.length} follow-up step${followUpResults.length === 1 ? '' : 's'}`));
                }
            }

            // Show completion summary
            showProgressTree(plan.steps);

            // Phase 3: Synthesis
            showSynthesisHeader();

            const synthesizer = new ResearchSynthesizer(openRouterClient, model, modelOptions);

            let report: string;
            const shouldStream = argvHas('--no-stream') ? false : argvHas('--stream') ? true : config.streamOutput;
            const renderMode = (options.render || (config.renderMarkdown ? 'terminal' : 'raw')).toLowerCase();

            if (shouldStream) {
                // Stream the synthesis
                report = await streamOutput(synthesizer.synthesize(plan.mainQuestion, results));
            } else {
                const synthSpinner = createSpinner('Generating report...');
                synthSpinner.start();
                report = await synthesizer.synthesizeSync(plan.mainQuestion, results);
                synthSpinner.stop();
                console.log(renderMode === 'terminal' ? renderMarkdown(report) : report);
            }

            // Save to file if requested
            if (options.output) {
                await writeFile(options.output, report, 'utf-8');
                showComplete(options.output);
            } else {
                showComplete();
            }

        } catch (error) {
            // If it's a known error, show a friendly message
            if (error instanceof DeepResearchError) {
                showError(error.message);
                process.exit(1);
            }
            // Otherwise, let it propagate (or show usage) if it's not our custom error
            showError(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });

#!/usr/bin/env node
/**
 * Deep Research CLI - Main Entry Point
 * A stylistic CLI tool for deep web research using Exa Search and OpenRouter
 */

import 'dotenv/config';
import { checkNodeVersion } from './utils/node-version.js';

// Check Node.js version before anything else
checkNodeVersion();

import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { ensureConfig, loadConfig, validateConfig, writeEnvVars, DEFAULTS } from './config.js';
import { ExaClient } from './clients/exa.js';
import { OpenRouterClient, type ChatOptions } from './clients/openrouter.js';
import { ResearchPlanner } from './research/planner.js';
import { ResearchExecutor } from './research/executor.js';
import { ResearchSynthesizer } from './research/synthesizer.js';
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
} from './ui/components.js';
import { colors, icons } from './ui/theme.js';
import { FOLLOW_UP_PROMPT } from './research/prompts.js';
import packageJson from '../package.json' assert { type: 'json' };

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('\n' + colors.muted('Interrupted. Goodbye!'));
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n' + colors.muted('Terminated. Goodbye!'));
    process.exit(0);
});

const program = new Command();

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

program
    .name('research')
    .description('Deep research CLI - AI-powered web research')
    .version(packageJson.version);

program
    .command('init')
    .description('Set up API keys and defaults')
    .option('-f, --force', 'Re-enter API keys even if set')
    .option('--advanced', 'Configure advanced output options')
    .action(async (options: { force?: boolean; advanced?: boolean }) => {
        try {
            const preflight = loadConfig();
            process.env.UI_MODE = preflight.uiMode;

            console.log();
            console.log(colors.primary('Setup'));
            console.log(colors.muted('This will save your settings to .env in this folder.'));
            console.log();

            await ensureConfig(
                { exa: true, openrouter: true },
                {
                    force: Boolean(options.force),
                    promptPreferences: true,
                    preferencesMode: options.advanced ? 'advanced' : 'basic',
                }
            );
            console.log(colors.success('Saved configuration to .env'));
        } catch (error) {
            showError(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });

program
    .command('search')
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

                const { selectModelQuick } = await import('./ui/model-selector.js');
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
                const { estimateCost, formatCostBreakdown, SUMMARIZER_MODEL_ID } = await import('./utils/cost-estimator.js');
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

            const executor = new ResearchExecutor(exaClient);

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
            showError(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });

program
    .command('agent', { isDefault: true })
    .description('Start the interactive deep-research assistant')
    .alias('chat')
    .option('-m, --model <model>', 'Model to use (default: moonshotai/kimi-k2-thinking)')
    .option('--ui <mode>', 'UI mode: minimal | fancy | plain')
    .option('--render <mode>', 'Report rendering (non-stream): terminal | raw')
    .option('--reasoning <mode>', 'Reasoning output: auto | on | off')
    .action(async (options: { model?: string; ui?: string; render?: string; reasoning?: string }) => {
        try {
            const preflight = loadConfig();
            const earlyUiMode = options.ui || preflight.uiMode;
            if (earlyUiMode) process.env.UI_MODE = earlyUiMode;

            const validation = validateConfig(preflight, { exa: true, openrouter: true });
            if (!validation.valid) maybeShowSetupIntro(validation.errors);
            const config = await ensureConfig({ exa: true, openrouter: true });

            const model = options.model || config.defaultModel || DEFAULTS.model;

            const uiMode = options.ui || config.uiMode;
            if (uiMode) process.env.UI_MODE = uiMode;

            const renderMode = (options.render || (config.renderMarkdown ? 'terminal' : 'raw')).toLowerCase();
            process.env.RENDER_MARKDOWN = renderMode === 'terminal' ? '1' : '0';

            const reasoningMode = (options.reasoning || 'auto').toLowerCase();
            const showReasoning = reasoningMode === 'on'
                ? true
                : reasoningMode === 'off'
                    ? false
                    : config.showReasoning;
            process.env.SHOW_REASONING = showReasoning ? '1' : '0';
            process.env.SHOW_TOOL_CALLS = config.showToolCalls ? '1' : '0';

            const { DeepResearchAgent } = await import('./agent/interactive.js');
            const agent = new DeepResearchAgent(config, model);
            await agent.start();

        } catch (error) {
            showError(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });

program
    .command('models')
    .description('List available models')
    .option('--json', 'Output JSON')
    .option('--details', 'Show model parameters (supported params, description)')
    .option('--filter <query>', 'Filter models by id/name')
    .option('--limit <n>', 'Limit results (default: 20)', (v) => parseInt(v, 10))
    .option('--select', 'Select and save DEFAULT_MODEL')
    .action(async (options: { json?: boolean; details?: boolean; filter?: string; limit?: number; select?: boolean }) => {
        const preflight = loadConfig();
        process.env.UI_MODE = preflight.uiMode;
        const validation = validateConfig(preflight, { exa: false, openrouter: true });
        if (!validation.valid) maybeShowSetupIntro(validation.errors);
        const config = await ensureConfig({ exa: false, openrouter: true });
        process.env.UI_MODE = config.uiMode;

        const spinner = createSpinner('Fetching models...');
        spinner.start();

        const client = new OpenRouterClient(config.openrouterApiKey);
        const models = await client.listModels();
        spinner.stop();

        if (options.select) {
            const { selectModelQuick } = await import('./ui/model-selector.js');
            const selected = await selectModelQuick(models, { currentModel: config.defaultModel, showDetails: true });
            await writeEnvVars({ DEFAULT_MODEL: selected.id });
            console.log(colors.success(`Saved DEFAULT_MODEL=${selected.id}`));
            return;
        }

        const filter = options.filter?.trim().toLowerCase();
        const filtered = filter
            ? models.filter((m) =>
                m.id.toLowerCase().includes(filter) ||
                m.name.toLowerCase().includes(filter) ||
                (m.description?.toLowerCase().includes(filter) ?? false)
            )
            : models;

        const limit = Number.isFinite(options.limit) ? Number(options.limit) : 20;
        const visible = filtered.slice(0, limit);

        if (options.json) {
            console.log(JSON.stringify(visible, null, 2));
            return;
        }

        console.log(`\n${colors.primary('Available Models')} (${models.length} total)`);
        if (filter) console.log(colors.muted(`Filter: ${filter} (${filtered.length} matched)`));
        console.log();

        visible.forEach((m) => {
            const ctx = `${(m.contextLength / 1000).toFixed(0)}k`;
            const maxOut = m.maxCompletionTokens ? `${m.maxCompletionTokens}` : '—';
            const priceIn = (m.pricing.prompt * 1_000_000).toFixed(2);
            const priceOut = (m.pricing.completion * 1_000_000).toFixed(2);

            console.log(`  ${colors.secondary(m.id)}`);
            console.log(colors.muted(`    Context: ${ctx} | Max out: ${maxOut} | Price: $${priceIn}/$${priceOut} per 1M tokens`));

            if (options.details) {
                if (m.supportedParameters?.length) {
                    console.log(colors.muted(`    Supported: ${m.supportedParameters.join(', ')}`));
                }
                if (m.description) {
                    console.log(colors.muted(`    ${m.description}`));
                }
            }
        });

        console.log();
    });

// Parse arguments
program.parse();

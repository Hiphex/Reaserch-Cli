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
import { ensureConfig, loadConfig, validateConfig, writeEnvVars, DEFAULTS } from './config.js';
import { searchCommand } from './commands/search.js';
import { OpenRouterClient } from './clients/openrouter.js';
import { colors } from './ui/theme.js';
import {
    showError,
    createSpinner,
} from './ui/components.js';
import { colors, icons } from './ui/theme.js';
import { FOLLOW_UP_PROMPT } from './research/prompts.js';
import packageJson from '../package.json' with { type: 'json' };

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

program.addCommand(searchCommand);

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

            const { DeepResearchAgent } = await import('./agent/interactive/index.js');
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

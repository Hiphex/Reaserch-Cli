/**
 * Configuration management for the Deep Research CLI
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

export type UiMode = 'minimal' | 'fancy' | 'plain';
export type PreferencesMode = 'basic' | 'advanced';
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Centralized default values for the CLI configuration.
 * Use these instead of hardcoding defaults throughout the codebase.
 */
export const DEFAULTS = {
    model: 'moonshotai/kimi-k2-thinking',
    reasoningEffort: 'high' as ReasoningEffort,
    uiMode: 'fancy' as UiMode,
    renderMarkdown: true,
    showReasoning: false,
    showToolCalls: true,
    autoFollowup: true,
    streamOutput: true,
    exaNumResults: 8,
    exaFollowupNumResults: 5,
} as const;

export interface Config {
    exaApiKey: string;
    openrouterApiKey: string;
    defaultModel: string;
    modelReasoningEffort: ReasoningEffort;
    modelMaxTokens?: number;
    modelTemperature?: number;
    modelTopP?: number;
    modelTopK?: number;
    modelSeed?: number;
    modelFrequencyPenalty?: number;
    modelPresencePenalty?: number;
    uiMode: UiMode;
    renderMarkdown: boolean;
    showReasoning: boolean;
    showToolCalls: boolean;
    autoFollowup: boolean;
    maxFollowupSteps?: number;
    streamOutput: boolean;
}

function envBool(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function envOptionalNumber(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function envOptionalInt(value: string | undefined): number | undefined {
    const parsed = envOptionalNumber(value);
    if (parsed === undefined) return undefined;
    return Math.trunc(parsed);
}

function envReasoningEffort(value: string | undefined, defaultValue: ReasoningEffort): ReasoningEffort {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'low') return 'low';
    if (normalized === 'high') return 'high';
    if (normalized === 'medium') return 'medium';
    return defaultValue;
}

function envUiMode(value: string | undefined): UiMode {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'fancy') return 'fancy';
    if (normalized === 'plain') return 'plain';
    if (normalized === 'minimal') return 'minimal';
    return DEFAULTS.uiMode;
}

export function loadConfig(): Config {
    const exaApiKey = process.env.EXA_API_KEY || '';
    const openrouterApiKey = process.env.OPENROUTER_API_KEY || '';
    const defaultModel = process.env.DEFAULT_MODEL || DEFAULTS.model;
    const modelReasoningEffort = envReasoningEffort(process.env.MODEL_REASONING_EFFORT, DEFAULTS.reasoningEffort);
    const modelMaxTokens = envOptionalInt(process.env.MODEL_MAX_TOKENS);
    const modelTemperature = envOptionalNumber(process.env.MODEL_TEMPERATURE);
    const modelTopP = envOptionalNumber(process.env.MODEL_TOP_P);
    const modelTopK = envOptionalInt(process.env.MODEL_TOP_K);
    const modelSeed = envOptionalInt(process.env.MODEL_SEED);
    const modelFrequencyPenalty = envOptionalNumber(process.env.MODEL_FREQUENCY_PENALTY);
    const modelPresencePenalty = envOptionalNumber(process.env.MODEL_PRESENCE_PENALTY);
    const uiMode = envUiMode(process.env.UI_MODE);
    const renderMarkdown = envBool(process.env.RENDER_MARKDOWN, DEFAULTS.renderMarkdown);
    const showReasoning = envBool(process.env.SHOW_REASONING, DEFAULTS.showReasoning);
    const showToolCalls = envBool(process.env.SHOW_TOOL_CALLS, DEFAULTS.showToolCalls);
    const autoFollowup = envBool(process.env.AUTO_FOLLOWUP, DEFAULTS.autoFollowup);
    const maxFollowupSteps = envOptionalInt(process.env.MAX_FOLLOWUP_STEPS);
    const streamOutput = envBool(process.env.STREAM_OUTPUT, DEFAULTS.streamOutput);

    return {
        exaApiKey,
        openrouterApiKey,
        defaultModel,
        modelReasoningEffort,
        modelMaxTokens,
        modelTemperature,
        modelTopP,
        modelTopK,
        modelSeed,
        modelFrequencyPenalty,
        modelPresencePenalty,
        uiMode,
        renderMarkdown,
        showReasoning,
        showToolCalls,
        autoFollowup,
        maxFollowupSteps,
        streamOutput,
    };
}

export function validateConfig(
    config: Config,
    required: { exa?: boolean; openrouter?: boolean } = { exa: true, openrouter: true }
): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (required.exa !== false && !config.exaApiKey) {
        errors.push('EXA_API_KEY is not set');
    }

    if (required.openrouter !== false && !config.openrouterApiKey) {
        errors.push('OPENROUTER_API_KEY is not set');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

function escapeEnvValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '') return '""';
    const needsQuotes = /[\s#"'\\]/.test(trimmed);
    if (!needsQuotes) return trimmed;
    const escaped = trimmed
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');
    return `"${escaped}"`;
}

async function updateEnvFile(envPath: string, updates: Record<string, string>): Promise<void> {
    let existing = '';
    try {
        existing = await readFile(envPath, 'utf8');
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw error;
    }

    const lines = existing === '' ? [] : existing.split(/\r?\n/);
    const touched = new Set<string>();

    const nextLines = lines.map((line) => {
        if (line.trim().startsWith('#')) return line;
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match) return line;

        const key = match[1];
        if (!(key in updates)) return line;

        touched.add(key);
        return `${key}=${escapeEnvValue(updates[key])}`;
    });

    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== '') {
        nextLines.push('');
    }

    for (const [key, value] of Object.entries(updates)) {
        if (touched.has(key)) continue;
        nextLines.push(`${key}=${escapeEnvValue(value)}`);
    }

    const finalContents = nextLines.join('\n').replace(/\n+$/g, '\n');
    const isNewFile = existing === '';
    const writeOptions: { encoding: BufferEncoding; mode?: number } = { encoding: 'utf8' };
    if (isNewFile) writeOptions.mode = 0o600;
    await writeFile(envPath, finalContents, writeOptions);
}

export function getDefaultEnvPath(): string {
    const explicit = process.env.RESEARCH_ENV_PATH?.trim();
    if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(process.cwd(), explicit);
    return path.join(process.cwd(), '.env');
}

export async function writeEnvVars(
    updates: Record<string, string>,
    options: { envPath?: string } = {}
): Promise<void> {
    const envPath = options.envPath ?? getDefaultEnvPath();
    await updateEnvFile(envPath, updates);
    for (const [key, value] of Object.entries(updates)) {
        process.env[key] = value;
    }
}

export async function ensureConfig(
    required: { exa?: boolean; openrouter?: boolean } = { exa: true, openrouter: true },
    options: { envPath?: string; promptPreferences?: boolean; force?: boolean; preferencesMode?: PreferencesMode } = {}
): Promise<Config> {
    const envPath = options.envPath ?? getDefaultEnvPath();
    const current = loadConfig();
    const validation = validateConfig(current, required);

    const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const missingRequired = validation.errors.length > 0;

    const shouldPrompt = Boolean(options.force || missingRequired || options.promptPreferences);
    if (!shouldPrompt) return current;

    if (!canPrompt && missingRequired) {
        throw new Error(`Missing configuration:\n${validation.errors.map(e => `  • ${e}`).join('\n')}`);
    }

    const inquirer = (await import('inquirer')).default;

    const keyQuestions: any[] = [];

    if (options.force || (required.openrouter !== false && !current.openrouterApiKey)) {
        keyQuestions.push({
            type: 'password',
            name: 'openrouterApiKey',
            message: 'Paste your OpenRouter API key',
            mask: '*',
            default: current.openrouterApiKey || undefined,
            validate: (input: string) => input.trim().length > 0 || 'OpenRouter API key is required',
        });
    }

    if (options.force || (required.exa !== false && !current.exaApiKey)) {
        keyQuestions.push({
            type: 'password',
            name: 'exaApiKey',
            message: 'Paste your Exa API key',
            mask: '*',
            default: current.exaApiKey || undefined,
            validate: (input: string) => input.trim().length > 0 || 'Exa API key is required',
        });
    }

    const wantsPreferences = options.force || options.promptPreferences || missingRequired;
    const preferencesMode: PreferencesMode = options.preferencesMode ?? (missingRequired ? 'advanced' : 'basic');

    if (keyQuestions.length === 0 && !wantsPreferences) return current;

    const keyAnswers = keyQuestions.length > 0 ? await inquirer.prompt(keyQuestions) : {};

    let defaultModel = current.defaultModel;
    const openrouterApiKey = (keyAnswers.openrouterApiKey ?? current.openrouterApiKey) as string;

    if (wantsPreferences) {
        const { modelSetup } = await inquirer.prompt([
            {
                type: 'list',
                name: 'modelSetup',
                message: 'Default model',
                choices: [
                    { name: 'Recommended: moonshotai/kimi-k2-thinking', value: 'recommended' },
                    { name: 'Choose from popular models', value: 'popular' },
                    { name: 'Search all models', value: 'search' },
                    { name: 'Enter model id manually', value: 'manual' },
                    { name: `Keep current (${current.defaultModel})`, value: 'keep' },
                ],
                default: 'keep',
            },
        ]);

        if (modelSetup === 'recommended') {
            defaultModel = 'moonshotai/kimi-k2-thinking';
        } else if (modelSetup === 'keep') {
            defaultModel = current.defaultModel;
        } else if (modelSetup === 'manual' || modelSetup === 'popular' || modelSetup === 'search') {
            if (!openrouterApiKey) {
                const fallback = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'defaultModel',
                        message: 'Default OpenRouter model',
                        default: current.defaultModel,
                        validate: (input: string) => input.trim().length > 0 || 'Model is required',
                    },
                ]);
                defaultModel = fallback.defaultModel;
            } else if (modelSetup === 'manual') {
                const fallback = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'defaultModel',
                        message: 'Default OpenRouter model id',
                        default: current.defaultModel,
                        validate: (input: string) => input.trim().length > 0 || 'Model id is required',
                    },
                ]);
                defaultModel = fallback.defaultModel;
            } else {
                try {
                    const { OpenRouterClient } = await import('./clients/openrouter.js');
                    const { createSpinner } = await import('./ui/components.js');
                    const spinner = createSpinner('Fetching OpenRouter models...');
                    spinner.start();
                    const client = new OpenRouterClient(openrouterApiKey);
                    const models = await client.listModels();
                    spinner.stop();

                    if (modelSetup === 'popular') {
                        const { selectModelQuick } = await import('./ui/model-selector.js');
                        const selected = await selectModelQuick(models, { currentModel: current.defaultModel });
                        defaultModel = selected.id;
                    } else {
                        const { selectModelInteractive } = await import('./ui/model-selector.js');
                        const selected = await selectModelInteractive(models, { currentModel: current.defaultModel });
                        defaultModel = selected.id;
                    }
                } catch {
                    const fallback = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'defaultModel',
                            message: 'Default OpenRouter model',
                            default: current.defaultModel,
                            validate: (input: string) => input.trim().length > 0 || 'Model is required',
                        },
                    ]);
                    defaultModel = fallback.defaultModel;
                }
            }
        }
    }

    const preferenceQuestions: any[] = [];
    if (wantsPreferences) {
        preferenceQuestions.push({
            type: 'list',
            name: 'uiMode',
            message: 'UI style',
            default: current.uiMode,
            choices: [
                { name: 'Minimal (clean)', value: 'minimal' },
                { name: 'Fancy (boxed)', value: 'fancy' },
                { name: 'Plain (no color)', value: 'plain' },
            ],
        });

        if (preferencesMode === 'advanced') {
            preferenceQuestions.push(
                {
                    type: 'confirm',
                    name: 'renderMarkdown',
                    message: 'Render markdown in terminal output?',
                    default: current.renderMarkdown,
                },
                {
                    type: 'confirm',
                    name: 'streamOutput',
                    message: 'Stream report output?',
                    default: current.streamOutput,
                },
                {
                    type: 'confirm',
                    name: 'showReasoning',
                    message: 'Show reasoning summaries? (if available)',
                    default: current.showReasoning,
                },
                {
                    type: 'confirm',
                    name: 'showToolCalls',
                    message: 'Show agent tool calls / activity?',
                    default: current.showToolCalls,
                },
                {
                    type: 'confirm',
                    name: 'autoFollowup',
                    message: 'Automatically deepen research with follow-up searches?',
                    default: current.autoFollowup,
                },
                {
                    type: 'input',
                    name: 'maxFollowupSteps',
                    message: 'Max follow-up steps (blank = unlimited)',
                    default: typeof current.maxFollowupSteps === 'number' ? String(current.maxFollowupSteps) : '',
                    validate: (input: string) => {
                        const trimmed = input.trim().toLowerCase();
                        if (trimmed === '') return true;
                        const n = Number(trimmed);
                        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 'Enter 0+ or leave blank';
                        return true;
                    },
                },
                {
                    type: 'list',
                    name: 'modelReasoningEffort',
                    message: 'Reasoning effort (if supported by the model)',
                    default: current.modelReasoningEffort,
                    choices: [
                        { name: 'Low', value: 'low' },
                        { name: 'Medium', value: 'medium' },
                        { name: 'High', value: 'high' },
                    ],
                },
            );
        }
    }

    const preferenceAnswers = preferenceQuestions.length > 0 ? await inquirer.prompt(preferenceQuestions) : {};

    const next: Config = {
        ...current,
        ...keyAnswers,
        ...preferenceAnswers,
        defaultModel,
        uiMode: envUiMode(preferenceAnswers.uiMode ?? current.uiMode),
        renderMarkdown: typeof preferenceAnswers.renderMarkdown === 'boolean' ? preferenceAnswers.renderMarkdown : current.renderMarkdown,
        showReasoning: typeof preferenceAnswers.showReasoning === 'boolean' ? preferenceAnswers.showReasoning : current.showReasoning,
        showToolCalls: typeof preferenceAnswers.showToolCalls === 'boolean' ? preferenceAnswers.showToolCalls : current.showToolCalls,
        autoFollowup: typeof preferenceAnswers.autoFollowup === 'boolean' ? preferenceAnswers.autoFollowup : current.autoFollowup,
        maxFollowupSteps: (() => {
            if (!Object.prototype.hasOwnProperty.call(preferenceAnswers, 'maxFollowupSteps')) return current.maxFollowupSteps;
            const raw = String((preferenceAnswers as any).maxFollowupSteps ?? '').trim();
            if (raw === '') return undefined;
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return current.maxFollowupSteps;
            return parsed;
        })(),
        modelReasoningEffort: envReasoningEffort((preferenceAnswers as any).modelReasoningEffort, current.modelReasoningEffort),
        streamOutput: typeof preferenceAnswers.streamOutput === 'boolean' ? preferenceAnswers.streamOutput : current.streamOutput,
    };

    const updates: Record<string, string> = {
        DEFAULT_MODEL: next.defaultModel,
        MODEL_REASONING_EFFORT: next.modelReasoningEffort,
        UI_MODE: next.uiMode,
        RENDER_MARKDOWN: next.renderMarkdown ? '1' : '0',
        STREAM_OUTPUT: next.streamOutput ? '1' : '0',
        SHOW_REASONING: next.showReasoning ? '1' : '0',
        SHOW_TOOL_CALLS: next.showToolCalls ? '1' : '0',
        AUTO_FOLLOWUP: next.autoFollowup ? '1' : '0',
        MAX_FOLLOWUP_STEPS: typeof next.maxFollowupSteps === 'number' ? String(next.maxFollowupSteps) : '',
    };

    if (next.openrouterApiKey) updates.OPENROUTER_API_KEY = next.openrouterApiKey;
    if (next.exaApiKey) updates.EXA_API_KEY = next.exaApiKey;

    await writeEnvVars(updates, { envPath });

    return next;
}

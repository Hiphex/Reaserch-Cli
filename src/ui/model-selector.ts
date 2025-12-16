import inquirer from 'inquirer';
import boxen from 'boxen';
import { colors, divider, getBoxOuterWidth } from './theme.js';
import type { Model } from '../clients/openrouter.js';

function moneyPerMillion(pricePerToken: number): string {
    const value = Number.isFinite(pricePerToken) ? pricePerToken * 1_000_000 : 0;
    return `$${value.toFixed(2)}`;
}

function formatContext(contextLength: number): string {
    if (!Number.isFinite(contextLength) || contextLength <= 0) return '—';
    return `${Math.round(contextLength / 1000)}k`;
}

function formatMaxOut(maxCompletionTokens?: number): string {
    if (!Number.isFinite(maxCompletionTokens) || !maxCompletionTokens || maxCompletionTokens <= 0) return '—';
    return `${maxCompletionTokens}`;
}

function normalize(text: string): string {
    return text.trim().toLowerCase();
}

function matches(model: Model, query: string): boolean {
    const q = normalize(query);
    if (!q) return true;
    return (
        model.id.toLowerCase().includes(q) ||
        model.name.toLowerCase().includes(q) ||
        (model.description?.toLowerCase().includes(q) ?? false)
    );
}

function summarizeModel(model: Model): string {
    const ctx = formatContext(model.contextLength);
    const maxOut = formatMaxOut(model.maxCompletionTokens);
    const priceIn = moneyPerMillion(model.pricing.prompt);
    const priceOut = moneyPerMillion(model.pricing.completion);
    return `${model.id}  ${ctx} ctx  ${priceIn}/${priceOut}  maxOut ${maxOut}`;
}

function printModelDetails(model: Model): void {
    const uiMode = process.env.UI_MODE?.trim().toLowerCase();
    const useBox = uiMode === 'fancy';

    const lines: string[] = [];
    lines.push(colors.primary(model.id));
    if (model.name && model.name !== model.id) lines.push(colors.muted(model.name));
    lines.push(colors.muted(divider()));

    lines.push(`Context: ${formatContext(model.contextLength)}`);
    if (model.maxCompletionTokens) lines.push(`Max output: ${formatMaxOut(model.maxCompletionTokens)}`);
    lines.push(`Price: ${moneyPerMillion(model.pricing.prompt)} in / ${moneyPerMillion(model.pricing.completion)} out (per 1M tokens)`);

    if (model.supportedParameters?.length) {
        lines.push('');
        lines.push(colors.muted('Supported parameters:'));
        lines.push(model.supportedParameters.join(', '));
    }

    if (model.description) {
        lines.push('');
        lines.push(colors.muted('Description:'));
        lines.push(model.description);
    }

    console.log();
    if (useBox) {
        console.log(
            boxen(lines.join('\n'), {
                padding: 1,
                borderStyle: 'round',
                borderColor: 'gray',
                width: getBoxOuterWidth(),
            })
        );
    } else {
        console.log(lines.join('\n'));
    }
}

function popularFilter(model: Model): boolean {
    const id = model.id.toLowerCase();
    return (
        id.includes('claude') ||
        id.includes('o4') ||
        id.includes('gpt-4') ||
        id.includes('gemini') ||
        id.includes('llama') ||
        id.includes('deepseek') ||
        id.includes('qwen')
    );
}

function stableSortModels(models: Model[]): Model[] {
    const recommended = 'moonshotai/kimi-k2-thinking';
    return [...models].sort((a, b) => {
        if (a.id === recommended) return -1;
        if (b.id === recommended) return 1;
        return a.id.localeCompare(b.id);
    });
}

async function promptManualModelId(defaultValue?: string): Promise<string> {
    const { manualId } = await inquirer.prompt([
        {
            type: 'input',
            name: 'manualId',
            message: 'Model id',
            default: defaultValue || undefined,
            validate: (input: string) => input.trim().length > 0 || 'Model id is required',
        },
    ]);
    return String(manualId ?? '').trim();
}

export async function selectModelQuick(
    models: Model[],
    options: { currentModel?: string; maxChoices?: number; showDetails?: boolean } = {}
): Promise<Model> {
    const maxChoices = Number.isFinite(options.maxChoices) ? Number(options.maxChoices) : 25;
    const currentModelId = options.currentModel;

    const sorted = stableSortModels(models);
    const popular = sorted.filter(popularFilter);
    const limited = (popular.length > 0 ? popular : sorted).slice(0, maxChoices);

    const choices: any[] = limited.map((m) => ({
        name: summarizeModel(m),
        value: m.id,
    }));

    choices.push(new inquirer.Separator());
    choices.push({ name: 'Search all models…', value: '__search__' });
    choices.push({ name: 'Enter model id manually…', value: '__manual__' });

    const { selected } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selected',
            message: 'Choose a model',
            choices,
            pageSize: 15,
            default: currentModelId ? choices.findIndex(c => (c as any).value === currentModelId) : undefined,
        },
    ]);

    if (selected === '__search__') {
        return selectModelInteractive(models, { currentModel: currentModelId, initialQuery: '' });
    }

    if (selected === '__manual__') {
        const manual = await promptManualModelId(currentModelId);
        const known = models.find((m) => m.id === manual);
        if (known) return known;
        return {
            id: manual,
            name: manual,
            contextLength: 0,
            pricing: { prompt: 0, completion: 0 },
        };
    }

    const chosen = models.find((m) => m.id === selected);
    if (!chosen) {
        const manual = await promptManualModelId(currentModelId);
        const known = models.find((m) => m.id === manual);
        if (known) return known;
        return {
            id: manual,
            name: manual,
            contextLength: 0,
            pricing: { prompt: 0, completion: 0 },
        };
    }

    if (options.showDetails) printModelDetails(chosen);
    return chosen;
}

export async function selectModelInteractive(
    models: Model[],
    options: { currentModel?: string; initialQuery?: string; maxChoices?: number } = {}
): Promise<Model> {
    const maxChoices = Number.isFinite(options.maxChoices) ? Number(options.maxChoices) : 40;
    const currentModelId = options.currentModel;

    const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
    let query = options.initialQuery ?? '';

    while (true) {
        const { filter } = await inquirer.prompt([
            {
                type: 'input',
                name: 'filter',
                message: 'Search models (enter for popular)',
                default: query,
            },
        ]);

        query = String(filter ?? '').trim();

        const candidatePool = query ? sorted.filter((m) => matches(m, query)) : sorted.filter(popularFilter);
        const limited = candidatePool.slice(0, maxChoices);

        if (limited.length === 0) {
            console.log(colors.warning('No models found. Try a different search.'));
            continue;
        }

        const choices: any[] = limited.map((m) => ({
            name: summarizeModel(m),
            value: m.id,
        }));

        choices.push(new inquirer.Separator());
        choices.push({ name: 'Search again', value: '__search_again__' });
        choices.push({ name: 'Enter model id manually', value: '__manual__' });

        const { selected } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selected',
                message: 'Select a model',
                choices,
                pageSize: 15,
                default: currentModelId ? choices.findIndex(c => (c as any).value === currentModelId) : undefined,
            },
        ]);

        if (selected === '__search_again__') continue;

        if (selected === '__manual__') {
            const manual = await promptManualModelId(currentModelId);
            const known = models.find((m) => m.id === manual);
            if (known) return known;
            return {
                id: manual,
                name: manual,
                contextLength: 0,
                pricing: { prompt: 0, completion: 0 },
            };
        }

        const chosen = models.find((m) => m.id === selected);
        if (!chosen) continue;

        printModelDetails(chosen);

        const { confirm } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'confirm',
                message: `Use ${chosen.id}?`,
                default: true,
            },
        ]);

        if (confirm) return chosen;
    }
}

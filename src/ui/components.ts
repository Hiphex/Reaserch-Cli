/**
 * UI Components - Rich terminal UI elements
 */

import ora, { type Ora } from 'ora';
import boxen from 'boxen';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import gradient from 'gradient-string';
import { colors, icons, createHeader, divider, getBoxOuterWidth, stepLine } from './theme.js';
import type { ResearchPlan, ResearchStep } from '../research/planner.js';

type UiMode = 'minimal' | 'fancy' | 'plain';

function getUiMode(): UiMode {
    if (process.env.NO_COLOR !== undefined) return 'plain';
    const ui = process.env.UI_MODE?.trim().toLowerCase();
    if (ui === 'plain') return 'plain';
    if (ui === 'fancy') {
        const isInteractive = Boolean(process.stdout.isTTY && process.stderr.isTTY);
        return isInteractive ? 'fancy' : 'minimal';
    }
    return 'minimal';
}

/**
 * Display the app header
 */
export function showHeader(options: { title?: string; model?: string; query?: string; showDivider?: boolean } = {}): void {
    const { title = 'Deep Research', model, query } = options;
    const showDivider = options.showDivider !== false;
    const mode = getUiMode();

    console.log();

    if (mode === 'fancy') {
        const heading = gradient(['#6D28D9', '#7C3AED', '#4F46E5', '#06B6D4'])(title);
        const lines: string[] = [heading];
        if (model) lines.push(colors.muted(`Model: ${model}`));
        if (query) lines.push(colors.muted(`Query: ${query}`));

        console.log(
            boxen(lines.join('\n'), {
                padding: 1,
                borderStyle: 'round',
                borderColor: '#7C3AED',
                width: getBoxOuterWidth(),
            })
        );
        if (showDivider) console.log(colors.muted(divider()));
        return;
    }

    console.log(createHeader(title, model ? `Model: ${model}` : undefined));
    if (query) console.log(colors.muted(`Query: ${query}`));
    if (showDivider) console.log(colors.muted(divider()));
}

/**
 * Create a spinner with custom styling
 */
export function createSpinner(text: string): Ora {
    const mode = getUiMode();
    return ora({
        text: mode === 'fancy' ? colors.secondary(text) : colors.muted(text),
        spinner: mode === 'fancy' ? 'dots12' : 'dots',
        color: mode === 'fancy' ? 'cyan' : undefined,
    });
}

export function renderMarkdown(markdown: string): string {
    const width = typeof process.stdout.columns === 'number' && process.stdout.columns > 0
        ? Math.min(process.stdout.columns, 100)
        : 80;

    marked.setOptions({
        renderer: new TerminalRenderer({
            width,
            emoji: false,
            showSectionPrefix: false,
            reflowText: true,
        }),
    });

    return marked.parse(markdown) as string;
}

/**
 * Display the research plan
 */
export function showResearchPlan(plan: ResearchPlan): void {
    const mode = getUiMode();

    if (mode === 'fancy') {
        const lines = plan.steps
            .map((step, i) => {
                const statusIcon = colors.muted(icons.pending);
                const question = `${colors.dim(`${i + 1}.`)} ${step.question}`;
                const purpose = step.purpose ? `\n${colors.muted(step.purpose)}` : '';
                return `${statusIcon} ${question}${purpose}`;
            })
            .join('\n\n');

        console.log();
        console.log(
            boxen(lines, {
                padding: 1,
                borderStyle: 'round',
                borderColor: '#7C3AED',
                title: 'Plan',
                titleAlignment: 'left',
                width: getBoxOuterWidth(),
            })
        );
        return;
    }

    console.log();
    console.log(colors.primary('Plan'));
    console.log(colors.muted(plan.mainQuestion));
    console.log();

    plan.steps.forEach((step, i) => {
        console.log(`${colors.dim(`${i + 1}.`)} ${step.question}`);
        if (step.purpose) console.log(colors.muted(`   ${step.purpose}`));
    });
}

/**
 * Show progress tree for research execution
 */
export function showProgressTree(steps: ResearchStep[]): void {
    const mode = getUiMode();

    const lines = steps.map((step, index) => {
        const line = stepLine(index, steps.length, step.question, step.status);
        const sourceCount = step.status === 'complete' && step.results
            ? step.results.results?.length || 0
            : 0;

        const suffix = step.status === 'complete'
            ? colors.muted(`(${sourceCount} sources)`)
            : '';

        return suffix ? `${line} ${suffix}` : line;
    });

    console.log();

    if (mode === 'fancy') {
        console.log(
            boxen(lines.join('\n'), {
                padding: 1,
                borderStyle: 'round',
                borderColor: '#06B6D4',
                title: 'Search Summary',
                titleAlignment: 'left',
                width: getBoxOuterWidth(),
            })
        );
        return;
    }

    console.log(colors.primary('Search Summary'));
    console.log();
    lines.forEach((l) => console.log(l));
}

/**
 * Show synthesis header
 */
export function showSynthesisHeader(): void {
    const mode = getUiMode();
    console.log();
    if (mode === 'fancy') {
        console.log(
            boxen(colors.primary('Report'), {
                padding: { top: 0, bottom: 0, left: 1, right: 1 },
                borderStyle: 'round',
                borderColor: '#7C3AED',
                width: getBoxOuterWidth(),
            })
        );
        return;
    }
    console.log(colors.primary('Report'));
    console.log(colors.muted(divider()));
}

/**
 * Stream output character by character with typing effect
 */
export async function streamOutput(generator: AsyncGenerator<string>): Promise<string> {
    let fullOutput = '';

    for await (const chunk of generator) {
        process.stdout.write(chunk);
        fullOutput += chunk;
    }

    if (!fullOutput.endsWith('\n')) process.stdout.write('\n');

    return fullOutput;
}

/**
 * Show completion message
 */
export function showComplete(outputPath?: string): void {
    const mode = getUiMode();
    console.log();
    if (mode === 'fancy') {
        const msg = gradient(['#10B981', '#06B6D4'])('Done');
        console.log(`${colors.success(icons.complete)} ${msg}`);
        if (outputPath) console.log(colors.muted(`Saved to: ${outputPath}`));
        return;
    }

    console.log(`${colors.success(icons.complete)} ${colors.success('Done')}`);
    if (outputPath) console.log(colors.muted(`Saved to: ${outputPath}`));
}

/**
 * Show error message
 */
export function showError(message: string): void {
    const mode = getUiMode();
    if (mode === 'fancy') {
        console.error(
            boxen(`${colors.error('Error')}\n${message}`, {
                padding: 1,
                borderStyle: 'round',
                borderColor: 'red',
                width: getBoxOuterWidth(),
            })
        );
        return;
    }
    console.error(`${colors.error(icons.error)} ${colors.error('Error:')} ${message}`);
}

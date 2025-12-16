/**
 * UI Theme - Design system for the CLI
 * Provides consistent styling with a clean, minimal palette
 */

import chalk from 'chalk';
import figures from 'figures';

function isPlainMode(): boolean {
    const ui = process.env.UI_MODE?.trim().toLowerCase();
    return ui === 'plain' || process.env.NO_COLOR !== undefined;
}

function maybeColor(styler: (text: string) => string): (text: string) => string {
    return (text: string) => (isPlainMode() ? text : styler(text));
}

export function getBoxOuterWidth(maxWidth: number = 112): number {
    const columns = process.stdout.columns;
    const fallback = maxWidth;
    if (typeof columns !== 'number' || columns <= 0) return fallback;
    // Keep a small margin to avoid terminal soft-wrapping at the right edge.
    return Math.min(maxWidth, Math.max(0, columns - 2));
}

export function getBoxInnerWidth(maxInnerWidth: number = 110): number {
    return Math.max(0, getBoxOuterWidth(maxInnerWidth + 2) - 2);
}

// Color palette
export const colors = {
    primary: maybeColor(chalk.hex('#7C3AED')),      // Violet (accent)
    secondary: maybeColor(chalk.hex('#06B6D4')),    // Cyan (secondary accent)
    success: maybeColor(chalk.hex('#10B981')),      // Green
    warning: maybeColor(chalk.hex('#F59E0B')),      // Amber
    error: maybeColor(chalk.hex('#EF4444')),        // Red
    muted: maybeColor(chalk.gray),
    dim: maybeColor(chalk.dim),
};

// Gradient presets (kept for backwards compatibility, implemented as simple styles)
export const gradients = {
    title: (text: string) => (isPlainMode() ? text : chalk.bold(colors.primary(text))),
    progress: (text: string) => colors.secondary(text),
    success: (text: string) => (isPlainMode() ? text : chalk.bold(colors.success(text))),
    error: (text: string) => (isPlainMode() ? text : chalk.bold(colors.error(text))),
};

// Status/icons (use `figures` for OS-safe fallbacks)
export const icons = {
    pending: figures.circle,
    inProgress: figures.ellipsis,
    complete: figures.tick,
    error: figures.cross,
    arrow: figures.arrowRight,
    bullet: figures.bullet,
    star: figures.star,
    search: figures.pointerSmall,
    brain: figures.circleQuestionMark,
    document: figures.square,
    lightning: figures.warning,
    sparkles: figures.star,
};

export function divider(maxWidth: number = 60): string {
    const columns = process.stdout.columns;
    const width = typeof columns === 'number' && columns > 0 ? Math.min(columns, maxWidth) : maxWidth;
    return '─'.repeat(Math.max(0, width));
}

/**
 * Create a styled header box
 */
export function createHeader(title: string, subtitle?: string): string {
    const parts = [gradients.title(title)];
    if (subtitle) parts.push(colors.muted(subtitle));
    return parts.join(' ');
}

/**
 * Create a section header
 */
export function sectionHeader(icon: string, title: string): string {
    return `\n${colors.primary(title)}\n`;
}

/**
 * Format a step status line
 */
export function stepLine(
    index: number,
    total: number,
    text: string,
    status: 'pending' | 'inProgress' | 'complete' | 'error'
): string {
    const statusIcon = {
        pending: colors.muted(icons.pending),
        inProgress: colors.secondary(icons.inProgress),
        complete: colors.success(icons.complete),
        error: colors.error(icons.error),
    }[status];

    const textColor = status === 'pending' ? colors.muted : (isPlainMode() ? ((s: string) => s) : chalk.white);

    const indexLabel = colors.dim(`${index + 1}/${total}`);
    return `${statusIcon} ${indexLabel} ${textColor(text)}`;
}

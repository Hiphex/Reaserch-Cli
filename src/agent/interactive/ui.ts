import { colors, getBoxInnerWidth } from '../../ui/theme.js';
import stringWidth from 'string-width';
import { AgentState } from './state.js';

// eslint-disable-next-line no-control-regex
export const stripAnsi = (input: string): string => input.replace(/\x1b\[[0-9;]*m/g, '');
export const visibleWidth = (input: string): number => stringWidth(stripAnsi(input));

export const truncateText = (input: string, maxWidth: number): string => {
    const text = String(input ?? '');
    if (maxWidth <= 0) return '';
    if (visibleWidth(text) <= maxWidth) return text;
    if (maxWidth === 1) return '…';

    const target = maxWidth - 1;
    let out = '';
    for (const ch of text) {
        const next = out + ch;
        if (visibleWidth(next) > target) break;
        out = next;
    }
    return out + '…';
};

export const wrapText = (input: string, maxWidth: number): string[] => {
    const text = String(input ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return [''];
    if (maxWidth <= 0) return [''];
    if (visibleWidth(text) <= maxWidth) return [text];

    const words = text.split(' ').filter(Boolean);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (visibleWidth(candidate) <= maxWidth) {
            current = candidate;
            continue;
        }

        if (current) {
            lines.push(current);
            current = '';
        }

        if (visibleWidth(word) <= maxWidth) {
            current = word;
            continue;
        }

        lines.push(truncateText(word, maxWidth));
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
};

export const renderInfoBox = (title: string, bodyLines: string[]): string => {
    const boxWidth = getBoxInnerWidth();
    const lines: string[] = [];
    const titleText = ` ${title} `;
    const headerInnerRaw = `─${titleText}`;
    let headerInner = headerInnerRaw;
    let headerW = visibleWidth(headerInner);
    if (headerW > boxWidth) {
        headerInner = truncateText(stripAnsi(headerInnerRaw), boxWidth);
        headerW = visibleWidth(headerInner);
    }
    if (headerW < boxWidth) {
        headerInner = headerInner + '─'.repeat(boxWidth - headerW);
    }

    lines.push(colors.muted(`╭${headerInner}╮`));
    lines.push(colors.muted(`│${' '.repeat(boxWidth)}│`));

    bodyLines.forEach((line) => {
        const safe = truncateText(line, boxWidth);
        const pad = Math.max(0, boxWidth - visibleWidth(safe));
        lines.push(colors.muted('│') + safe + ' '.repeat(pad) + colors.muted('│'));
    });

    lines.push(colors.muted(`│${' '.repeat(boxWidth)}│`));
    lines.push(colors.muted(`╰${'─'.repeat(boxWidth)}╯`));
    return lines.join('\n');
};

export const renderBox = (title: string, states: AgentState[]) => {
    const boxWidth = getBoxInnerWidth();
    const lines: string[] = [];
    const completedCount = states.filter(s => s.complete).length;
    const titleText = ` ${title} (${completedCount}/${states.length} complete) `;
    const headerInnerRaw = `─${titleText}`;
    const headerInner = headerInnerRaw.length >= boxWidth
        ? headerInnerRaw.slice(0, boxWidth)
        : headerInnerRaw + '─'.repeat(boxWidth - headerInnerRaw.length);

    lines.push(colors.muted(`╭${headerInner}╮`));
    lines.push(colors.muted(`│${' '.repeat(boxWidth)}│`));

    states.forEach((s, i) => {
        const isFailed = s.failed;
        const iconChar = isFailed ? '✗' : s.complete ? '✓' : '◐';
        const icon = isFailed
            ? colors.error(iconChar)
            : s.complete
                ? colors.success(iconChar)
                : colors.warning(iconChar);
        const num = `${i + 1}.`;
        const statusRaw = isFailed ? s.status : s.complete ? `(${s.sources} sources)` : s.status;

        const prefixPlain = `  ${iconChar} ${num} `;
        const prefixStyled = `  ${icon} ${num} `;

        const available = Math.max(0, boxWidth - visibleWidth(prefixPlain));
        const gapMin = Math.min(2, available);

        const statusMax = Math.min(40, Math.max(0, available - gapMin));
        const statusInfo = truncateText(statusRaw, statusMax);

        const statusW = visibleWidth(statusInfo);
        const questionMax = Math.max(0, available - gapMin - statusW);
        const q = truncateText(s.question, questionMax);

        const qW = visibleWidth(q);
        const gapLen = available - qW - statusW;
        const gap = ' '.repeat(Math.max(gapMin, gapLen));

        const statusStyle = isFailed ? colors.error : colors.muted;
        const content = `${prefixStyled}${q}${gap}${statusStyle(statusInfo)}`;
        const pad = Math.max(0, boxWidth - visibleWidth(content));

        lines.push(colors.muted('│') + content + ' '.repeat(pad) + colors.muted('│'));
    });

    lines.push(colors.muted(`│${' '.repeat(boxWidth)}│`));
    lines.push(colors.muted(`╰${'─'.repeat(boxWidth)}╯`));

    return lines.join('\n');
};

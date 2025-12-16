export function envBool(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function envOptionalNumber(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function envOptionalInt(value: string | undefined): number | undefined {
    const parsed = envOptionalNumber(value);
    if (parsed === undefined) return undefined;
    return Number.isInteger(parsed) ? parsed : undefined;
}

export function envPositiveInt(value: string | undefined, defaultValue: number): number {
    const parsed = envOptionalInt(value);
    if (typeof parsed !== 'number' || parsed < 1) return defaultValue;
    return parsed;
}

export function envNonNegativeInt(value: string | undefined, defaultValue: number): number {
    const parsed = envOptionalInt(value);
    if (typeof parsed !== 'number' || parsed < 0) return defaultValue;
    return parsed;
}

export function envIntOrInfinity(value: string | undefined, defaultValue: number): number {
    const trimmed = value?.trim();
    if (!trimmed) return defaultValue;

    const normalized = trimmed.toLowerCase();
    if (normalized === 'unlimited' || normalized === 'infinite' || normalized === 'inf') {
        return Number.POSITIVE_INFINITY;
    }

    const parsed = envOptionalInt(trimmed);
    if (typeof parsed !== 'number') return defaultValue;
    if (parsed < 0) return Number.POSITIVE_INFINITY;
    return parsed;
}


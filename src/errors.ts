/**
 * Custom error types for the Deep Research CLI
 * Provides better error handling and user-friendly messages
 */

/**
 * Base error class for Deep Research CLI errors
 */
export class DeepResearchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeepResearchError';
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when an API key is missing or invalid
 */
export class ApiKeyError extends DeepResearchError {
    public readonly keyName: string;
    public readonly helpUrl?: string;

    constructor(keyName: string, message?: string, helpUrl?: string) {
        const defaultMessage = `${keyName} is not set or invalid.\n` +
            `Run: research init\n` +
            (helpUrl ? `Get your key at: ${helpUrl}` : '');
        super(message || defaultMessage);
        this.name = 'ApiKeyError';
        this.keyName = keyName;
        this.helpUrl = helpUrl;
    }
}

/**
 * Error thrown when API rate limits are exceeded
 */
export class RateLimitError extends DeepResearchError {
    public readonly retryAfterMs?: number;

    constructor(service: string, retryAfterMs?: number) {
        const retryMessage = retryAfterMs
            ? ` Please wait ${Math.ceil(retryAfterMs / 1000)} seconds and try again.`
            : ' Please wait a moment and try again.';
        super(`${service} rate limit exceeded.${retryMessage}`);
        this.name = 'RateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Error thrown when configuration is invalid or incomplete
 */
export class ConfigError extends DeepResearchError {
    public readonly configKey?: string;

    constructor(message: string, configKey?: string) {
        super(message);
        this.name = 'ConfigError';
        this.configKey = configKey;
    }
}

/**
 * Error thrown when research planning fails
 */
export class PlanningError extends DeepResearchError {
    constructor(message: string) {
        super(message);
        this.name = 'PlanningError';
    }
}

/**
 * Error thrown when search execution fails
 */
export class SearchError extends DeepResearchError {
    public readonly query?: string;

    constructor(message: string, query?: string) {
        super(message);
        this.name = 'SearchError';
        this.query = query;
    }
}

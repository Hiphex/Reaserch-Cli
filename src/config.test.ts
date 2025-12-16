/**
 * Unit tests for configuration management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the environment before importing config
const originalEnv = process.env;

describe('Config utilities', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('loadConfig', () => {
        it('should load default values when env vars are not set', async () => {
            // Clear relevant env vars
            delete process.env.EXA_API_KEY;
            delete process.env.OPENROUTER_API_KEY;
            delete process.env.DEFAULT_MODEL;

            const { loadConfig } = await import('./config.js');
            const config = loadConfig();

            expect(config.exaApiKey).toBe('');
            expect(config.openrouterApiKey).toBe('');
            expect(config.defaultModel).toBe('moonshotai/kimi-k2-thinking');
            expect(config.uiMode).toBe('fancy');
            expect(config.streamOutput).toBe(true);
        });

        it('should load values from environment variables', async () => {
            process.env.EXA_API_KEY = 'test-exa-key';
            process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
            process.env.DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
            process.env.UI_MODE = 'minimal';

            const { loadConfig } = await import('./config.js');
            const config = loadConfig();

            expect(config.exaApiKey).toBe('test-exa-key');
            expect(config.openrouterApiKey).toBe('test-openrouter-key');
            expect(config.defaultModel).toBe('anthropic/claude-3.5-sonnet');
            expect(config.uiMode).toBe('minimal');
        });

        it('should parse boolean env vars correctly', async () => {
            process.env.STREAM_OUTPUT = '0';
            process.env.SHOW_REASONING = 'true';
            process.env.AUTO_FOLLOWUP = 'yes';

            const { loadConfig } = await import('./config.js');
            const config = loadConfig();

            expect(config.streamOutput).toBe(false);
            expect(config.showReasoning).toBe(true);
            expect(config.autoFollowup).toBe(true);
        });

        it('should parse reasoning effort correctly', async () => {
            process.env.MODEL_REASONING_EFFORT = 'high';

            const { loadConfig } = await import('./config.js');
            const config = loadConfig();

            expect(config.modelReasoningEffort).toBe('high');
        });

        it('should parse optional number values', async () => {
            process.env.MODEL_MAX_TOKENS = '4096';
            process.env.MODEL_TEMPERATURE = '0.7';

            const { loadConfig } = await import('./config.js');
            const config = loadConfig();

            expect(config.modelMaxTokens).toBe(4096);
            expect(config.modelTemperature).toBe(0.7);
        });
    });

    describe('validateConfig', () => {
        it('should return valid when all required keys are present', async () => {
            process.env.EXA_API_KEY = 'test-exa-key';
            process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

            const { loadConfig, validateConfig } = await import('./config.js');
            const config = loadConfig();
            const result = validateConfig(config);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should return errors when EXA_API_KEY is missing', async () => {
            delete process.env.EXA_API_KEY;
            process.env.OPENROUTER_API_KEY = 'test-key';

            const { loadConfig, validateConfig } = await import('./config.js');
            const config = loadConfig();
            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('EXA_API_KEY is not set');
        });

        it('should return errors when OPENROUTER_API_KEY is missing', async () => {
            process.env.EXA_API_KEY = 'test-key';
            delete process.env.OPENROUTER_API_KEY;

            const { loadConfig, validateConfig } = await import('./config.js');
            const config = loadConfig();
            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('OPENROUTER_API_KEY is not set');
        });

        it('should skip validation for unrequired keys', async () => {
            delete process.env.EXA_API_KEY;
            process.env.OPENROUTER_API_KEY = 'test-key';

            const { loadConfig, validateConfig } = await import('./config.js');
            const config = loadConfig();
            const result = validateConfig(config, { exa: false, openrouter: true });

            expect(result.valid).toBe(true);
        });
    });
});


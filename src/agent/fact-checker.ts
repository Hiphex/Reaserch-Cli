/**
 * Fact-Checker Agent
 * Verifies claims in research reports against source text
 */

import { OpenRouterClient, type Message } from '../clients/openrouter.js';
import type { ExaSearchResult } from '../clients/exa.js';

const CLAIM_EXTRACTION_PROMPT = `You are a fact-checking assistant. Extract specific, verifiable factual claims from the research report.

Focus on:
- Statistics, percentages, and numerical data
- Dates, timelines, and historical facts
- Direct quotes attributed to specific sources
- Scientific or technical claims

Return ONLY JSON:
{"claims": ["claim 1", "claim 2", ...]}

Maximum 10 claims. Focus on the most important and specific claims.
If no verifiable claims are present, return: {"claims": []}`;

const CLAIM_VERIFICATION_PROMPT = `You are a fact-checking assistant. Given a specific claim and source text, determine if the claim is supported.

Verification rules:
- "verified": The source text explicitly supports the claim
- "partially_verified": The source text supports part of the claim or the claim is close but not exact
- "unverified": The source text does not mention or support this claim

Return ONLY JSON:
{
  "status": "verified" | "partially_verified" | "unverified",
  "evidence": "brief quote or explanation from source (max 100 chars)",
  "confidence": 0.0-1.0
}`;

export interface ClaimVerification {
    claim: string;
    status: 'verified' | 'partially_verified' | 'unverified';
    evidence?: string;
    confidence: number;
    sourceUrl?: string;
}

export interface VerificationResult {
    totalClaims: number;
    verifiedCount: number;
    partiallyVerifiedCount: number;
    unverifiedCount: number;
    claims: ClaimVerification[];
}

export class FactChecker {
    private client: OpenRouterClient;
    private model: string;

    constructor(client: OpenRouterClient, model?: string) {
        this.client = client;
        // Use a fast model for fact-checking
        this.model = model || 'google/gemini-2.0-flash-001';
    }

    /**
     * Verify claims in a report against provided sources
     */
    async verify(report: string, sources: ExaSearchResult[]): Promise<VerificationResult> {
        // 1. Extract claims from the report
        const claims = await this.extractClaims(report);

        if (claims.length === 0) {
            return {
                totalClaims: 0,
                verifiedCount: 0,
                partiallyVerifiedCount: 0,
                unverifiedCount: 0,
                claims: [],
            };
        }

        // 2. Build a source text map for verification
        const sourceTexts = sources
            .filter(s => s.text || s.summary || s.highlights?.length)
            .slice(0, 10) // Limit sources to check
            .map(s => ({
                url: s.url,
                text: (s.text || s.summary || s.highlights?.join(' ') || '').slice(0, 3000),
            }));

        // 3. Verify each claim against sources
        const verifications: ClaimVerification[] = [];

        for (const claim of claims) {
            const verification = await this.verifyClaim(claim, sourceTexts);
            verifications.push(verification);
        }

        // 4. Calculate summary stats
        const verifiedCount = verifications.filter(v => v.status === 'verified').length;
        const partiallyVerifiedCount = verifications.filter(v => v.status === 'partially_verified').length;
        const unverifiedCount = verifications.filter(v => v.status === 'unverified').length;

        return {
            totalClaims: claims.length,
            verifiedCount,
            partiallyVerifiedCount,
            unverifiedCount,
            claims: verifications,
        };
    }

    /**
     * Extract verifiable claims from a report
     */
    private async extractClaims(report: string): Promise<string[]> {
        try {
            const messages: Message[] = [
                { role: 'system', content: CLAIM_EXTRACTION_PROMPT },
                { role: 'user', content: report.slice(0, 8000) }, // Limit input size
            ];

            const response = await this.client.chat(this.model, messages, { temperature: 0.2 });
            const content = response.choices[0]?.message?.content?.trim() || '';

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed.claims)) {
                    return parsed.claims
                        .filter((c: any) => typeof c === 'string' && c.trim())
                        .slice(0, 10);
                }
            }

            return [];
        } catch {
            return [];
        }
    }

    /**
     * Verify a single claim against source texts
     */
    private async verifyClaim(
        claim: string,
        sources: Array<{ url: string; text: string }>
    ): Promise<ClaimVerification> {
        // Try to find a source that can verify this claim
        for (const source of sources) {
            try {
                const messages: Message[] = [
                    { role: 'system', content: CLAIM_VERIFICATION_PROMPT },
                    {
                        role: 'user',
                        content: `Claim: "${claim}"\n\nSource text:\n${source.text}`,
                    },
                ];

                const response = await this.client.chat(this.model, messages, { temperature: 0.1 });
                const content = response.choices[0]?.message?.content?.trim() || '';

                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    const status = parsed.status === 'verified' || parsed.status === 'partially_verified'
                        ? parsed.status
                        : 'unverified';

                    if (status === 'verified' || status === 'partially_verified') {
                        return {
                            claim,
                            status,
                            evidence: typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 150) : undefined,
                            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
                            sourceUrl: source.url,
                        };
                    }
                }
            } catch {
                // Continue to next source
            }
        }

        // No source verified this claim
        return {
            claim,
            status: 'unverified',
            confidence: 0,
        };
    }

    /**
     * Format verification results as markdown for appending to report
     */
    formatAsMarkdown(result: VerificationResult): string {
        if (result.totalClaims === 0) {
            return '';
        }

        const lines: string[] = [];
        lines.push('\n\n---\n\n## Verification Summary\n');

        const verificationRate = ((result.verifiedCount + result.partiallyVerifiedCount * 0.5) / result.totalClaims * 100).toFixed(0);
        lines.push(`> [!NOTE]`);
        lines.push(`> **${result.verifiedCount}** of **${result.totalClaims}** claims verified (${verificationRate}% confidence)`);
        lines.push('');

        if (result.unverifiedCount > 0) {
            lines.push('> [!CAUTION]');
            lines.push(`> **${result.unverifiedCount}** claim(s) could not be verified against sources.`);
            lines.push('');
        }

        // List unverified claims
        const unverifiedClaims = result.claims.filter(c => c.status === 'unverified');
        if (unverifiedClaims.length > 0) {
            lines.push('### Unverified Claims\n');
            unverifiedClaims.slice(0, 5).forEach((c, i) => {
                lines.push(`${i + 1}. *"${c.claim.slice(0, 100)}${c.claim.length > 100 ? '...' : ''}"*`);
            });
            if (unverifiedClaims.length > 5) {
                lines.push(`\n*...and ${unverifiedClaims.length - 5} more*`);
            }
        }

        return lines.join('\n');
    }
}

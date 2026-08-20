import { createHash } from "node:crypto";

import type { ProviderFailure } from "../model/provider-failure.ts";

const DEFAULT_TTL_MS = 60_000;
const PROMPT_ESTIMATE_MARGIN = 1.05;

interface PromptAllowanceEntry {
    readonly kind: "prompt_tokens";
    readonly available: number;
    readonly tokensPerByte: number;
    readonly expiresAt: number;
}

interface MaxTokensAllowanceEntry {
    readonly kind: "max_tokens";
    readonly available: number;
    readonly expiresAt: number;
}

type AllowanceEntry = PromptAllowanceEntry | MaxTokensAllowanceEntry;

export interface OpenRouterAllowanceRequest {
    readonly scope: string;
    readonly model: string;
    readonly promptBytes: number;
    readonly maxTokens?: number;
}

/**
 * Short-lived evidence shared by every adapter in one resident host. OpenRouter
 * reports a key allowance only after refusing a request, so this prevents the
 * sibling-session stampede after that first refusal without pretending the
 * allowance is stable across a top-up or key change.
 */
export class OpenRouterAllowanceGuard {
    private readonly entries = new Map<string, AllowanceEntry>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly ttlMs = DEFAULT_TTL_MS,
    ) {}

    observe(
        request: OpenRouterAllowanceRequest,
        allowance: NonNullable<ProviderFailure["allowance"]>,
    ): void {
        const expiresAt = this.now() + this.ttlMs;
        if (allowance.kind === "prompt_tokens") {
            if (request.promptBytes <= 0) return;
            this.entries.set(key(request, allowance.kind), {
                kind: allowance.kind,
                available: allowance.available,
                tokensPerByte: allowance.requested / request.promptBytes,
                expiresAt,
            });
            return;
        }
        this.entries.set(key(request, allowance.kind), {
            kind: allowance.kind,
            available: allowance.available,
            expiresAt,
        });
    }

    preflight(request: OpenRouterAllowanceRequest): ProviderFailure | undefined {
        const prompt = this.active(request, "prompt_tokens");
        if (prompt?.kind === "prompt_tokens") {
            const requested = Math.ceil(
                request.promptBytes * prompt.tokensPerByte * PROMPT_ESTIMATE_MARGIN,
            );
            if (requested > prompt.available) {
                return cachedAllowanceFailure({
                    kind: "prompt_tokens",
                    requested,
                    available: prompt.available,
                });
            }
        }
        const output = this.active(request, "max_tokens");
        if (
            output?.kind === "max_tokens"
            && request.maxTokens !== undefined
            && request.maxTokens > output.available
        ) {
            return cachedAllowanceFailure({
                kind: "max_tokens",
                requested: request.maxTokens,
                available: output.available,
            });
        }
        return undefined;
    }

    private active(
        request: OpenRouterAllowanceRequest,
        kind: AllowanceEntry["kind"],
    ): AllowanceEntry | undefined {
        const id = key(request, kind);
        const entry = this.entries.get(id);
        if (entry !== undefined && entry.expiresAt <= this.now()) {
            this.entries.delete(id);
            return undefined;
        }
        return entry;
    }
}

export function openRouterAllowanceScope(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
}

function key(
    request: Pick<OpenRouterAllowanceRequest, "scope" | "model">,
    kind: AllowanceEntry["kind"],
): string {
    return `${request.scope}:${request.model}:${kind}`;
}

function cachedAllowanceFailure(
    allowance: NonNullable<ProviderFailure["allowance"]>,
): ProviderFailure {
    const noun = allowance.kind === "prompt_tokens"
        ? "prompt tokens"
        : "maximum output tokens";
    const userAction = "Add OpenRouter credits or raise this key's limit, then "
        + "retry. Otherwise switch provider or model.";
    return {
        kind: "payment_required",
        resolution: "user_action",
        message: `OpenRouter recently reported that this key permits only `
            + `${allowance.available.toLocaleString()} ${noun}; this request `
            + `needs about ${allowance.requested.toLocaleString()}. Vera did `
            + `not send it. ${userAction}`,
        providerErrorType: "cached_allowance",
        allowance,
        userAction,
    };
}

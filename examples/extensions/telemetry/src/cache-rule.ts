export interface CacheMissSettings {
    readonly min_reread_tokens: number;
    readonly min_share: number;
}

export const DEFAULT_CACHE_MISS: CacheMissSettings = { min_reread_tokens: 8192, min_share: 0.5 };

/** Calls this far apart are separate work, so the cache may legitimately have expired. */
export const CONTINUITY_MS = 5 * 60 * 1000;
/** A bigger input drop means compaction or a new prompt, which breaks the cache legitimately. */
export const MIN_INPUT_RATIO = 0.7;

export interface CallUsage {
    readonly provider: string;
    readonly model: string;
    /** Includes cached tokens. */
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    /** Milliseconds since the epoch. */
    readonly at: number;
}

export interface CacheMissFinding {
    readonly previous_input_tokens: number;
    readonly previous_cached_input_tokens: number;
    readonly reread_tokens: number;
    readonly gap_ms: number;
}

/** One conversation's calls, compared per call rather than over a window. */
export class CacheMissRule {
    private previous: CallUsage | undefined;
    private readonly cacheReporters = new Set<string>();

    constructor(private readonly settings: CacheMissSettings) {}

    observe(call: CallUsage): CacheMissFinding | undefined {
        // A call that reported no input says nothing about reuse; it also must
        // not replace the last call it could have been compared with.
        if (call.inputTokens <= 0) return undefined;
        if (call.cachedInputTokens > 0) this.cacheReporters.add(call.provider);

        const previous = this.previous;
        this.previous = call;
        if (previous === undefined || !this.continuous(previous, call)) return undefined;
        if (!this.cacheReporters.has(call.provider)) return undefined;

        const floor = Math.min(previous.inputTokens, call.inputTokens);
        const reread = Math.max(0, floor - call.cachedInputTokens);
        if (reread < this.settings.min_reread_tokens) return undefined;
        if (reread < this.settings.min_share * floor) return undefined;
        return {
            previous_input_tokens: previous.inputTokens,
            previous_cached_input_tokens: previous.cachedInputTokens,
            reread_tokens: reread,
            gap_ms: call.at - previous.at,
        };
    }

    private continuous(previous: CallUsage, call: CallUsage): boolean {
        return previous.provider === call.provider
            && previous.model === call.model
            && call.at - previous.at < CONTINUITY_MS
            && call.inputTokens >= MIN_INPUT_RATIO * previous.inputTokens;
    }
}

/** One rule per session, least recently used evicted past capacity. */
export class CacheMissSessions {
    private readonly rules = new Map<string, CacheMissRule>();

    constructor(
        private readonly settings: CacheMissSettings,
        private readonly capacity = 64,
    ) {}

    rule(sessionId: string): CacheMissRule {
        const existing = this.rules.get(sessionId);
        const rule = existing ?? new CacheMissRule(this.settings);
        this.rules.delete(sessionId);
        this.rules.set(sessionId, rule);
        if (this.rules.size > this.capacity) {
            const oldest = this.rules.keys().next().value;
            if (oldest !== undefined) this.rules.delete(oldest);
        }
        return rule;
    }
}

import type { AnnexUrlResult } from "../../src/annex/host-client.ts";
import { findProvider } from "../../src/providers/registry.ts";
import type { SubscriptionLimits, SubscriptionUsageWindow } from "../../src/providers/subscription-limits.ts";

export async function readAnnexSubscriptionLimits(
    readAnnexUrl: () => Promise<AnnexUrlResult>,
    signal: AbortSignal,
): Promise<readonly SubscriptionLimits[]> {
    try {
        const result = await readAnnexUrl();
        signal.throwIfAborted();
        if (!("url" in result)) return [];
        const response = await fetch(new URL("/api/usage/subscriptions", result.url), {
            signal,
            redirect: "error",
        });
        if (!response.ok) return [];
        return decodeLimits(await response.json());
    } catch {
        return [];
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function decodeLimits(value: unknown): SubscriptionLimits[] {
    const limits = record(value)?.limits;
    if (!Array.isArray(limits)) return [];
    return limits.flatMap((value): SubscriptionLimits[] => {
        const limit = record(value);
        if (typeof limit?.provider !== "string"
            || typeof limit.fetchedAt !== "number"
            || !Number.isFinite(limit.fetchedAt)
            || !Array.isArray(limit.windows)) return [];
        const windows = limit.windows.flatMap((value): SubscriptionUsageWindow[] => {
            const window = record(value);
            if (typeof window?.windowMinutes !== "number"
                || !Number.isFinite(window.windowMinutes)
                || window.windowMinutes <= 0
                || typeof window.usedPercent !== "number"
                || !Number.isFinite(window.usedPercent)
                || window.usedPercent < 0 || window.usedPercent > 100
                || typeof window.resetsAt !== "number"
                || !Number.isFinite(window.resetsAt)) return [];
            return [{
                windowMinutes: window.windowMinutes,
                usedPercent: window.usedPercent,
                resetsAt: window.resetsAt,
            }];
        });
        return [{ provider: limit.provider, fetchedAt: limit.fetchedAt, windows }];
    });
}

export function subscriptionLimitsText(
    limits: readonly SubscriptionLimits[],
    provider: string | undefined,
    now = Date.now(),
): string {
    return subscriptionLimitsForms(limits, provider, now)[0] ?? "";
}

// Longest first: every window with "left", every window without it, the
// shortest window alone. Empty when the provider has no live window.
export function subscriptionLimitsForms(
    limits: readonly SubscriptionLimits[],
    provider: string | undefined,
    now = Date.now(),
): string[] {
    const windows = limits.find((limit) => limit.provider === provider)?.windows ?? [];
    const parts = windows.filter((window) => window.resetsAt > now)
        .toSorted((left, right) => left.windowMinutes - right.windowMinutes)
        .map((window) => {
            const label = window.windowMinutes === 10_080 ? "week"
                : window.windowMinutes % 60 === 0 ? `${window.windowMinutes / 60}h`
                : `${window.windowMinutes}m`;
            return `${label} ${Math.round(100 - window.usedPercent)}%`;
        });
    if (parts.length === 0) return [];
    const forms = [
        parts.map((part) => `${part} left`).join(" · "),
        parts.join(" · "),
        parts[0]!,
    ];
    return forms.filter((form, index) => forms.indexOf(form) === index);
}

export interface SubscriptionLimitsPollerOptions {
    readonly read: (signal: AbortSignal) => Promise<readonly SubscriptionLimits[]>;
    readonly onChange: () => void;
    readonly now?: () => number;
    readonly refreshMs?: number;
}

export class SubscriptionLimitsPoller {
    private provider: string | undefined;
    private limits: readonly SubscriptionLimits[] = [];
    private request: AbortController | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopped = false;

    constructor(private readonly options: SubscriptionLimitsPollerOptions) {}

    selectProvider(provider: string | undefined): void {
        const selected = provider !== undefined && findProvider(provider)?.access === "subscription"
            ? provider : undefined;
        if (this.stopped || selected === this.provider) return;
        clearTimeout(this.timer);
        this.request?.abort();
        this.provider = selected;
        this.limits = [];
        if (selected !== undefined) void this.refresh(selected);
    }

    text(): string {
        return subscriptionLimitsText(this.limits, this.provider, this.now());
    }

    forms(): string[] {
        return subscriptionLimitsForms(this.limits, this.provider, this.now());
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        this.request?.abort();
        this.limits = [];
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async refresh(provider: string): Promise<void> {
        const request = new AbortController();
        this.request = request;
        this.options.onChange();
        if (this.stopped || request.signal.aborted) return;
        try {
            const limits = await this.options.read(AbortSignal.any([
                request.signal, AbortSignal.timeout(7_000),
            ]));
            if (this.stopped || request.signal.aborted || this.request !== request) return;
            this.limits = limits;
        } catch {
            if (this.stopped || request.signal.aborted || this.request !== request) return;
            this.limits = [];
        }
        this.request = undefined;
        this.options.onChange();
        if (this.stopped || this.provider !== provider) return;
        const now = this.now();
        const resetDelays = this.limits.filter((limit) => limit.provider === provider)
            .flatMap((limit) => limit.windows)
            .filter((window) => window.resetsAt > now)
            .map((window) => window.resetsAt - now);
        const delay = Math.min(this.options.refreshMs ?? 60_000, ...resetDelays);
        this.timer = setTimeout(() => void this.refresh(provider), Math.max(1, delay));
    }
}

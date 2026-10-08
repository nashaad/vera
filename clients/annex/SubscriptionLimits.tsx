import { useEffect, useState } from "react";

import type { SubscriptionLimits } from "../../src/providers/subscription-limits.ts";

const POLL_MS = 60_000;
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
    "openai-codex": "ChatGPT / Codex",
};

export function SubscriptionLimitsPanel() {
    const [limits, setLimits] = useState<readonly SubscriptionLimits[]>([]);
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            setLimits((current) => current.map((entry) => ({
                ...entry,
                windows: entry.windows.filter((window) => window.resetsAt > Date.now()),
            })).filter((entry) => entry.windows.length > 0));
            let next: readonly SubscriptionLimits[] = [];
            try {
                const response = await fetch("/api/usage/subscriptions", {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]),
                });
                if (response.ok) {
                    const data = await response.json() as { limits: readonly SubscriptionLimits[] };
                    next = data.limits;
                }
            } catch {
            }
            if (controller.signal.aborted) return;
            setLimits(next);
            const delay = Math.min(POLL_MS, ...next.flatMap((entry) =>
                entry.windows.map((window) => Math.max(1_000, window.resetsAt - Date.now()))
            ));
            timer = setTimeout(() => void poll(), delay);
        };
        void poll();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, []);
    return <SubscriptionLimitsView limits={limits} />;
}

export function SubscriptionLimitsView({ limits }: {
    readonly limits: readonly SubscriptionLimits[];
}) {
    if (limits.length === 0) return null;
    return (
        <section className="panel subscription-limits" aria-label="Subscription limits">
            <h2>Subscription limits</h2>
            <p className="note">Account-wide, including work outside Vera.</p>
            {limits.map((entry) => (
                <div className="subscription-provider" key={entry.provider}>
                    <div className="subscription-heading">
                        <span>{providerLabel(entry.provider)}</span>
                        <span className="meta">Updated {new Date(entry.fetchedAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="subscription-windows">
                        {entry.windows.map((window, index) => (
                            <div className="subscription-window" key={`${window.windowMinutes}-${index}`}>
                                <div className="subscription-window-heading">
                                    <span>{windowLabel(window.windowMinutes)}</span>
                                    <strong>{Number((100 - window.usedPercent).toFixed(1))}% left</strong>
                                </div>
                                <meter
                                    min={0}
                                    max={100}
                                    value={100 - window.usedPercent}
                                    aria-label={`${windowLabel(window.windowMinutes)} remaining`}
                                />
                                <span className="meta">Resets {new Date(window.resetsAt).toLocaleString()}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </section>
    );
}

function providerLabel(provider: string): string {
    return PROVIDER_LABELS[provider] ?? provider;
}

function windowLabel(minutes: number): string {
    if (minutes === 300) return "5 hours";
    if (minutes === 10_080) return "Weekly";
    if (minutes % 1_440 === 0) return durationLabel(minutes / 1_440, "day");
    if (minutes % 60 === 0) return durationLabel(minutes / 60, "hour");
    return durationLabel(minutes, "minute");
}

function durationLabel(amount: number, unit: string): string {
    return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

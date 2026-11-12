import type { ModelSettings, ProviderCatalog } from "../../models/settings.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// The line under a provider's name: its catalog size, then when it last listed its models.
export function providerDescription(settings: ModelSettings, provider: ProviderCatalog, now: number): string {
    const count = settings.catalog.filter((entry) => entry.provider === provider.id).length;
    const models = count === 1 ? "1 model" : `${count} models`;
    const listed = provider.refreshedAt === undefined ? undefined : listedLabel(provider.refreshedAt, now);
    return listed === undefined ? models : `${models} · listed ${listed}`;
}

// Recent listings read as an age; older ones as a local calendar date. Undefined when the stamp does not parse.
export function listedLabel(refreshedAt: string, now: number): string | undefined {
    const at = Date.parse(refreshedAt);
    if (Number.isNaN(at)) return undefined;
    const elapsed = Math.max(0, now - at);
    if (elapsed < MINUTE) return "just now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
    if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
    return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

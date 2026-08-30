import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import { effectiveCatalog } from "../model/catalog.ts";
import type { ModelPricing } from "../model/catalog-shape.ts";
import type { ModelUsage } from "../model/types.ts";
import {
    readSessionIndexMetadata,
    sessionIsSubagent,
    type SessionHeader,
} from "../store/session-store.ts";

/**
 * One dated fold of this runtime's session files. Clients render it; they do
 * not re-scan JSONL for cost.
 */
export type UsageWindowId = "today" | "7d" | "30d" | "all";

export type UsageCostKind = "reported" | "estimated" | "mixed" | "unpriced";

export interface UsageWindow {
    readonly id: UsageWindowId;
    readonly start: string;
    readonly end: string;
}

export interface UsageMoney {
    readonly reported: number;
    readonly estimated: number;
    readonly combined: number;
    readonly unpricedCalls: number;
}

export interface UsageTotals {
    readonly spend: UsageMoney;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly totalTokens: number;
    readonly cacheHitRatio: number;
    readonly blendedPerMillion: number | undefined;
}

export interface UsageTimelinePoint {
    readonly date: string;
    readonly spend: number;
    readonly byModel: readonly {
        readonly provider: string;
        readonly model: string;
        readonly spend: number;
    }[];
}

export interface UsageModelRow {
    readonly provider: string;
    readonly model: string;
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly spend: number;
    readonly share: number;
    readonly kind: UsageCostKind;
}

export interface UsageSessionRow {
    readonly id: string;
    readonly title: string;
    readonly workspace: string;
    readonly workspaceLabel: string;
    readonly parentId?: string;
    readonly kind: "interactive" | "subagent";
    readonly calls: number;
    readonly own: number;
    readonly children: number;
    readonly combined: number;
    readonly costKind: UsageCostKind;
    readonly updatedAt: string;
}

export interface UsageReport {
    readonly window: UsageWindow;
    readonly totals: UsageTotals;
    readonly prior?: UsageTotals;
    readonly timeline: readonly UsageTimelinePoint[];
    readonly models: readonly UsageModelRow[];
    readonly sessions: readonly UsageSessionRow[];
    readonly estimatedFromOpenRouter: boolean;
}

export const USAGE_WINDOW_IDS: readonly UsageWindowId[] = [
    "today",
    "7d",
    "30d",
    "all",
];

export function isUsageWindowId(value: string): value is UsageWindowId {
    return (USAGE_WINDOW_IDS as readonly string[]).includes(value);
}

export interface FoldUsageReportOptions {
    readonly sessionDirectory: string;
    readonly window: UsageWindowId;
    readonly now?: Date;
    readonly catalogCacheDir?: string;
}

interface IndexedSession {
    readonly id: string;
    readonly path: string;
    readonly header: SessionHeader;
    readonly title: string;
    readonly parentId?: string;
    readonly mtimeMs: number;
    readonly updatedAt: string;
}

interface PricedCall {
    readonly timestamp: string;
    readonly sessionId: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly totalTokens: number;
    readonly kind: "reported" | "estimated" | "unpriced";
    readonly cost: number;
}

/**
 * Streams matching session JSONL and returns one report for the window.
 * Default 7 days so most old files never open.
 */
export async function foldUsageReport(
    options: FoldUsageReportOptions,
): Promise<UsageReport> {
    const now = options.now ?? new Date();
    const bounds = windowBounds(options.window, now);
    const rates = openRouterRates(options.catalogCacheDir);
    const indexed = await indexSessionFiles(options.sessionDirectory);
    const calls: PricedCall[] = [];
    for (const session of indexed.values()) {
        if (
            options.window !== "all"
            && session.mtimeMs < bounds.start.getTime()
        ) {
            continue;
        }
        calls.push(
            ...await readSessionCalls(session, bounds.start, bounds.end, rates),
        );
    }
    const totals = totalsFrom(calls);
    const prior = options.window === "all"
        ? undefined
        : totalsFrom(
            await priorWindowCalls(indexed, options.window, now, rates),
        );
    return {
        window: {
            id: options.window,
            start: bounds.start.toISOString(),
            end: bounds.end.toISOString(),
        },
        totals,
        ...(prior === undefined ? {} : { prior }),
        timeline: timelineFrom(calls, bounds.start, bounds.end),
        models: modelRowsFrom(calls, totals.spend.combined),
        sessions: sessionRowsFrom(indexed, calls),
        estimatedFromOpenRouter: calls.some((call) => call.kind === "estimated"),
    };
}

function windowBounds(
    window: UsageWindowId,
    now: Date,
): { readonly start: Date; readonly end: Date } {
    const end = now;
    if (window === "all") {
        return { start: new Date(0), end };
    }
    const today = startOfLocalDay(now);
    if (window === "today") {
        return { start: today, end };
    }
    const days = window === "7d" ? 6 : 29;
    return {
        start: new Date(today.getTime() - days * 24 * 60 * 60 * 1000),
        end,
    };
}

function priorBounds(
    window: Exclude<UsageWindowId, "all">,
    now: Date,
): { readonly start: Date; readonly end: Date } {
    const current = windowBounds(window, now);
    const lengthMs = current.end.getTime() - current.start.getTime();
    return {
        start: new Date(current.start.getTime() - lengthMs),
        end: new Date(current.start.getTime() - 1),
    };
}

function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function openRouterRates(
    cacheDir?: string,
): ReadonlyMap<string, ModelPricing> {
    const catalog = effectiveCatalog("openrouter", cacheDir === undefined
        ? {}
        : { cacheDir });
    const rates = new Map<string, ModelPricing>();
    for (const model of catalog.models) {
        if (model.pricing !== undefined) {
            rates.set(model.id, model.pricing);
        }
    }
    return rates;
}

async function indexSessionFiles(
    directory: string,
): Promise<Map<string, IndexedSession>> {
    const sessions = new Map<string, IndexedSession>();
    let names: readonly string[];
    try {
        names = await readdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return sessions;
        }
        throw error;
    }
    for (const name of names.filter((value) => value.endsWith(".jsonl"))) {
        const path = join(directory, name);
        try {
            const metadata = await readSessionIndexMetadata(path);
            const fileStat = await stat(path);
            const parentId = metadata.header.delegation?.parentId
                ?? metadata.header.parentId;
            sessions.set(metadata.header.id, {
                id: metadata.header.id,
                path,
                header: metadata.header,
                title: (metadata.title ?? metadata.header.id).slice(0, 80),
                ...(parentId === undefined ? {} : { parentId }),
                mtimeMs: fileStat.mtimeMs,
                updatedAt: fileStat.mtime.toISOString(),
            });
        } catch {
            // A corrupt file contributes no row. The rest of the report still
            // returns.
        }
    }
    return sessions;
}

async function readSessionCalls(
    session: IndexedSession,
    start: Date,
    end: Date,
    rates: ReadonlyMap<string, ModelPricing>,
): Promise<PricedCall[]> {
    const calls: PricedCall[] = [];
    const startMs = start.getTime();
    const endMs = end.getTime();
    try {
        const lines = createInterface({
            input: createReadStream(session.path, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (!line.includes('"assistant"')) continue;
            let record: Record<string, unknown>;
            try {
                record = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (record.type !== "message") continue;
            const message = record.message as Record<string, unknown> | undefined;
            if (message?.role !== "assistant") continue;
            const source = message.source as Record<string, unknown> | undefined;
            const usage = message.usage as ModelUsage | undefined;
            if (
                typeof source?.provider !== "string"
                || typeof source.model !== "string"
                || usage === undefined
                || typeof record.timestamp !== "string"
            ) {
                continue;
            }
            const at = Date.parse(record.timestamp);
            if (Number.isNaN(at) || at < startMs || at > endMs) continue;
            calls.push(priceCall(
                session.id,
                record.timestamp,
                source.provider,
                source.model,
                usage,
                rates,
            ));
        }
    } catch {
        return [];
    }
    return calls;
}

function priceCall(
    sessionId: string,
    timestamp: string,
    provider: string,
    model: string,
    usage: ModelUsage,
    rates: ReadonlyMap<string, ModelPricing>,
): PricedCall {
    const inputTokens = numeric(usage.inputTokens);
    const outputTokens = numeric(usage.outputTokens);
    const cachedInputTokens = numeric(usage.cachedInputTokens);
    const totalTokens = numeric(usage.totalTokens);
    const base = {
        timestamp,
        sessionId,
        provider,
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens,
    };
    if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
        return { ...base, kind: "reported", cost: usage.cost };
    }
    if (provider === "openrouter") {
        const pricing = rates.get(model);
        if (pricing !== undefined) {
            return {
                ...base,
                kind: "estimated",
                cost: estimateUsd(usage, pricing),
            };
        }
    }
    return { ...base, kind: "unpriced", cost: 0 };
}

/**
 * Uncached input at the input rate, cached input at the cache rate (or input
 * when the listing has no cache rate), output at the output rate. Prompt
 * tokens already include the cached portion, so cached is not added twice.
 */
export function estimateUsd(
    usage: ModelUsage,
    pricing: ModelPricing,
): number {
    const cached = numeric(usage.cachedInputTokens);
    const uncached = Math.max(0, numeric(usage.inputTokens) - cached);
    const cacheRate = pricing.cache ?? pricing.input;
    return uncached / 1e6 * pricing.input
        + cached / 1e6 * cacheRate
        + numeric(usage.outputTokens) / 1e6 * pricing.output;
}

function numeric(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function priorWindowCalls(
    indexed: ReadonlyMap<string, IndexedSession>,
    window: Exclude<UsageWindowId, "all">,
    now: Date,
    rates: ReadonlyMap<string, ModelPricing>,
): Promise<PricedCall[]> {
    const bounds = priorBounds(window, now);
    const calls: PricedCall[] = [];
    for (const session of indexed.values()) {
        if (session.mtimeMs < bounds.start.getTime()) continue;
        calls.push(
            ...await readSessionCalls(session, bounds.start, bounds.end, rates),
        );
    }
    return calls;
}

function totalsFrom(calls: readonly PricedCall[]): UsageTotals {
    let reported = 0;
    let estimated = 0;
    let unpricedCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let totalTokens = 0;
    for (const call of calls) {
        if (call.kind === "reported") reported += call.cost;
        else if (call.kind === "estimated") estimated += call.cost;
        else unpricedCalls += 1;
        inputTokens += call.inputTokens;
        outputTokens += call.outputTokens;
        cachedInputTokens += call.cachedInputTokens;
        totalTokens += call.totalTokens;
    }
    const combined = reported + estimated;
    return {
        spend: { reported, estimated, combined, unpricedCalls },
        calls: calls.length,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens,
        cacheHitRatio: inputTokens === 0 ? 0 : cachedInputTokens / inputTokens,
        blendedPerMillion: totalTokens === 0
            ? undefined
            : combined / totalTokens * 1e6,
    };
}

function localDateKey(timestamp: string): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function localDayKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function timelineFrom(
    calls: readonly PricedCall[],
    start: Date,
    end: Date,
): UsageTimelinePoint[] {
    const keys: string[] = [];
    if (start.getTime() === 0) {
        const seen = new Set<string>();
        for (const call of calls) {
            seen.add(localDateKey(call.timestamp));
        }
        keys.push(...[...seen].sort());
    } else {
        for (
            let day = startOfLocalDay(start);
            day.getTime() <= startOfLocalDay(end).getTime();
            day.setDate(day.getDate() + 1)
        ) {
            keys.push(localDayKey(day));
        }
    }
    const buckets = new Map<string, Map<string, number>>();
    for (const key of keys) {
        buckets.set(key, new Map());
    }
    for (const call of calls) {
        if (call.kind === "unpriced") continue;
        const key = localDateKey(call.timestamp);
        let models = buckets.get(key);
        if (models === undefined) {
            models = new Map();
            buckets.set(key, models);
            keys.push(key);
        }
        const modelKey = `${call.provider}/${call.model}`;
        models.set(modelKey, (models.get(modelKey) ?? 0) + call.cost);
    }
    const ordered = start.getTime() === 0 ? [...new Set(keys)].sort() : keys;
    return ordered.map((date) => {
        const models = buckets.get(date) ?? new Map();
        const byModel = [...models.entries()]
            .map(([id, spend]) => {
                const slash = id.indexOf("/");
                return {
                    provider: id.slice(0, slash),
                    model: id.slice(slash + 1),
                    spend,
                };
            })
            .sort((left, right) => right.spend - left.spend);
        return {
            date,
            spend: byModel.reduce((sum, row) => sum + row.spend, 0),
            byModel,
        };
    });
}

function modelRowsFrom(
    calls: readonly PricedCall[],
    combinedSpend: number,
): UsageModelRow[] {
    const byModel = new Map<string, {
        provider: string;
        model: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        spend: number;
        reported: boolean;
        estimated: boolean;
        unpriced: boolean;
    }>();
    for (const call of calls) {
        const key = `${call.provider}/${call.model}`;
        const prior = byModel.get(key) ?? {
            provider: call.provider,
            model: call.model,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            spend: 0,
            reported: false,
            estimated: false,
            unpriced: false,
        };
        prior.calls += 1;
        prior.inputTokens += call.inputTokens;
        prior.outputTokens += call.outputTokens;
        prior.cachedInputTokens += call.cachedInputTokens;
        prior.spend += call.cost;
        if (call.kind === "reported") prior.reported = true;
        else if (call.kind === "estimated") prior.estimated = true;
        else prior.unpriced = true;
        byModel.set(key, prior);
    }
    return [...byModel.values()]
        .map((row) => ({
            provider: row.provider,
            model: row.model,
            calls: row.calls,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens,
            spend: row.spend,
            share: combinedSpend === 0 ? 0 : row.spend / combinedSpend,
            kind: costKind(row.reported, row.estimated, row.unpriced),
        }))
        .sort((left, right) => right.spend - left.spend);
}

function costKind(
    reported: boolean,
    estimated: boolean,
    unpriced: boolean,
): UsageCostKind {
    if (!reported && !estimated) return "unpriced";
    if (unpriced || (reported && estimated)) return "mixed";
    return reported ? "reported" : "estimated";
}

function sessionRowsFrom(
    indexed: ReadonlyMap<string, IndexedSession>,
    calls: readonly PricedCall[],
): UsageSessionRow[] {
    const own = new Map<string, {
        spend: number;
        calls: number;
        reported: boolean;
        estimated: boolean;
        unpriced: boolean;
        updatedAt: string;
    }>();
    for (const call of calls) {
        const prior = own.get(call.sessionId) ?? {
            spend: 0,
            calls: 0,
            reported: false,
            estimated: false,
            unpriced: false,
            updatedAt: call.timestamp,
        };
        prior.spend += call.cost;
        prior.calls += 1;
        if (call.kind === "reported") prior.reported = true;
        else if (call.kind === "estimated") prior.estimated = true;
        else prior.unpriced = true;
        if (call.timestamp > prior.updatedAt) prior.updatedAt = call.timestamp;
        own.set(call.sessionId, prior);
    }
    const childrenOf = new Map<string, string[]>();
    for (const session of indexed.values()) {
        if (session.parentId === undefined) continue;
        const list = childrenOf.get(session.parentId) ?? [];
        list.push(session.id);
        childrenOf.set(session.parentId, list);
    }
    const combinedCache = new Map<string, number>();
    const combinedOf = (id: string, visiting: Set<string>): number => {
        const cached = combinedCache.get(id);
        if (cached !== undefined) return cached;
        if (visiting.has(id)) return own.get(id)?.spend ?? 0;
        visiting.add(id);
        let total = own.get(id)?.spend ?? 0;
        for (const child of childrenOf.get(id) ?? []) {
            total += combinedOf(child, visiting);
        }
        visiting.delete(id);
        combinedCache.set(id, total);
        return total;
    };
    const ids = new Set<string>(own.keys());
    for (const id of [...ids]) {
        let parentId = indexed.get(id)?.parentId;
        while (parentId !== undefined) {
            ids.add(parentId);
            parentId = indexed.get(parentId)?.parentId;
        }
    }
    const rows: UsageSessionRow[] = [];
    for (const id of ids) {
        const session = indexed.get(id);
        if (session === undefined) continue;
        const stats = own.get(id);
        const combined = combinedOf(id, new Set());
        const ownSpend = stats?.spend ?? 0;
        if (combined === 0 && (stats?.calls ?? 0) === 0) continue;
        rows.push({
            id,
            title: session.title,
            workspace: session.header.cwd,
            workspaceLabel: basename(session.header.cwd),
            ...(session.parentId === undefined ? {} : { parentId: session.parentId }),
            kind: sessionIsSubagent(session.header) ? "subagent" : "interactive",
            calls: stats?.calls ?? 0,
            own: ownSpend,
            children: combined - ownSpend,
            combined,
            costKind: costKind(
                stats?.reported ?? false,
                stats?.estimated ?? false,
                stats?.unpriced ?? false,
            ),
            updatedAt: stats?.updatedAt ?? session.updatedAt,
        });
    }
    rows.sort((left, right) => {
        if (right.combined !== left.combined) {
            return right.combined - left.combined;
        }
        return right.updatedAt < left.updatedAt
            ? -1
            : right.updatedAt > left.updatedAt ? 1 : 0;
    });
    return rows;
}

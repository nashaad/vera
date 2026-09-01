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
    readonly tools: readonly UsageToolCount[];
}

export interface UsageToolCount {
    readonly name: string;
    readonly calls: number;
}

export type UsageCallKind =
    | "turn"
    | "compaction"
    | "reviewer"
    | "oneshot"
    | "probe";

export interface UsageCallRow {
    readonly timestamp: string;
    readonly sessionId: string;
    readonly provider: string;
    readonly model: string;
    readonly kind: UsageCallKind;
    readonly cost: number;
    readonly costKind: "reported" | "estimated" | "unpriced";
    readonly tools: readonly string[];
}

export interface UsageSessionDetail {
    readonly session: UsageSessionRow;
    readonly totals: UsageTotals;
    readonly models: readonly UsageModelRow[];
    readonly children: readonly UsageSessionRow[];
    readonly calls: readonly UsageCallRow[];
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
    readonly models: readonly string[];
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
    readonly reviewLogPath?: string;
}

interface IndexedSession {
    readonly id: string;
    readonly path: string;
    readonly header: SessionHeader;
    readonly title: string;
    readonly parentId?: string;
    readonly mtimeMs: number;
    readonly size: number;
    readonly updatedAt: string;
}

interface FileCallMemo {
    readonly size: number;
    readonly mtimeMs: number;
    readonly calls: readonly PricedCall[];
}

const FILE_CALL_MEMO = new Map<string, FileCallMemo>();
const FOLD_CONCURRENCY = 32;

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
    readonly callKind: UsageCallKind;
    readonly cost: number;
    readonly tools: readonly string[];
}

export async function foldUsageReport(
    options: FoldUsageReportOptions,
): Promise<UsageReport> {
    const now = options.now ?? new Date();
    const bounds = windowBounds(options.window, now);
    const priorRange = options.window === "all"
        ? undefined
        : priorBounds(options.window, now);
    const scanStartMs = priorRange?.start.getTime() ?? bounds.start.getTime();
    const rates = openRouterRates(options.catalogCacheDir);
    const indexed = await indexSessionFiles(
        options.sessionDirectory,
        options.window === "all" ? undefined : scanStartMs,
    );
    const inScan = [...indexed.values()].filter((session) =>
        options.window === "all" || session.mtimeMs >= scanStartMs
    );
    const fileCalls = await mapPool(
        inScan,
        FOLD_CONCURRENCY,
        (session) => readSessionCallsMemoized(session, rates),
    );
    const calls: PricedCall[] = [];
    const priorCalls: PricedCall[] = [];
    const startMs = bounds.start.getTime();
    const endMs = bounds.end.getTime();
    const priorStartMs = priorRange?.start.getTime();
    const priorEndMs = priorRange?.end.getTime();
    for (const collected of fileCalls) {
        for (const call of collected) {
            const at = Date.parse(call.timestamp);
            if (Number.isNaN(at)) continue;
            if (at >= startMs && at <= endMs) calls.push(call);
            else if (
                priorStartMs !== undefined
                && priorEndMs !== undefined
                && at >= priorStartMs
                && at <= priorEndMs
            ) {
                priorCalls.push(call);
            }
        }
    }
    if (options.reviewLogPath !== undefined) {
        const reviewed = await readReviewLogCalls(
            options.reviewLogPath,
            bounds,
            priorRange,
            rates,
        );
        calls.push(...reviewed.current);
        priorCalls.push(...reviewed.prior);
    }
    await indexMissingParents(indexed, options.sessionDirectory, calls.map((call) => call.sessionId));
    const totals = totalsFrom(calls);
    const prior = priorRange === undefined
        ? undefined
        : totalsFrom(priorCalls);
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

export async function foldUsageSessionDetail(
    options: FoldUsageReportOptions & { readonly sessionId: string },
): Promise<UsageSessionDetail | undefined> {
    const report = await foldUsageReport(options);
    const session = report.sessions.find((row) => row.id === options.sessionId);
    if (session === undefined) return undefined;
    const now = options.now ?? new Date();
    const bounds = windowBounds(options.window, now);
    const rates = openRouterRates(options.catalogCacheDir);
    const priorRange = options.window === "all"
        ? undefined
        : priorBounds(options.window, now);
    const scanStartMs = priorRange?.start.getTime() ?? bounds.start.getTime();
    const indexed = await indexSessionFiles(
        options.sessionDirectory,
        options.window === "all" ? undefined : scanStartMs,
    );
    await indexMissingParents(
        indexed,
        options.sessionDirectory,
        report.sessions.map((row) => row.id),
    );
    const root = indexed.get(options.sessionId);
    if (root === undefined) return undefined;
    const startMs = bounds.start.getTime();
    const endMs = bounds.end.getTime();
    const inWindow = (collected: readonly PricedCall[]) => collected.filter((call) => {
        const at = Date.parse(call.timestamp);
        return !Number.isNaN(at) && at >= startMs && at <= endMs;
    });
    const ownCalls = inWindow(await readSessionCallsMemoized(root, rates));
    const workCalls = [...ownCalls];
    for (const id of descendantSessionIds(indexed, options.sessionId)) {
        const child = indexed.get(id);
        if (child === undefined) continue;
        workCalls.push(...inWindow(await readSessionCallsMemoized(child, rates)));
    }
    const workTotals = totalsFrom(workCalls);
    return {
        session,
        totals: workTotals,
        models: modelRowsFrom(workCalls, workTotals.spend.combined),
        children: report.sessions.filter((row) => row.parentId === options.sessionId),
        calls: ownCalls
            .map(callRowFrom)
            .sort((left, right) => left.timestamp < right.timestamp ? -1 : 1),
    };
}

function descendantSessionIds(
    indexed: ReadonlyMap<string, IndexedSession>,
    rootId: string,
): string[] {
    const childrenOf = new Map<string, string[]>();
    for (const session of indexed.values()) {
        if (session.parentId === undefined) continue;
        const list = childrenOf.get(session.parentId) ?? [];
        list.push(session.id);
        childrenOf.set(session.parentId, list);
    }
    const found: string[] = [];
    const walk = (id: string) => {
        for (const child of childrenOf.get(id) ?? []) {
            found.push(child);
            walk(child);
        }
    };
    walk(rootId);
    return found;
}

function callRowFrom(call: PricedCall): UsageCallRow {
    return {
        timestamp: call.timestamp,
        sessionId: call.sessionId,
        provider: call.provider,
        model: call.model,
        kind: call.callKind,
        cost: call.cost,
        costKind: call.kind,
        tools: call.tools,
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
    sinceMs?: number,
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
    const paths = names
        .filter((value) => value.endsWith(".jsonl"))
        .map((name) => join(directory, name));
    const indexed = await mapPool(paths, FOLD_CONCURRENCY, async (path) => {
        try {
            const fileStat = await stat(path);
            if (sinceMs !== undefined && fileStat.mtimeMs < sinceMs) {
                return undefined;
            }
            return await indexSessionPath(path, fileStat);
        } catch {
            return undefined;
        }
    });
    for (const session of indexed) {
        if (session !== undefined) sessions.set(session.id, session);
    }
    return sessions;
}

async function indexSessionPath(
    path: string,
    fileStat: { readonly mtimeMs: number; readonly mtime: Date; readonly size: number },
): Promise<IndexedSession> {
    const metadata = await readSessionIndexMetadata(path);
    const parentId = metadata.header.delegation?.parentId
        ?? metadata.header.parentId;
    return {
        id: metadata.header.id,
        path,
        header: metadata.header,
        title: (metadata.title ?? metadata.header.id).slice(0, 80),
        ...(parentId === undefined ? {} : { parentId }),
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
    };
}

async function indexMissingParents(
    indexed: Map<string, IndexedSession>,
    directory: string,
    sessionIds: Iterable<string>,
): Promise<void> {
    const needed = new Set<string>(sessionIds);
    const pending = [...needed];
    while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined) continue;
        let session = indexed.get(id);
        if (session === undefined) {
            const path = join(directory, `${id}.jsonl`);
            try {
                const fileStat = await stat(path);
                session = await indexSessionPath(path, fileStat);
                indexed.set(session.id, session);
            } catch {
                continue;
            }
        }
        if (
            session.parentId !== undefined
            && !needed.has(session.parentId)
        ) {
            needed.add(session.parentId);
            pending.push(session.parentId);
        }
    }
}

async function mapPool<T, R>(
    items: readonly T[],
    limit: number,
    visit: (item: T) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) return [];
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (true) {
            const index = next;
            next += 1;
            if (index >= items.length) return;
            out[index] = await visit(items[index]!);
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.min(limit, items.length) },
            () => worker(),
        ),
    );
    return out;
}

async function readSessionCallsMemoized(
    session: IndexedSession,
    rates: ReadonlyMap<string, ModelPricing>,
): Promise<readonly PricedCall[]> {
    const hit = FILE_CALL_MEMO.get(session.path);
    if (
        hit !== undefined
        && hit.size === session.size
        && hit.mtimeMs === session.mtimeMs
    ) {
        return hit.calls;
    }
    const calls = await readSessionCalls(session, rates);
    FILE_CALL_MEMO.set(session.path, {
        size: session.size,
        mtimeMs: session.mtimeMs,
        calls,
    });
    return calls;
}

async function readSessionCalls(
    session: IndexedSession,
    rates: ReadonlyMap<string, ModelPricing>,
): Promise<PricedCall[]> {
    const calls: PricedCall[] = [];
    try {
        const lines = createInterface({
            input: createReadStream(session.path, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (
                !line.includes('"assistant"')
                && !line.includes('"compaction"')
            ) continue;
            let record: Record<string, unknown>;
            try {
                record = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (record.type === "compaction") {
                const billed = billedFromCompaction(record);
                if (billed === undefined) continue;
                calls.push(priceCall(
                    session.id,
                    typeof record.timestamp === "string"
                        ? record.timestamp
                        : session.updatedAt,
                    billed.provider,
                    billed.model,
                    billed.usage,
                    rates,
                    "compaction",
                    [],
                ));
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
            calls.push(priceCall(
                session.id,
                record.timestamp,
                source.provider,
                source.model,
                usage,
                rates,
                "turn",
                toolNames(message.content),
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
    callKind: UsageCallKind = "turn",
    tools: readonly string[] = [],
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
        callKind,
        tools,
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
        tools: Map<string, number>;
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
            tools: new Map<string, number>(),
        };
        prior.calls += 1;
        prior.inputTokens += call.inputTokens;
        prior.outputTokens += call.outputTokens;
        prior.cachedInputTokens += call.cachedInputTokens;
        prior.spend += call.cost;
        if (call.kind === "reported") prior.reported = true;
        else if (call.kind === "estimated") prior.estimated = true;
        else prior.unpriced = true;
        for (const name of call.tools) {
            prior.tools.set(name, (prior.tools.get(name) ?? 0) + 1);
        }
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
            tools: toolCounts(row.tools),
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
        models: Set<string>;
    }>();
    for (const call of calls) {
        const prior = own.get(call.sessionId) ?? {
            spend: 0,
            calls: 0,
            reported: false,
            estimated: false,
            unpriced: false,
            updatedAt: call.timestamp,
            models: new Set<string>(),
        };
        prior.spend += call.cost;
        prior.calls += 1;
        if (call.kind === "reported") prior.reported = true;
        else if (call.kind === "estimated") prior.estimated = true;
        else prior.unpriced = true;
        if (call.timestamp > prior.updatedAt) prior.updatedAt = call.timestamp;
        prior.models.add(`${call.provider}/${call.model}`);
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
    const flagsCache = new Map<string, {
        reported: boolean;
        estimated: boolean;
        unpriced: boolean;
    }>();
    const flagsOf = (id: string, visiting: Set<string>) => {
        const cached = flagsCache.get(id);
        if (cached !== undefined) return cached;
        const stats = own.get(id);
        const flags = {
            reported: stats?.reported ?? false,
            estimated: stats?.estimated ?? false,
            unpriced: stats?.unpriced ?? false,
        };
        if (visiting.has(id)) return flags;
        visiting.add(id);
        for (const child of childrenOf.get(id) ?? []) {
            const childFlags = flagsOf(child, visiting);
            flags.reported = flags.reported || childFlags.reported;
            flags.estimated = flags.estimated || childFlags.estimated;
            flags.unpriced = flags.unpriced || childFlags.unpriced;
        }
        visiting.delete(id);
        flagsCache.set(id, flags);
        return flags;
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
        const flags = flagsOf(id, new Set());
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
            costKind: costKind(flags.reported, flags.estimated, flags.unpriced),
            updatedAt: stats?.updatedAt ?? session.updatedAt,
            models: [...(stats?.models ?? [])],
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

function toolNames(content: unknown): readonly string[] {
    if (!Array.isArray(content)) return [];
    const names: string[] = [];
    for (const block of content) {
        if (
            block !== null
            && typeof block === "object"
            && (block as { type?: unknown }).type === "tool_call"
            && typeof (block as { name?: unknown }).name === "string"
        ) {
            names.push((block as { name: string }).name);
        }
    }
    return names;
}

function toolCounts(counts: ReadonlyMap<string, number>): UsageToolCount[] {
    return [...counts.entries()]
        .map(([name, calls]) => ({ name, calls }))
        .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

function billedFromCompaction(
    record: Record<string, unknown>,
): { provider: string; model: string; usage: ModelUsage } | undefined {
    const billed = record.billed as Record<string, unknown> | undefined;
    if (billed === undefined || typeof billed !== "object" || billed === null) {
        return undefined;
    }
    if (typeof billed.provider !== "string" || typeof billed.model !== "string") {
        return undefined;
    }
    const usage = billed.usage as ModelUsage | undefined;
    if (usage === undefined) return undefined;
    return { provider: billed.provider, model: billed.model, usage };
}

async function readReviewLogCalls(
    path: string,
    current: { readonly start: Date; readonly end: Date },
    prior: { readonly start: Date; readonly end: Date } | undefined,
    rates: ReadonlyMap<string, ModelPricing>,
): Promise<{ current: PricedCall[]; prior: PricedCall[] }> {
    const currentCalls: PricedCall[] = [];
    const priorCalls: PricedCall[] = [];
    const startMs = current.start.getTime();
    const endMs = current.end.getTime();
    const priorStartMs = prior?.start.getTime();
    const priorEndMs = prior?.end.getTime();
    try {
        const lines = createInterface({
            input: createReadStream(path, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (!line.includes('"tool_review"')) continue;
            let record: Record<string, unknown>;
            try {
                record = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (record.type !== "tool_review") continue;
            const usage = record.usage as ModelUsage | undefined;
            if (
                usage === undefined
                || typeof record.model !== "string"
                || typeof record.timestamp !== "string"
            ) {
                continue;
            }
            const at = Date.parse(record.timestamp);
            if (Number.isNaN(at)) continue;
            const inCurrent = at >= startMs && at <= endMs;
            const inPrior = priorStartMs !== undefined
                && priorEndMs !== undefined
                && at >= priorStartMs
                && at <= priorEndMs;
            if (!inCurrent && !inPrior) continue;
            const provider = typeof record.provider === "string"
                ? record.provider
                : "unknown";
            const sessionId = typeof record.sessionId === "string"
                ? record.sessionId
                : "";
            const call = priceCall(
                sessionId,
                record.timestamp,
                provider,
                record.model,
                usage,
                rates,
                "reviewer",
                [],
            );
            if (inCurrent) currentCalls.push(call);
            else priorCalls.push(call);
        }
    } catch {
        return { current: [], prior: [] };
    }
    return { current: currentCalls, prior: priorCalls };
}

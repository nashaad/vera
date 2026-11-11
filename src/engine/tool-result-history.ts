import { readFileSync } from "node:fs";

import type {
    ModelMessage,
    ToolCallContent,
    ToolResultMessage,
} from "../model/types.ts";
import { TOOL_RESULT_VERBATIM_FLOOR_BYTES } from "../model/types.ts";
import { TOOL_RESULT_CEILING_BYTES } from "../tools/tool-result-limit.ts";
import { measureMessages } from "./context-measurement.ts";
import {
    createContextSizeTriggerSet,
    type ContextSizeTriggerReport,
    type ContextSizeTriggerSet,
} from "./context-size-triggers.ts";
import {
    defaultContextSizePolicies,
} from "./context-size-trigger-defaults.ts";

export {
    DEFAULT_TRIM_STEP_FRACTION as TOKEN_TRIM_STEP_FRACTION,
} from "./context-size-trigger-defaults.ts";

export const TOOL_RESULT_STUB_AFTER_TURNS = 3;

/** Several legal per-result outputs must not compose one enormous request. Used when the window is unknown. */
export const TOOL_RESULT_TOTAL_BUDGET_BYTES = 128 * 1024;

export const TOOL_RESULT_TOTAL_BUDGET_FLOOR_BYTES = 32 * 1024;
export const TOOL_RESULT_TOTAL_BUDGET_MAX_BYTES = 1024 * 1024;

/**
 * A quarter of the window, measured at four bytes a token: one byte per window
 * token. A 128K-token window gets exactly the flat budget.
 */
export function toolResultTotalBudgetBytes(capacity: number | undefined): number {
    if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) {
        return TOOL_RESULT_TOTAL_BUDGET_BYTES;
    }
    return Math.min(
        TOOL_RESULT_TOTAL_BUDGET_MAX_BYTES,
        Math.max(TOOL_RESULT_TOTAL_BUDGET_FLOOR_BYTES, Math.floor(capacity)),
    );
}

export type ToolResultAgingLevel = "relaxed" | "normal" | "tight";

export interface ToolResultAgingLevelSettings {
    readonly gateFraction: number;
    readonly ageAfterTurns: number;
    readonly ageReads: boolean;
}

export const TOOL_RESULT_AGING_LEVELS: Readonly<
    Record<ToolResultAgingLevel, ToolResultAgingLevelSettings>
> = {
    relaxed: { gateFraction: 0.8, ageAfterTurns: 5, ageReads: false },
    normal: { gateFraction: 0.6, ageAfterTurns: 3, ageReads: true },
    tight: { gateFraction: 0.4, ageAfterTurns: 3, ageReads: true },
};

export const RELAXED_AGING_MIN_CAPACITY = 400_000;
export const NORMAL_AGING_MIN_CAPACITY = 128_000;

// Trimming moves in whole steps so that a small change in context size does
// not re-age results on every request and break the prompt prefix.
export const BYTE_TRIM_STEP_FRACTION = 0.25;

// Savings needed to bring `excess` under the limit, rounded up to whole steps.
function stepRequirement(excess: number, step: number): number {
    if (excess < 0) return 0;
    return (Math.floor(excess / step) + 1) * step;
}

export function toolResultAgingLevel(
    capacity: number | undefined,
): ToolResultAgingLevel {
    if (capacity === undefined) return "normal";
    if (capacity >= RELAXED_AGING_MIN_CAPACITY) return "relaxed";
    if (capacity >= NORMAL_AGING_MIN_CAPACITY) return "normal";
    return "tight";
}

export function toolResultAgingGateFraction(
    capacity: number | undefined,
    pinned?: ToolResultAgingLevel,
): number {
    return TOOL_RESULT_AGING_LEVELS[pinned ?? toolResultAgingLevel(capacity)]
        .gateFraction;
}

/**
 * What a config says about tool result size, in engine terms. Kept together
 * because the two ends are one decision: a per-result ceiling that lets one
 * result through is pointless if the combined budget rejects it anyway.
 */
export interface ToolResultLimits {
    readonly ceilingBytes?: number;
    readonly totalBudgetBytes?: number;
    readonly stubAfterTurns?: number;
    /** Undefined leaves the row to be chosen by the window. */
    readonly agingLevel?: ToolResultAgingLevel;
}

export interface ToolResultAgingPolicy {
    readonly capacity?: number;
    readonly overheadTokens?: number;
    readonly level?: ToolResultAgingLevel;
    readonly spillDirectory?: string;
    readonly ageAfterTurns?: number;
    readonly pendingUserTurns?: number;
    readonly budgetBytes?: number;
    /** Absent builds the built-in policy list for this window. */
    readonly triggers?: ContextSizeTriggerSet;
    /** Called once per action that changed the messages this request carries. */
    readonly reportTrigger?: (report: ContextSizeTriggerReport) => void;
}

export interface ToolResultHistoryEntry {
    readonly message: ModelMessage;
}

interface DigestCacheKey {
    readonly path: string;
    readonly tool: string;
    readonly originalBytes: number;
    readonly isError: boolean;
    readonly callDetail: string;
    readonly laterText: string;
    readonly source: string;
}

interface CachedDigest {
    readonly key: DigestCacheKey;
    readonly output: string;
    readonly bytes: number;
}

export class ToolResultDigestCache {
    private readonly entries = new Map<string, CachedDigest>();
    private bytes = 0;

    constructor(private readonly maxBytes = 16 * 1024 * 1024) {}

    get(key: DigestCacheKey): string | undefined {
        const entry = this.entries.get(key.path);
        if (entry === undefined
            || entry.key.tool !== key.tool
            || entry.key.originalBytes !== key.originalBytes
            || entry.key.isError !== key.isError
            || entry.key.callDetail !== key.callDetail
            || entry.key.laterText !== key.laterText
            || entry.key.source !== key.source) {
            return undefined;
        }
        this.entries.delete(key.path);
        this.entries.set(key.path, entry);
        return entry.output;
    }

    set(key: DigestCacheKey, output: string): void {
        const existing = this.entries.get(key.path);
        if (existing !== undefined) {
            this.entries.delete(key.path);
            this.bytes -= existing.bytes;
        }
        const bytes = 512 + 2 * (
            key.path.length + key.tool.length + key.callDetail.length
            + key.laterText.length + key.source.length + output.length
        );
        if (bytes > this.maxBytes) return;
        while (this.bytes + bytes > this.maxBytes) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.bytes -= this.entries.get(oldest)!.bytes;
            this.entries.delete(oldest);
        }
        this.entries.set(key.path, { key, output, bytes });
        this.bytes += bytes;
    }
}

const digestCache = new ToolResultDigestCache();

export function assembleAgedToolResults(
    entries: readonly ToolResultHistoryEntry[],
    policy: ToolResultAgingPolicy = {},
    cache: ToolResultDigestCache | null = digestCache,
): readonly ModelMessage[] {
    const level = TOOL_RESULT_AGING_LEVELS[
        policy.level ?? toolResultAgingLevel(policy.capacity)
    ];
    const ageAfterTurns = policy.ageAfterTurns ?? level.ageAfterTurns;
    const budgetBytes = policy.budgetBytes ?? TOOL_RESULT_TOTAL_BUDGET_BYTES;

    const turnsAt = new Map<number, number>();
    const calls = new Map<string, ToolCallContent>();
    let turn = -1;

    for (let index = 0; index < entries.length; index += 1) {
        const message = entries[index]?.message;
        if (message === undefined) continue;
        if (message.role === "user" && message.internal !== true) {
            turn += 1;
        }
        turnsAt.set(index, turn);
        if (message.role === "assistant") {
            for (const content of message.content) {
                if (content.type === "tool_call") {
                    calls.set(content.id, content);
                }
            }
        }
    }
    turn += Math.max(0, policy.pendingUserTurns ?? 0);
    const provenanceText = (index: number): string => assistantTextUntil(
        entries,
        index,
        turnsAt,
        Math.min((turnsAt.get(index) ?? -1) + ageAfterTurns, turn),
    );

    const projected: ModelMessage[] = entries.map((entry) => entry.message);
    let historyEnd = projected.length;
    if ((policy.pendingUserTurns ?? 0) === 0) {
        for (let index = projected.length - 1; index >= 0; index -= 1) {
            const message = projected[index];
            if (message?.role === "user" && message.internal !== true) {
                historyEnd = index + 1;
                break;
            }
        }
    }
    const pressureTokens = measureMessages(projected.slice(0, historyEnd))
        + (policy.overheadTokens ?? 0);

    const candidates: number[] = [];
    const readCandidates: number[] = [];
    for (let index = 0; index < projected.length; index += 1) {
        const message = projected[index];
        if (
            message?.role !== "tool_result"
            || message.toolResultSource?.spillPath === undefined
            || message.toolResultSource.originalBytes
                <= TOOL_RESULT_VERBATIM_FLOOR_BYTES
        ) {
            continue;
        }
        const age = turn - (turnsAt.get(index) ?? -1);
        if (age === 0 || age < ageAfterTurns) continue;
        const call = calls.get(message.toolCallId);
        if (readsSpill(call, policy.spillDirectory)) continue;
        if (message.toolName === "read") {
            if (level.ageReads) readCandidates.push(index);
            continue;
        }
        candidates.push(index);
    }

    const triggers = policy.triggers ?? createContextSizeTriggerSet(
        defaultContextSizePolicies({
            capacity: policy.capacity,
            trimGateFraction: level.gateFraction,
        }),
    );
    triggers.reset();
    const trim = triggers.fire("trim", {
        tokens: pressureTokens,
        ...(policy.capacity === undefined
            ? {}
            : { capacity: policy.capacity }),
    });
    let budgeted: readonly ModelMessage[] = projected;
    if (trim?.policy?.kind === "every_n") {
        const requiredSavings = stepRequirement(
            pressureTokens - trim.policy.from,
            trim.policy.step,
        );
        let savedTokens = 0;
        for (const index of [...candidates, ...readCandidates]) {
            if (savedTokens >= requiredSavings) break;
            const message = projected[index];
            if (message?.role !== "tool_result") continue;
            const sourceText = readSpill(message.toolResultSource?.spillPath);
            if (sourceText === undefined) continue;
            const aged = agedToolResult(
                message,
                calls.get(message.toolCallId),
                provenanceText(index),
                sourceText,
                cache,
            );
            const saved = measureMessages([message]) - measureMessages([aged]);
            if (saved <= 0) continue;
            savedTokens += saved;
            projected[index] = aged;
        }

        budgeted = applyToolResultBudget(
            projected,
            calls,
            budgetBytes,
            provenanceText,
            { turn, turnsAt, ageAfterTurns, historyEnd },
            cache,
        );
    }
    const trimTrigger = policy.reportTrigger;
    if (trim !== undefined && trimTrigger !== undefined) {
        const changed: string[] = [];
        for (let index = 0; index < budgeted.length; index += 1) {
            const message = budgeted[index];
            if (message === entries[index]?.message) continue;
            if (message?.role !== "tool_result") continue;
            changed.push(`${index}:${message.toolCallId}:${toolResultBytes(message)}`);
        }
        if (changed.length > 0) {
            let measured: number | undefined;
            trimTrigger({
                trigger: trim,
                action: "trim",
                // Read only when the caller keeps the report.
                get tokensAfter(): number {
                    measured ??= measureMessages(budgeted.slice(0, historyEnd))
                        + (policy.overheadTokens ?? 0);
                    return measured;
                },
                fingerprint: changed.join(","),
            });
        }
    }
    return Object.freeze(
        trimActiveSteps(entries, budgeted, calls, policy, triggers),
    );
}

function trimActiveSteps(
    entries: readonly ToolResultHistoryEntry[],
    projected: readonly ModelMessage[],
    calls: ReadonlyMap<string, ToolCallContent>,
    policy: ToolResultAgingPolicy,
    triggers: ContextSizeTriggerSet,
): readonly ModelMessage[] {
    if ((policy.pendingUserTurns ?? 0) > 0) return projected;
    let activeStart = -1;
    for (let index = 0; index < entries.length; index += 1) {
        const message = entries[index]?.message;
        if (message?.role === "user" && message.internal !== true) activeStart = index;
    }
    if (activeStart < 0) return projected;
    const messages = [...projected];
    let tokens = (policy.overheadTokens ?? 0) + measureMessages(messages.slice(0, activeStart + 1));
    let stepStart = -1;
    let trimmedThrough = -1;
    const fired: ContextSizeTriggerReport["trigger"][] = [];
    const stubbed: string[] = [];
    const measurement = (tokens: number) => ({
        tokens,
        ...(policy.capacity === undefined ? {} : { capacity: policy.capacity }),
    });
    const trimBefore = () => {
        if (stepStart < 0) return;
        const trigger = triggers.fire("stub_active_turn", measurement(tokens));
        if (trigger === undefined) return;
        fired.push(trigger);
        const before = tokens;
        for (let index = trimmedThrough + 1; index < stepStart; index += 1) {
            const message = messages[index];
            if (message?.role !== "tool_result") continue;
            if (message !== entries[index]?.message) continue;
            if (readsSpill(calls.get(message.toolCallId), policy.spillDirectory)) continue;
            const stub = stubbedToolResult(message);
            if (toolResultBytes(stub) >= toolResultBytes(message)) continue;
            tokens -= measureMessages([message]) - measureMessages([stub]);
            messages[index] = stub;
            stubbed.push(`${index}:${message.toolCallId}`);
        }
        trimmedThrough = stepStart - 1;
        triggers.observe("stub_active_turn", measurement(tokens), tokens < before);
    };
    for (let index = activeStart + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message === undefined) continue;
        if (message.role === "assistant" && message.content.some((part) => part.type === "tool_call")) {
            trimBefore();
            stepStart = index;
        }
        tokens += measureMessages([message]);
    }
    trimBefore();
    const reportTrigger = policy.reportTrigger;
    if (reportTrigger !== undefined && fired.length > 0 && stubbed.length > 0) {
        reportTrigger({
            trigger: fired[0]!,
            action: "stub_active_turn",
            tokensAfter: tokens,
            fingerprint: stubbed.join(","),
        });
    }
    return messages;
}

function readsSpill(
    call: ToolCallContent | undefined,
    spillDirectory: string | undefined,
): boolean {
    if (call === undefined || spillDirectory === undefined) return false;
    if (call.name === "read") {
        return typeof call.input.path === "string"
            && call.input.path.startsWith(spillDirectory);
    }
    if (call.name === "bash") {
        return typeof call.input.command === "string"
            && call.input.command.includes(spillDirectory);
    }
    return false;
}

interface ToolResultBudgetCut {
    readonly turn: number;
    readonly turnsAt: ReadonlyMap<number, number>;
    readonly ageAfterTurns: number;
    readonly historyEnd: number;
}

function applyToolResultBudget(
    projected: readonly ModelMessage[],
    calls: ReadonlyMap<string, ToolCallContent>,
    budgetBytes: number,
    provenanceText: (index: number) => string,
    cut: ToolResultBudgetCut,
    cache: ToolResultDigestCache | null,
): readonly ModelMessage[] {
    const messages = [...projected];
    const startBytes = totalToolResultBytes(messages.slice(0, cut.historyEnd));
    let carriedBytes = startBytes;
    if (carriedBytes <= budgetBytes) return messages;

    const requiredBytes = stepRequirement(
        startBytes - budgetBytes,
        Math.max(1, Math.floor(budgetBytes * BYTE_TRIM_STEP_FRACTION)),
    );
    for (let index = 0; index < messages.length; index += 1) {
        if (startBytes - carriedBytes >= requiredBytes) break;
        const message = messages[index];
        if (message?.role !== "tool_result") continue;
        const age = cut.turn - (cut.turnsAt.get(index) ?? -1);
        if (age === 0 || age < cut.ageAfterTurns) {
            continue;
        }
        const digestible = message.toolResultSource?.spillPath !== undefined
            && message.toolResultSource.originalBytes
                > TOOL_RESULT_VERBATIM_FLOOR_BYTES;
        const source = digestible
            ? readSpill(message.toolResultSource?.spillPath)
            : undefined;
        carriedBytes = replaceWhenSmaller(
            messages,
            index,
            message,
            source === undefined
                ? stubbedToolResult(message)
                : agedToolResult(
                    message,
                    calls.get(message.toolCallId),
                    provenanceText(index),
                    source,
                    cache,
                ),
            carriedBytes,
        );
    }
    return messages;
}

function replaceWhenSmaller(
    messages: ModelMessage[],
    index: number,
    current: ToolResultMessage,
    replacement: ToolResultMessage,
    carriedBytes: number,
): number {
    const currentBytes = toolResultBytes(current);
    const replacementBytes = toolResultBytes(replacement);
    if (replacementBytes >= currentBytes) return carriedBytes;
    messages[index] = replacement;
    return carriedBytes - currentBytes + replacementBytes;
}

function totalToolResultBytes(messages: readonly ModelMessage[]): number {
    return messages.reduce(
        (total, message) => total + (message.role === "tool_result"
            ? toolResultBytes(message)
            : 0),
        0,
    );
}

function toolResultBytes(message: ToolResultMessage): number {
    return message.content.reduce(
        (total, content) => total + Buffer.byteLength(content.text, "utf8"),
        0,
    );
}

function agedToolResult(
    result: ToolResultMessage,
    call: ToolCallContent | undefined,
    laterText: string,
    sourceText: string,
    cache: ToolResultDigestCache | null,
): ToolResultMessage {
    const sourcePath = result.toolResultSource?.spillPath;
    if (!isDigestableTool(result.toolName)) {
        return stubbedToolResult(result);
    }
    const key = sourcePath === undefined ? undefined : {
        path: sourcePath,
        tool: result.toolName,
        originalBytes: result.toolResultSource?.originalBytes ?? 0,
        isError: result.isError,
        callDetail: digestCallDetail(result.toolName, call),
        laterText,
        source: sourceText,
    };
    const cached = key === undefined ? undefined : cache?.get(key);
    if (cached !== undefined) {
        return { ...result, content: [{ type: "text", text: cached }] };
    }
    const references = extractReferences(laterText);
    const body = digestFor(result, call, sourceText);
    const retained = provenanceLines(sourceText, references);
    const provenance = retained.length === 0
        ? []
        : [
            "[vera] Provenance retained from later assistant messages:",
            ...retained.map((line) => `  ${line}`),
        ];
    const output = boundDigest([
        body,
        ...provenance,
        "[vera] Full output remains available at "
            + `${sourcePath}; re-read it if needed.`,
    ].join("\n"), result.toolResultSource?.originalBytes ?? 0);
    if (key !== undefined) cache?.set(key, output);
    return {
        ...result,
        content: [{ type: "text", text: output }],
    };
}

function digestCallDetail(tool: string, call: ToolCallContent | undefined): string {
    if (tool === "grep") return call?.input.output_mode === "count" ? "count" : "";
    if (tool === "bash") {
        return typeof call?.input.command === "string"
            ? call.input.command : "(command unavailable)";
    }
    if (tool === "read") {
        return typeof call?.input.path === "string"
            ? call.input.path : "(path unavailable)";
    }
    return "";
}

function stubbedToolResult(result: ToolResultMessage): ToolResultMessage {
    return {
        ...result,
        content: [{ type: "text", text: stubFor(result) }],
    };
}

function isDigestableTool(tool: string): boolean {
    return tool === "grep"
        || tool === "bash"
        || tool === "read"
        || tool === "list";
}

function stubFor(result: ToolResultMessage): string {
    const sourcePath = result.toolResultSource?.spillPath;
    return [
        `[vera] Stub for older ${result.toolName} result: `
            + `${formatBytes(result.toolResultSource?.originalBytes ?? 0)}.`,
        sourcePath === undefined || readSpill(sourcePath) === undefined
            ? "[vera] The durable session retains the original result, but no "
                + "re-readable spill is available for this request."
            : "[vera] Full output remains available at "
                + `${sourcePath}; re-read it if needed.`,
    ].join("\n");
}

function digestFor(
    result: ToolResultMessage,
    call: ToolCallContent | undefined,
    source: string,
): string {
    const header = `[vera] Digest of older ${result.toolName} result: `
        + `${formatBytes(result.toolResultSource?.originalBytes ?? 0)}.`;
    switch (result.toolName) {
        case "grep":
            return `${header}\n${grepDigest(source, call)}`;
        case "bash":
            return `${header}\n${bashDigest(source, call, result.isError)}`;
        case "read":
            return `${header}\n${readDigest(source, call)}`;
        case "list":
            return `${header}\n${listDigest(source)}`;
        default:
            return `${header}\n[vera] This tool has no mechanical digest; `
                + "the result is represented by this pointer.";
    }
}

function grepDigest(source: string, call: ToolCallContent | undefined): string {
    const countMode = call?.input.output_mode === "count";
    const files = new Map<string, { count: number; lines: string[] }>();
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (
            line.length === 0
            || line === "--"
            || line.startsWith("[")
            || line.startsWith("(")
        ) {
            continue;
        }
        const countMatch = countMode ? /^(.*?):(\d+)$/.exec(line) : null;
        if (countMatch !== null) {
            const path = countMatch[1]!;
            const row = files.get(path) ?? { count: 0, lines: [] };
            row.count += Number(countMatch[2]);
            files.set(path, row);
            continue;
        }
        const match = /^(.*?):(\d+)(?::|\t|$)/.exec(line);
        if (match !== null) {
            const path = match[1]!;
            const row = files.get(path) ?? { count: 0, lines: [] };
            row.count += 1;
            if (row.lines.length < 12) row.lines.push(match[2]!);
            files.set(path, row);
            continue;
        }
        const count = /^(.*?):(\d+)$/.exec(line);
        const path = count?.[1] ?? line;
        const row = files.get(path) ?? { count: 0, lines: [] };
        row.count += count === null ? 1 : Number(count[2]);
        files.set(path, row);
    }
    if (files.size === 0) return source.includes("no matches") ? "No matches." : "No file rollup available.";
    return [...files.entries()].slice(0, 64).map(([path, row]) => {
        const locations = row.lines.length === 0
            ? ""
            : ` (lines ${row.lines.join(", ")})`;
        return `- ${path}: ${row.count} match${row.count === 1 ? "" : "es"}${locations}`;
    }).join("\n");
}

function bashDigest(
    source: string,
    call: ToolCallContent | undefined,
    isError: boolean,
): string {
    const command = typeof call?.input.command === "string"
        ? call.input.command
        : "(command unavailable)";
    const tail = source.split(/\r?\n/).filter((line) => line.length > 0).slice(-12);
    return [
        `Command: ${command}`,
        `Exit: ${isError ? "non-zero" : "0"}`,
        "Tail:",
        ...(tail.length === 0 ? ["(no output)"] : tail.map((line) => `  ${line}`)),
    ].join("\n");
}

function readDigest(source: string, call: ToolCallContent | undefined): string {
    const path = typeof call?.input.path === "string"
        ? call.input.path
        : "(path unavailable)";
    const footer = /\[vera\] Showing lines ([^.]+)\./.exec(source)?.[1]
        ?? "range unavailable";
    const signatures = source.split(/\r?\n/)
        .filter((line) => /^\d+\t/.test(line))
        .slice(0, 8);
    return [
        `Path: ${path}`,
        `Range: ${footer}`,
        "Signature lines:",
        ...(signatures.length === 0
            ? ["(none)"]
            : signatures.map((line) => `  ${line}`)),
    ].join("\n");
}

function listDigest(source: string): string {
    const lines = source.split(/\r?\n/)
        .filter((line) => line.length > 0 && !line.startsWith("(") && !line.startsWith("["));
    const footer = /of (\d+)/.exec(source)?.[1];
    const count = footer ?? String(lines.length);
    return [
        `Entries: ${count}`,
        "First entries:",
        ...(lines.length === 0 ? ["(none)"] : lines.slice(0, 12).map((line) => `  ${line}`)),
    ].join("\n");
}

// Only turns that are already finished, so an aged digest renders the same
// bytes on every later request and the provider's cached prefix survives.
function assistantTextUntil(
    entries: readonly ToolResultHistoryEntry[],
    resultIndex: number,
    turnsAt: ReadonlyMap<number, number>,
    endTurn: number,
): string {
    const texts: string[] = [];
    for (let index = resultIndex + 1; index < entries.length; index += 1) {
        if ((turnsAt.get(index) ?? -1) >= endTurn) break;
        const message = entries[index]?.message;
        if (message?.role !== "assistant") continue;
        for (const content of message.content) {
            if (content.type === "text" || content.type === "thinking") {
                texts.push(content.text);
            }
        }
    }
    return texts.join("\n");
}

interface References {
    readonly locations: readonly { path: string; line: string }[];
    readonly fragments: readonly string[];
    readonly identifiers: readonly string[];
}

function extractReferences(text: string): References {
    const locations: { path: string; line: string }[] = [];
    for (const match of text.matchAll(/([\w.~\/-]+):(\d+)(?::\d+)?/g)) {
        locations.push({ path: match[1]!, line: match[2]! });
    }
    const fragments = new Set<string>();
    for (const match of text.matchAll(/["'`]([^"'`\n]{3,120})["'`]/g)) {
        fragments.add(match[1]!);
    }
    const identifiers = new Set<string>();
    const stopWords = new Set([
        "and", "are", "but", "for", "from", "has", "have", "into",
        "line", "that", "the", "this", "used", "was", "with",
    ]);
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
        if (!stopWords.has(match[0]!.toLowerCase())) {
            identifiers.add(match[0]!);
        }
    }
    return {
        locations,
        fragments: [...fragments],
        identifiers: [...identifiers],
    };
}

function provenanceLines(source: string, references: References): readonly string[] {
    if (
        references.locations.length === 0
        && references.fragments.length === 0
        && references.identifiers.length === 0
    ) {
        return [];
    }
    const retained: string[] = [];
    for (const line of source.split(/\r?\n/)) {
        if (
            references.fragments.some((fragment) => line.includes(fragment))
            || references.identifiers.some((identifier) => line.includes(identifier))
            || references.locations.some((location) =>
                line.includes(`${location.path}:${location.line}`)
                || line.startsWith(`${location.line}\t`)
            )
        ) {
            retained.push(line);
            if (retained.length === 32) break;
        }
    }
    return retained;
}

function readSpill(path: string | undefined): string | undefined {
    if (path === undefined) return undefined;
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

function boundDigest(text: string, originalBytes: number): string {
    const ceiling = Math.min(originalBytes, TOOL_RESULT_CEILING_BYTES);
    if (Buffer.byteLength(text, "utf8") <= ceiling) return text;
    const marker = `\n[vera] Digest clipped to ${ceiling} bytes.\n`;
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= ceiling) {
        return decode(Buffer.from(text, "utf8").subarray(0, ceiling));
    }
    const available = ceiling - markerBytes;
    const headBytes = Math.ceil(available / 2);
    const bytes = Buffer.from(text, "utf8");
    return decode(bytes.subarray(0, headBytes))
        + marker
        + decode(bytes.subarray(bytes.length - (available - headBytes)));
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8")
        .decode(bytes)
        .replace(/^�+/, "")
        .replace(/�+$/, "");
}

function formatBytes(bytes: number): string {
    return `${bytes.toLocaleString()} bytes`;
}

import {
    closeSync,
    copyFileSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { buildContextReport } from "../src/core-extensions/context/context-report.ts";
import {
    isContextMeasurement,
    type ContextMeasurement,
    type ContextProjectionComponent,
} from "../src/engine/context-measurement.ts";
import {
    createHostLockfile,
    defaultHostLockPath,
    defaultHostSocketPath,
    type HostLockfile,
} from "../src/host/lockfile.ts";
import type { VeraClientContextSnapshot } from "../src/sdk/context.ts";
import {
    applyContextMeasurementRecipe,
    compactContextMeasurement,
    CONTEXT_MEASUREMENT_KEYFRAME_INTERVAL,
    isContextMeasurementRecipe,
} from "../src/store/context-measurement-record.ts";
import {
    defaultSessionDirectory,
    SessionStore,
} from "../src/store/session-store.ts";

const MEASUREMENT_PREFIX = '{"type":"context_measurement"';
const REPORT_WIDTH = 120;

export interface CompactOptions {
    readonly home: string;
    readonly write: boolean;
}

export interface CompactSeams {
    readonly lockfile?: HostLockfile;
    readonly compare?: (original: string, converted: string) => Promise<number>;
    readonly now?: () => Date;
}

export interface CompactSummary {
    readonly files: number;
    readonly changedFiles: number;
    readonly failedFiles: number;
    readonly beforeBytes: number;
    readonly afterBytes: number;
    readonly measurementRecords: number;
    readonly backupDirectory?: string;
}

export interface SessionRewrite {
    readonly source: string;
    readonly changed: number;
    readonly measurementRecords: number;
}

interface Totals {
    files: number;
    changedFiles: number;
    failedFiles: number;
    beforeBytes: number;
    afterBytes: number;
    measurementRecords: number;
}

interface ConversionState {
    components: readonly ContextProjectionComponent[] | undefined;
    sinceKeyframe: number;
    lastRecordCompact: boolean;
}

/**
 * Rewrites old full context measurement records into the compact form. Every
 * other line is copied byte for byte and in order. Already compact records are
 * left alone, so a second run changes nothing.
 */
export function rewriteSessionSource(
    path: string,
    source: string,
): SessionRewrite {
    const newlineAt = source.lastIndexOf("\n");
    const body = newlineAt === -1 ? "" : source.slice(0, newlineAt + 1);
    const tail = newlineAt === -1 ? source : source.slice(newlineAt + 1);
    const lines = body === "" ? [] : body.slice(0, -1).split("\n");
    const state: ConversionState = {
        components: undefined,
        sinceKeyframe: 0,
        lastRecordCompact: false,
    };
    let changed = 0;
    let measurementRecords = 0;
    const rewritten = lines.map((line, index) => {
        if (!line.startsWith(MEASUREMENT_PREFIX)) return line;
        measurementRecords += 1;
        const result = rewriteMeasurementLine(
            path,
            index + 2,
            line,
            state,
        );
        if (result !== line) changed += 1;
        return result;
    });
    if (changed === 0) {
        return { source, changed, measurementRecords };
    }
    return {
        source: `${rewritten.join("\n")}\n${tail}`,
        changed,
        measurementRecords,
    };
}

function rewriteMeasurementLine(
    path: string,
    lineNumber: number,
    line: string,
    state: ConversionState,
): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        throw invalidMeasurement(path, lineNumber, "invalid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw invalidMeasurement(path, lineNumber, "not a measurement object");
    }
    const value = parsed as Record<string, unknown>;
    if (value.type !== "context_measurement") return line;
    if (value.contextRecipe !== undefined) {
        if (!isContextMeasurementRecipe(value.contextRecipe)) {
            throw invalidMeasurement(path, lineNumber, "invalid context recipe");
        }
        const components = applyContextMeasurementRecipe(
            state.components,
            value.contextRecipe,
        );
        if (components === undefined) {
            throw invalidMeasurement(path, lineNumber, "recipe has no base");
        }
        state.components = components;
        state.sinceKeyframe = value.contextRecipe.keyframe
            ? 0
            : state.sinceKeyframe + 1;
        state.lastRecordCompact = true;
        return line;
    }
    if (
        !isContextMeasurement(value.measurement)
        || value.measurement.projection === undefined
        || typeof value.timestamp !== "string"
        || (value.afterMessageId !== null && typeof value.afterMessageId !== "string")
    ) {
        throw invalidMeasurement(path, lineNumber, "invalid measurement");
    }
    const keyframe = !state.lastRecordCompact
        || state.components === undefined
        || state.sinceKeyframe >= CONTEXT_MEASUREMENT_KEYFRAME_INTERVAL;
    const compact = compactContextMeasurement(
        value.measurement as ContextMeasurement,
        state.components,
        keyframe,
    );
    state.components = value.measurement.projection.components;
    state.sinceKeyframe = keyframe ? 0 : state.sinceKeyframe + 1;
    state.lastRecordCompact = true;
    return JSON.stringify({
        type: "context_measurement",
        timestamp: value.timestamp,
        afterMessageId: value.afterMessageId,
        measurement: compact.measurement,
        contextRecipe: compact.recipe,
    });
}

/**
 * Compares two disposable session files at the current head and after a rewind
 * before every active user message. Both stores append rewind records, so pass
 * copies, never the files being installed.
 */
export async function compareContextSessions(
    originalPath: string,
    convertedPath: string,
): Promise<number> {
    const original = await SessionStore.open(originalPath);
    const converted = await SessionStore.open(convertedPath);
    if (original.activeHeadId() !== converted.activeHeadId()) {
        throw new Error(`${convertedPath} has a different active head`);
    }
    const originalEntries = original.activeEntries().map((entry) => entry.id);
    const convertedEntries = converted.activeEntries().map((entry) => entry.id);
    if (!Bun.deepEquals(originalEntries, convertedEntries)) {
        throw new Error(`${convertedPath} has different active messages`);
    }
    const users = original.activeEntries()
        .filter((entry) =>
            entry.message.role === "user" && entry.message.internal !== true
        )
        .map((entry) => entry.id);
    let checks = 0;
    const compare = (point: string): void => {
        const left = original.latestContextMeasurement();
        const right = converted.latestContextMeasurement();
        if (!Bun.deepEquals(left, right)) {
            throw new Error(`${point}: context measurement differs`);
        }
        const leftReport = buildContextReport(contextSnapshot(left), true, REPORT_WIDTH);
        const rightReport = buildContextReport(contextSnapshot(right), true, REPORT_WIDTH);
        if (!Bun.deepEquals(leftReport, rightReport)) {
            throw new Error(`${point}: context report differs`);
        }
        if (original.activeHeadId() !== converted.activeHeadId()) {
            throw new Error(`${point}: active head differs`);
        }
        checks += 1;
    };
    compare("at the current head");
    for (let index = users.length - 1; index >= 0; index -= 1) {
        const userMessageId = users[index]!;
        await original.rewindBefore(userMessageId);
        await converted.rewindBefore(userMessageId);
        compare(`before user message ${userMessageId}`);
    }
    return checks;
}

function contextSnapshot(
    measurement: ContextMeasurement | undefined,
): VeraClientContextSnapshot {
    if (measurement === undefined) return { availability: "unavailable" };
    return {
        availability: "available",
        model: {
            model: "context-record-check",
            ...(measurement.capacity === undefined
                ? {}
                : { capacity: measurement.capacity }),
        },
        headline: { tokens: measurement.tokens, estimated: measurement.estimated },
        ...(measurement.projection === undefined
            ? {}
            : { projection: measurement.projection }),
        ...(measurement.compaction === undefined
            ? {}
            : { compaction: measurement.compaction }),
    };
}

export function parseCompactOptions(argv: readonly string[]): CompactOptions {
    let home: string | undefined;
    let write = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === "--write") {
            write = true;
            continue;
        }
        if (argument === "--home") {
            home = argv[index + 1];
            index += 1;
            if (home === undefined || home.startsWith("--")) {
                throw new Error("--home needs a path");
            }
            continue;
        }
        throw new Error(
            `Unknown argument ${argument}. Use --home <path> [--write].`,
        );
    }
    if (home === undefined) {
        throw new Error(
            "Use --home <path> [--write]. Dry run is the default.",
        );
    }
    return { home: resolve(home), write };
}

export async function compactContextRecords(
    options: CompactOptions,
    report: (line: string) => void,
    seams: CompactSeams = {},
): Promise<CompactSummary> {
    await refuseRunningHost(options.home, seams.lockfile);
    const directory = defaultSessionDirectory(options.home);
    let names: string[];
    try {
        names = readdirSync(directory)
            .filter((name) => name.endsWith(".jsonl"))
            .sort();
    } catch (error) {
        throw new Error(
            `Cannot read session directory ${directory}: ${messageOf(error)}`,
        );
    }
    if (names.length === 0) {
        report(`no session files in ${directory}`);
        return {
            files: 0,
            changedFiles: 0,
            failedFiles: 0,
            beforeBytes: 0,
            afterBytes: 0,
            measurementRecords: 0,
        };
    }
    const compare = seams.compare ?? compareContextSessions;
    const backupDirectory = options.write
        ? backupDirectoryFor(options.home, seams.now?.() ?? new Date())
        : undefined;
    let backupAnnounced = false;
    const totals: Totals = {
        files: 0,
        changedFiles: 0,
        failedFiles: 0,
        beforeBytes: 0,
        afterBytes: 0,
        measurementRecords: 0,
    };
    for (const name of names) {
        const path = join(directory, name);
        let before;
        let original: string;
        let rewrite: SessionRewrite;
        try {
            before = statSync(path);
            original = readFileSync(path, "utf8");
            rewrite = rewriteSessionSource(path, original);
        } catch (error) {
            totals.files += 1;
            totals.failedFiles += 1;
            report(`${path}: FAILED: ${messageOf(error)}`);
            continue;
        }
        const afterBytes = Buffer.byteLength(rewrite.source);
        totals.files += 1;
        totals.beforeBytes += before.size;
        totals.afterBytes += afterBytes;
        totals.measurementRecords += rewrite.measurementRecords;
        const line = `${path}: ${before.size} -> ${afterBytes} bytes`
            + ` (${megabytes(before.size)} -> ${megabytes(afterBytes)} MB,`
            + ` ${percent(afterBytes, before.size)}),`
            + ` ${rewrite.measurementRecords} measurement records`;
        if (rewrite.changed === 0) {
            report(line);
            continue;
        }
        totals.changedFiles += 1;
        if (backupDirectory !== undefined && !backupAnnounced) {
            mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
            report(`backing up originals to ${backupDirectory}`);
            backupAnnounced = true;
        }
        if (!options.write) {
            report(`${line}; would rewrite ${rewrite.changed}`);
            continue;
        }
        try {
            const checks = await replaceSession(
                path,
                original,
                rewrite.source,
                before,
                backupDirectory!,
                compare,
            );
            report(`${line}; rewrote ${rewrite.changed}, verified ${checks} rewind points`);
        } catch (error) {
            totals.failedFiles += 1;
            report(`${path}: FAILED, original left untouched: ${messageOf(error)}`);
        }
    }
    const verb = options.write ? "converted" : "would convert";
    report(
        `${verb} ${totals.changedFiles} of ${totals.files} files:`
            + ` ${totals.beforeBytes} -> ${totals.afterBytes} bytes`
            + ` (${megabytes(totals.beforeBytes)} ->`
            + ` ${megabytes(totals.afterBytes)} MB,`
            + ` ${percent(totals.afterBytes, totals.beforeBytes)}),`
            + ` ${totals.measurementRecords} measurement records`,
    );
    if (totals.failedFiles > 0) {
        report(
            `${totals.failedFiles} files failed; their originals were left untouched`,
        );
    }
    return {
        ...totals,
        ...(backupDirectory === undefined || !backupAnnounced
            ? {}
            : { backupDirectory }),
    };
}

async function refuseRunningHost(
    home: string,
    provided?: HostLockfile,
): Promise<void> {
    const lockfile = provided ?? createHostLockfile({
        path: defaultHostLockPath(home),
        socketPath: defaultHostSocketPath(home),
    });
    let running = false;
    try {
        const diagnosis = await lockfile.diagnose!();
        running = diagnosis.record !== undefined || diagnosis.wedged === true;
    } catch (error) {
        throw new Error(
            `Cannot check for a running host for ${home}: ${messageOf(error)}`,
        );
    }
    if (running) {
        throw new Error(
            `A Vera host is running for ${home}. Stop it before converting`
                + " session records.",
        );
    }
}

async function replaceSession(
    path: string,
    originalSource: string,
    convertedSource: string,
    before: { readonly size: number; readonly mtimeMs: number; readonly mode: number },
    backupDirectory: string,
    compare: (original: string, converted: string) => Promise<number>,
): Promise<number> {
    const temporary = join(
        dirname(path),
        `.${basename(path)}.compact-${process.pid}.tmp`,
    );
    const originalCopy = `${temporary}.original`;
    const convertedCopy = `${temporary}.converted`;
    try {
        writeFileSynced(temporary, convertedSource, before.mode & 0o777);
        copyFileSync(path, originalCopy);
        copyFileSync(temporary, convertedCopy);
        const current = statSync(path);
        if (
            current.size !== before.size
            || current.mtimeMs !== before.mtimeMs
            || Buffer.byteLength(originalSource) !== before.size
        ) {
            throw new Error(`${path} changed while it was being converted`);
        }
        const checks = await compare(originalCopy, convertedCopy);
        const backupPath = uniqueBackupPath(backupDirectory, basename(path));
        copyFileSync(path, backupPath);
        renameSync(temporary, path);
        return checks;
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    } finally {
        rmSync(originalCopy, { force: true });
        rmSync(convertedCopy, { force: true });
    }
}

function uniqueBackupPath(directory: string, name: string): string {
    let candidate = join(directory, name);
    for (let suffix = 1; existsSync(candidate); suffix += 1) {
        candidate = join(directory, `${name}.${suffix}`);
    }
    return candidate;
}

function backupDirectoryFor(home: string, now: Date): string {
    const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
    return join(
        home,
        "runtime",
        "session-backups",
        `compact-${stamp}-${process.pid}`,
    );
}

function writeFileSynced(path: string, source: string, mode: number): void {
    const descriptor = openSync(path, "w", mode);
    try {
        writeSync(descriptor, source);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function invalidMeasurement(
    path: string,
    lineNumber: number,
    reason: string,
): Error {
    return new Error(`${path}:${lineNumber}: ${reason}`);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function megabytes(bytes: number): string {
    return (bytes / 1_000_000).toFixed(1);
}

function percent(after: number, before: number): string {
    if (before === 0) return "0%";
    return `${((after / before) * 100).toFixed(1)}%`;
}

if (import.meta.main) {
    const options = parseCompactOptions(process.argv.slice(2));
    compactContextRecords(options, (line) => {
        process.stdout.write(`${line}\n`);
    }).then((summary) => {
        if (summary.failedFiles > 0) process.exitCode = 1;
    }).catch((error: unknown) => {
        process.stderr.write(`${messageOf(error)}\n`);
        process.exitCode = 1;
    });
}

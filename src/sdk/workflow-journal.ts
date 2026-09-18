import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowRunHeader {
    readonly run_id: string;
    readonly workflow: string;
    readonly status: string;
    // Present only while a step is in flight, and left behind by a crash.
    readonly active?: WorkflowActiveStep;
    readonly attempts: readonly WorkflowAttempt[];
}

export interface WorkflowAttempt {
    readonly started_at: string;
    readonly pid: number;
    readonly host: string;
    // Missing on an attempt whose process never came back.
    readonly finished_at?: string;
    readonly status?: string;
}

export interface WorkflowActiveStep {
    readonly key: string;
    readonly step: string;
    readonly at: string;
}

export interface WorkflowJournalRecord {
    readonly seq: number;
    readonly key: string;
    readonly ok: true;
    readonly at: string;
    readonly ms: number;
    readonly value?: unknown;
    readonly ref?: string;
}

export interface WorkflowRun {
    readonly header: WorkflowRunHeader;
    readonly records: readonly WorkflowJournalRecord[];
}

export function readWorkflowRun(runDir: string): WorkflowRun {
    const headerPath = join(runDir, "header.json");
    const headerValue = parseJson(readFileSync(headerPath, "utf8"), headerPath);
    if (!isRecord(headerValue)) {
        throw new Error(`workflow header must be an object: ${headerPath}`);
    }
    const { run_id: runId, workflow, status } = headerValue;
    if (
        typeof runId !== "string"
        || typeof workflow !== "string"
        || typeof status !== "string"
    ) {
        throw new Error(`workflow header has invalid fields: ${headerPath}`);
    }
    const active = readActiveStep(headerValue.active, headerPath);
    const attempts = readAttempts(headerValue.attempts, headerPath);

    const journalPath = join(runDir, "journal.ndjson");
    const journalText = readFileSync(journalPath, "utf8");
    const lines = journalLines(journalText, journalPath);
    const records = lines.map((line) => readRecord(line, runDir, journalPath));

    return {
        header: active === undefined
            ? { run_id: runId, workflow, status, attempts }
            : { run_id: runId, workflow, status, active, attempts },
        records,
    };
}

function readAttempts(value: unknown, headerPath: string): WorkflowAttempt[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`workflow header attempts must be an array: ${headerPath}`);
    }
    return value.map((entry: unknown): WorkflowAttempt => {
        if (!isRecord(entry)) {
            throw new Error(`workflow attempt must be an object: ${headerPath}`);
        }
        const { started_at: startedAt, pid, host, finished_at: finishedAt, status } = entry;
        if (
            typeof startedAt !== "string"
            || typeof pid !== "number"
            || !Number.isInteger(pid)
            || typeof host !== "string"
        ) {
            throw new Error(`workflow attempt has invalid fields: ${headerPath}`);
        }
        const attempt: WorkflowAttempt = { started_at: startedAt, pid, host };
        if (finishedAt === undefined) {
            return attempt;
        }
        if (typeof finishedAt !== "string" || typeof status !== "string") {
            throw new Error(`finished workflow attempt has invalid fields: ${headerPath}`);
        }
        return { ...attempt, finished_at: finishedAt, status };
    });
}

function readActiveStep(
    value: unknown,
    headerPath: string,
): WorkflowActiveStep | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`workflow header active step must be an object: ${headerPath}`);
    }
    const { key, step, at } = value;
    if (typeof key !== "string" || typeof step !== "string" || typeof at !== "string") {
        throw new Error(`workflow header active step has invalid fields: ${headerPath}`);
    }
    return { key, step, at };
}

function readRecord(
    line: string,
    runDir: string,
    journalPath: string,
): WorkflowJournalRecord {
    const value = parseJson(line, journalPath);
    if (!isRecord(value)) {
        throw new Error(`workflow journal record must be an object: ${journalPath}`);
    }
    const { seq, key, ok, at, ms } = value;
    if (
        typeof seq !== "number"
        || !Number.isInteger(seq)
        || typeof key !== "string"
        || ok !== true
        || typeof at !== "string"
        || at === ""
        || typeof ms !== "number"
        || !Number.isInteger(ms)
        || ms < 0
    ) {
        throw new Error(`workflow journal record has invalid fields: ${journalPath}`);
    }

    const hasValue = Object.hasOwn(value, "value");
    const hasRef = Object.hasOwn(value, "ref");
    if (hasValue === hasRef) {
        throw new Error(`workflow journal record has invalid value storage: ${journalPath}`);
    }
    if (hasValue) {
        if (Object.hasOwn(value, "bytes")) {
            throw new Error(`inline workflow journal record has bytes: ${journalPath}`);
        }
        return { seq, key, ok: true, at, ms, value: value.value };
    }

    const reference = value.ref;
    const byteCount = value.bytes;
    if (
        typeof reference !== "string"
        || !/^[0-9a-f]{64}$/.test(reference)
        || typeof byteCount !== "number"
        || !Number.isInteger(byteCount)
        || byteCount <= 8192
    ) {
        throw new Error(`workflow journal blob fields are invalid: ${journalPath}`);
    }
    const blobPath = join(runDir, "blobs", reference);
    const blobBytes = readFileSync(blobPath);
    if (blobBytes.byteLength !== byteCount) {
        throw new Error(`workflow journal blob byte count does not match: ${blobPath}`);
    }
    const digest = createHash("sha256").update(blobBytes).digest("hex");
    if (digest !== reference) {
        throw new Error(`workflow journal blob digest does not match: ${blobPath}`);
    }
    const blobText = blobBytes.toString("utf8");
    return {
        seq,
        key,
        ok: true,
        at,
        ms,
        value: parseJson(blobText, blobPath),
        ref: reference,
    };
}

function journalLines(text: string, path: string): string[] {
    if (text === "") {
        return [];
    }
    const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
    const lines = withoutFinalNewline.split("\n");
    if (lines.some((line) => line === "")) {
        throw new Error(`workflow journal contains a blank line: ${path}`);
    }
    return lines;
}

function parseJson(text: string, path: string): unknown {
    try {
        const value: unknown = JSON.parse(text);
        return value;
    } catch (error) {
        throw new Error(`invalid JSON in ${path}`, { cause: error });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

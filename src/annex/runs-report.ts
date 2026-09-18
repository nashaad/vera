import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
    readWorkflowRun,
    type WorkflowAttempt,
    type WorkflowSpan,
} from "../sdk/workflow-journal.ts";

export interface RunRow {
    readonly runId: string;
    readonly workflow: string;
    readonly status: string;
    readonly startedAt: string;
    /** Wall time of the last attempt, absent while it is still open. */
    readonly ms?: number;
    readonly steps: number;
    readonly tries: number;
    readonly failedTries: number;
    /** Why the run could not be read. The other fields are then placeholders. */
    readonly problem?: string;
}

export interface RunAttemptView {
    readonly number: number;
    readonly startedAt: string;
    readonly pid: number;
    readonly host: string;
    readonly finishedAt?: string;
    readonly status?: string;
    readonly spans: readonly WorkflowSpan[];
}

export interface RunStepView {
    readonly key: string;
    readonly step: string;
    readonly at: string;
    readonly ms: number;
}

export interface RunDetail {
    readonly runId: string;
    readonly workflow: string;
    readonly status: string;
    readonly active?: { readonly step: string; readonly at: string };
    readonly attempts: readonly RunAttemptView[];
    readonly steps: readonly RunStepView[];
    /** Spans belonging to no listed attempt, so nothing is silently dropped. */
    readonly orphanSpans: readonly WorkflowSpan[];
}

export function foldRunRows(workflowDirectory: string): RunRow[] {
    return runDirectories(workflowDirectory)
        .map((runId) => runRow(workflowDirectory, runId))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function foldRunDetail(
    workflowDirectory: string,
    runId: string,
): RunDetail | undefined {
    if (!isRunId(runId)) {
        return undefined;
    }
    const runDir = join(workflowDirectory, runId);
    if (!existsSync(join(runDir, "header.json"))) {
        return undefined;
    }
    const run = readWorkflowRun(runDir);
    const attempts = run.header.attempts.map((attempt, index) =>
        attemptView(attempt, index + 1, run.spans)
    );
    const claimed = new Set(
        attempts.flatMap((attempt) => attempt.spans.map((span) => span.span)),
    );
    const detail: RunDetail = {
        runId: run.header.run_id,
        workflow: run.header.workflow,
        status: run.header.status,
        attempts,
        steps: run.records.map((record) => ({
            key: record.key,
            step: stepNameOf(record.key),
            at: record.at,
            ms: record.ms,
        })),
        orphanSpans: run.spans.filter((span) => !claimed.has(span.span)),
    };
    const active = run.header.active;
    if (active === undefined) {
        return detail;
    }
    return { ...detail, active: { step: active.step, at: active.at } };
}

function attemptView(
    attempt: WorkflowAttempt,
    number: number,
    spans: readonly WorkflowSpan[],
): RunAttemptView {
    const view: RunAttemptView = {
        number,
        startedAt: attempt.started_at,
        pid: attempt.pid,
        host: attempt.host,
        spans: spans.filter((span) => span.attempt === number),
    };
    if (attempt.finished_at === undefined || attempt.status === undefined) {
        return view;
    }
    return { ...view, finishedAt: attempt.finished_at, status: attempt.status };
}

function runRow(workflowDirectory: string, runId: string): RunRow {
    try {
        const run = readWorkflowRun(join(workflowDirectory, runId));
        const attempts = run.header.attempts;
        const last = attempts.at(-1);
        const row: RunRow = {
            runId: run.header.run_id,
            workflow: run.header.workflow,
            status: run.header.status,
            startedAt: attempts[0]?.started_at ?? "",
            steps: run.records.length,
            tries: run.spans.length,
            failedTries: run.spans.filter((span) => span.status === "failed")
                .length,
        };
        if (last?.finished_at === undefined) {
            return row;
        }
        const ms = Date.parse(last.finished_at) - Date.parse(last.started_at);
        return Number.isFinite(ms) ? { ...row, ms } : row;
    } catch (error) {
        return {
            runId,
            workflow: "",
            status: "unreadable",
            startedAt: "",
            steps: 0,
            tries: 0,
            failedTries: 0,
            problem: error instanceof Error ? error.message : String(error),
        };
    }
}

function runDirectories(workflowDirectory: string): string[] {
    if (!existsSync(workflowDirectory)) {
        return [];
    }
    return readdirSync(workflowDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isRunId(entry.name))
        .filter((entry) =>
            existsSync(join(workflowDirectory, entry.name, "header.json"))
        )
        .map((entry) => entry.name);
}

function isRunId(name: string): boolean {
    return /^wf_[0-9a-f]{16}$/.test(name);
}

function stepNameOf(key: string): string {
    // Keys read workflow/step#ordinal:digest.
    const match = /^[^/]+\/([^#]+)#/.exec(key);
    return match?.[1] ?? key;
}

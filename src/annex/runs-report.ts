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
    /** What the recorded model calls cost, absent when none reported one. */
    readonly cost?: number;
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
    readonly spans: readonly RunSpanView[];
}

/** One span flattened out of its OpenTelemetry field names, for drawing. */
export interface RunSpanView {
    readonly spanId: string;
    readonly parentId: string;
    /** How many spans deep this one sits, so a model call draws under its step. */
    readonly depth: number;
    readonly step: string;
    readonly attempt: number;
    readonly start: string;
    // Missing together on the try whose process died inside it.
    readonly end?: string;
    readonly ms?: number;
    readonly outcome?: string;
    readonly message?: string;
    /** Set on a model call, which is a span of its own under the step. */
    readonly model?: string;
    readonly tokens?: number;
    readonly cost?: number;
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
    readonly cost?: number;
    readonly attempts: readonly RunAttemptView[];
    readonly steps: readonly RunStepView[];
    /** Spans belonging to no listed attempt, so nothing is silently dropped. */
    readonly orphanSpans: readonly RunSpanView[];
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
        attempts.flatMap((attempt) => attempt.spans.map((span) => span.spanId)),
    );
    const spend = spendOf(run.spans);
    const detail: RunDetail = {
        runId: run.header.run_id,
        workflow: run.header.workflow,
        status: run.header.status,
        ...(spend === undefined ? {} : { cost: spend }),
        attempts,
        steps: run.records.map((record) => ({
            key: record.key,
            step: stepNameOf(record.key),
            at: record.at,
            ms: record.ms,
        })),
        orphanSpans: run.spans
            .filter((span) => !claimed.has(span.span_id))
            .map(spanView),
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
        spans: spans
            .filter((span) => span.attributes["halcyon.attempt"] === number)
            .map(spanView),
    };
    if (attempt.finished_at === undefined || attempt.status === undefined) {
        return view;
    }
    return { ...view, finishedAt: attempt.finished_at, status: attempt.status };
}

function spanView(span: WorkflowSpan): RunSpanView {
    const view: RunSpanView = {
        spanId: span.span_id,
        parentId: span.parent_id,
        // Ids read a<attempt>[.<span>]*, so the dots count the nesting.
        depth: Math.max(0, span.parent_id.split(".").length - 1),
        step: span.name,
        attempt: Number(span.attributes["halcyon.attempt"]),
        start: span.start_time,
        ...usageOf(span),
    };
    const outcome = span.attributes["halcyon.outcome"];
    const ms = span.attributes["halcyon.duration_ms"];
    if (span.end_time === undefined || typeof outcome !== "string") {
        return view;
    }
    const ended: RunSpanView = {
        ...view,
        end: span.end_time,
        ms: typeof ms === "number" ? ms : 0,
        outcome,
    };
    return span.status_message === undefined
        ? ended
        : { ...ended, message: span.status_message };
}

function usageOf(
    span: WorkflowSpan,
): { model?: string; tokens?: number; cost?: number } {
    const model = span.attributes["llm.model_name"];
    if (typeof model !== "string") {
        return {};
    }
    const tokens = span.attributes["llm.token_count.total"];
    const cost = span.attributes["llm.cost.total"];
    return {
        model,
        ...(typeof tokens === "number" ? { tokens } : {}),
        ...(typeof cost === "number" ? { cost } : {}),
    };
}

/** The tries of a step, leaving out the model calls recorded under them. */
function stepSpans(spans: readonly WorkflowSpan[]): readonly WorkflowSpan[] {
    return spans.filter(
        (span) => span.attributes["openinference.span.kind"] === "CHAIN",
    );
}

/** Adds up what the model calls reported, which is nothing until one does. */
function spendOf(spans: readonly WorkflowSpan[]): number | undefined {
    let spend: number | undefined;
    for (const span of spans) {
        const cost = span.attributes["llm.cost.total"];
        if (typeof cost === "number" && Number.isFinite(cost)) {
            spend = (spend ?? 0) + cost;
        }
    }
    return spend;
}

function runRow(workflowDirectory: string, runId: string): RunRow {
    try {
        const run = readWorkflowRun(join(workflowDirectory, runId));
        const attempts = run.header.attempts;
        const last = attempts.at(-1);
        const spend = spendOf(run.spans);
        const steps = stepSpans(run.spans);
        const row: RunRow = {
            runId: run.header.run_id,
            workflow: run.header.workflow,
            status: run.header.status,
            startedAt: attempts[0]?.started_at ?? "",
            steps: run.records.length,
            tries: steps.length,
            failedTries: steps.filter(
                (span) => span.attributes["halcyon.outcome"] === "failed",
            ).length,
            ...(spend === undefined ? {} : { cost: spend }),
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

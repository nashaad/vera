import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkflowRun } from "../../src/sdk/workflow-journal.ts";


test("readWorkflowRun loads a Python journal blob", () => {
    const runDir = join(
        import.meta.dir,
        "../../python/tests/fixtures/wf_blob_run",
    );

    const run = readWorkflowRun(runDir);

    expect(run.header.run_id).toBe("wf_e6dd8550cc0d4cda");
    expect(run.records).toHaveLength(1);
    const record = run.records[0];
    expect(record?.ref).toBe(
        "293fefb1b30473c82c3b46b231e62ed63e2b31bdf2cb0fa6a529acfb97ed360c",
    );
    expect(typeof record?.value).toBe("string");
    if (typeof record?.value !== "string") {
        throw new Error("fixture blob value must be a string");
    }
    expect(record.value).toHaveLength(9000);
    expect(record.ms).toBe(12);
});

test("readWorkflowRun carries step timing and the step in flight", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wf-timing-"));
    writeFileSync(
        join(runDir, "header.json"),
        JSON.stringify({
            run_id: "wf_00000000000000aa",
            workflow: "timed",
            status: "running",
            active: { key: "timed/slow#0:abcd1234", step: "slow", at: "2026-09-17T12:00:00+00:00" },
        }),
    );
    writeFileSync(
        join(runDir, "journal.ndjson"),
        `${JSON.stringify({
            seq: 1,
            key: "timed/quick#0:abcd1234",
            ok: true,
            at: "2026-09-17T11:59:59+00:00",
            ms: 41,
            value: 6,
        })}\n`,
    );

    const run = readWorkflowRun(runDir);

    expect(run.header.active?.step).toBe("slow");
    expect(run.records[0]?.at).toBe("2026-09-17T11:59:59+00:00");
    expect(run.records[0]?.ms).toBe(41);
});

test("readWorkflowRun refuses a record with no timing", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wf-untimed-"));
    writeFileSync(
        join(runDir, "header.json"),
        JSON.stringify({ run_id: "wf_00000000000000ab", workflow: "timed", status: "ok" }),
    );
    writeFileSync(
        join(runDir, "journal.ndjson"),
        `${JSON.stringify({ seq: 1, key: "timed/quick#0:abcd1234", ok: true, value: 6 })}\n`,
    );

    expect(() => readWorkflowRun(runDir)).toThrow("invalid fields");
});

test("readWorkflowRun carries attempts, open and closed", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wf-attempts-"));
    writeFileSync(
        join(runDir, "header.json"),
        JSON.stringify({
            run_id: "wf_00000000000000ac",
            workflow: "crashy",
            status: "ok",
            attempts: [
                { started_at: "2026-09-17T12:00:00+00:00", pid: 10, host: "box" },
                {
                    started_at: "2026-09-17T12:00:05+00:00",
                    pid: 11,
                    host: "box",
                    finished_at: "2026-09-17T12:00:06+00:00",
                    status: "ok",
                },
            ],
        }),
    );
    writeFileSync(join(runDir, "journal.ndjson"), "");

    const run = readWorkflowRun(runDir);

    expect(run.header.attempts).toHaveLength(2);
    expect(run.header.attempts[0]?.finished_at).toBeUndefined();
    expect(run.header.attempts[1]?.status).toBe("ok");
});

test("readWorkflowRun folds span lines into one entry per try", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wf-spans-"));
    writeFileSync(
        join(runDir, "header.json"),
        JSON.stringify({
            run_id: "wf_00000000000000bb",
            workflow: "shaky",
            status: "ok",
            attempts: [],
        }),
    );
    writeFileSync(join(runDir, "journal.ndjson"), "");
    writeFileSync(
        join(runDir, "spans.ndjson"),
        [
            { span: "a1.0", attempt: 1, key: "shaky/try#0:abcd1234", step: "try", start: "2026-09-17T12:00:00+00:00" },
            { span: "a1.0", end: "2026-09-17T12:00:01+00:00", ms: 1000, status: "failed", message: "upstream said no" },
            { span: "a1.1", attempt: 1, key: "shaky/try#0:abcd1234", step: "try", start: "2026-09-17T12:00:01+00:00" },
            { span: "a1.1", end: "2026-09-17T12:00:02+00:00", ms: 900, status: "ok" },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );

    const run = readWorkflowRun(runDir);

    expect(run.spans).toHaveLength(2);
    expect(run.spans[0]?.status).toBe("failed");
    expect(run.spans[0]?.message).toBe("upstream said no");
    expect(run.spans[1]?.ms).toBe(900);
});

test("readWorkflowRun leaves the span a crash died in open", () => {
    const runDir = mkdtempSync(join(tmpdir(), "wf-open-span-"));
    writeFileSync(
        join(runDir, "header.json"),
        JSON.stringify({
            run_id: "wf_00000000000000cc",
            workflow: "crashy",
            status: "crashed",
            attempts: [],
        }),
    );
    writeFileSync(join(runDir, "journal.ndjson"), "");
    writeFileSync(
        join(runDir, "spans.ndjson"),
        `${JSON.stringify({
            span: "a1.0",
            attempt: 1,
            key: "crashy/slow#0:abcd1234",
            step: "slow",
            start: "2026-09-17T12:00:00+00:00",
        })}\n`,
    );

    const run = readWorkflowRun(runDir);

    expect(run.spans[0]?.step).toBe("slow");
    expect(run.spans[0]?.end).toBeUndefined();
    expect(run.spans[0]?.status).toBeUndefined();
});

test("readWorkflowRun reads a run written before spans existed", () => {
    const runDir = join(
        import.meta.dir,
        "../../python/tests/fixtures/wf_blob_run",
    );

    expect(readWorkflowRun(runDir).spans).toEqual([]);
});

import { expect, test } from "bun:test";
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
});

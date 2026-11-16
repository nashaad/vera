import { expect, test } from "bun:test";

import { asyncSubagentStartedText, startedSubagentId } from "../../src/tools/subagent-started.ts";

test("@core the id the host writes into the started text reads back", () => {
    const id = "0c1d6f0e-8a5b-4a2f-9d5c-3c6a1b7e9f10";
    expect(startedSubagentId(asyncSubagentStartedText(id))).toBe(id);
});

test("the started text is the sentence the host has always returned", () => {
    expect(asyncSubagentStartedText("child-1")).toBe(
        "Async subagent child-1 started. Its final summary will arrive as a task notification.",
    );
});

test("the id is read when a notice comes before the started text", () => {
    const output = `Using the fallback model.\n\n${asyncSubagentStartedText("child-2")}`;
    expect(startedSubagentId(output)).toBe("child-2");
});

test("other output has no id", () => {
    expect(startedSubagentId("")).toBeUndefined();
    expect(startedSubagentId("Async subagent  started. Its final summary will arrive as a task notification.")).toBeUndefined();
    expect(startedSubagentId("Subagent child-3 finished.")).toBeUndefined();
});

import { expect, test } from "bun:test";

import { inspectReportSection } from "../../src/sdk/inspect-report.ts";

test("inspect report section renders a heading and rule", () => {
    expect(inspectReportSection("Session", undefined, 22)).toEqual([
        "## SESSION",
        "─".repeat(20),
        "",
    ]);
});

test("inspect report section right-aligns a value that fits", () => {
    const lines = inspectReportSection("Context usage", "12k / 20k", 42);

    expect(lines).toEqual([
        `## CONTEXT USAGE${" ".repeat(15)}12k / 20k`,
        "─".repeat(40),
        "",
    ]);
    expect(lines[0]?.length).toBe(40);
});

test("inspect report section moves a value that does not fit", () => {
    expect(inspectReportSection(
        "Context usage",
        "No completed model request yet",
        36,
    )).toEqual([
        "## CONTEXT USAGE",
        "No completed model request yet",
        "─".repeat(34),
        "",
    ]);
});

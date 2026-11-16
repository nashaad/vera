import { expect, test } from "bun:test";

import {
    classifyViolation,
    formatViolationBlock,
} from "../../src/sandbox/violations.ts";

test("@core sandbox violation classifies writes, reads and connections", () => {
    expect(
        classifyViolation("bash(98700) deny(1) file-write-create /Users/me/.zshrc"),
    ).toMatchObject({
        kind: "write",
        target: "/Users/me/.zshrc",
    });
    expect(
        classifyViolation("cat(98701) deny(1) file-read-data /Users/me/.aws/credentials"),
    ).toMatchObject({
        kind: "read",
        target: "/Users/me/.aws/credentials",
    });
    expect(
        classifyViolation(
            "deny network-outbound github.com:443 (host is not on the allow list)",
        ),
    ).toMatchObject({
        kind: "connect",
        target: "github.com:443",
    });
    expect(classifyViolation("something else happened")).toMatchObject({
        kind: "other",
        target: "",
    });
});

test("@core sandbox violation block lists five lines then the rest", () => {
    const violations = [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
    ].map((name) => classifyViolation(`deny file-write-create /data/${name}`));

    expect(formatViolationBlock(violations)).toBe([
        "Blocked by sandbox:",
        "  write /data/1",
        "  write /data/2",
        "  write /data/3",
        "  write /data/4",
        "  write /data/5",
        "  and 2 more",
    ].join("\n"));
});

test("@core sandbox violation block is empty when nothing was blocked", () => {
    expect(formatViolationBlock([])).toBe("");
    expect(formatViolationBlock([
        classifyViolation("deny file-write-data /data/x"),
    ])).toBe("Blocked by sandbox:\n  write /data/x");
});

test("@core sandbox violation block drops duplicates and unclassified lines", () => {
    const block = formatViolationBlock([
        classifyViolation("deny file-write-create /data/x"),
        classifyViolation("deny file-write-create /data/x"),
        classifyViolation("noise"),
    ]);
    expect(block).toBe("Blocked by sandbox:\n  write /data/x");
});

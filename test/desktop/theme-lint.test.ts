import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { themeViolations } from "../../clients/ui/src/lint/theme-lint.ts";

const roots: string[] = [];

function lint(files: Record<string, string>): readonly string[] {
    const root = mkdtempSync(join(tmpdir(), "vera-theme-lint-"));
    roots.push(root);
    const dir = join(root, "clients", "ui", "src");
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return themeViolations(root, ["clients/ui/src"]).map((violation) => violation.rule);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("@core the lint accepts a stylesheet that uses tokens only", () => {
    const rules = lint({
        "ok.css": [
            ".a {",
            "    color: var(--vera-text);",
            "    background: transparent;",
            "    font: inherit;",
            "    font-family: var(--vera-font-ui);",
            "    box-shadow: none;",
            "    box-shadow: var(--vera-shadow);",
            "    padding: calc(var(--vera-space) * 2);",
            "    border: thin solid var(--vera-border);",
            "    transition: background var(--vera-motion);",
            "}",
            "",
        ].join("\n"),
    });
    expect(rules).toEqual([]);
});

test("@core the lint flags literal colors, sizes, fonts, shadows and durations in a stylesheet", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
        ["color", ".a { color: #fff; }"],
        ["color", ".a { color: rgba(0, 0, 0, 0.5); }"],
        ["color", ".a { background: hsl(10 20% 30%); }"],
        ["color", ".a { border: thin solid red; }"],
        ["size", ".a { width: 12px; }"],
        ["size", ".a { padding: 0.5rem; }"],
        ["font", ".a { font-family: Menlo, monospace; }"],
        ["font", ".a { font: 12px Menlo; }"],
        ["shadow", ".a { box-shadow: 0 1px 2px black; }"],
        ["shadow", ".a { text-shadow: 0 1px black; }"],
        ["duration", ".a { transition: color 150ms; }"],
        ["duration", ".a { animation: spin 1s infinite; }"],
        ["duration", ".a {\n    transition-duration: 0.2s;\n}"],
        ["duration", ".a { transition-delay: 100ms; }"],
        ["unknown-token", ".a { color: var(--vera-nonsense); }"],
    ];
    for (const [expected, css] of cases) {
        expect({ css, rules: lint({ "case.css": css }) }).toEqual({
            css,
            rules: expect.arrayContaining([expected]),
        });
    }
});

test("@core the lint flags literal visual values in components", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
        ["color", "const a = <div style={{ color: \"#fff\" }} />;"],
        ["color", "const a = <div style={{ background: \"rgb(1, 2, 3)\" }} />;"],
        ["size", "const a = <div style={{ width: \"12px\" }} />;"],
        ["size", "const a = <div style={{ padding: 8 }} />;"],
        ["font", "const a = <div style={{ fontFamily: \"Menlo\" }} />;"],
        ["shadow", "const a = <div style={{ boxShadow: \"0 1px 2px\" }} />;"],
        ["color", "const a = <svg><path fill=\"#ffffff\" /></svg>;"],
        ["inline-style", "element.style.color = \"red\";"],
        ["inline-style", "element.style.cssText = value;"],
        ["inline-style", "element.setAttribute(\"style\", value);"],
    ];
    for (const [expected, source] of cases) {
        expect({ source, rules: lint({ "case.tsx": source }) }).toEqual({
            source,
            rules: expect.arrayContaining([expected]),
        });
    }
});

test("@core the lint allows runtime computed inline values and token references", () => {
    const rules = lint({
        "ok.tsx": [
            "const a = <div style={{ width: dragWidth }} />;",
            "const b = <path fill=\"currentColor\" stroke=\"none\" />;",
            "const c = <div style={{ color: \"var(--vera-text)\" }} />;",
            "",
        ].join("\n"),
    });
    expect(rules).toEqual([]);
});

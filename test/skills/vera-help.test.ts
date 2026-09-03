import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    bundledSkillDirectory,
    findSkill,
    loadSkillCatalog,
} from "../../src/skills/catalog.ts";

const root = mkdtempSync(join(tmpdir(), "vera-bundled-"));

const shipped = await loadSkillCatalog({
    projectRoot: join(root, "project"),
    userDirectory: join(root, "user"),
});

test("the guide ships as a skill, so any model can be asked how Vera works", () => {
    expect(shipped.warnings).toEqual([]);
    const help = findSkill(shipped, "vera-help");
    expect(help?.scope).toBe("system");
    expect(help?.directory).toBe(join(bundledSkillDirectory(), "vera-help"));
    expect(help?.instructions).toContain("llms.txt");
});

test("every counted section in the guide states its own line count", () => {
    const guide = readFileSync(
        join(bundledSkillDirectory(), "vera-help", "llms.txt"),
        "utf8",
    ).split("\n");
    const headers = guide
        .map((line, index) => ({ line, index }))
        .filter((entry) => entry.line.startsWith("## "));
    expect(headers.length).toBeGreaterThan(0);
    for (const [order, header] of headers.entries()) {
        const claimed = Number(/\[lines=(\d+)\]$/.exec(header.line)?.[1]);
        const next = headers[order + 1]?.index ?? guide.length - 1;
        expect([header.line, next - header.index - 1]).toEqual([
            header.line,
            claimed,
        ]);
    }
});

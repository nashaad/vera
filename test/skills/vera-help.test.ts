import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

test("no section header in the guide states a line count", () => {
    const guide = readFileSync(
        join(bundledSkillDirectory(), "vera-help", "llms.txt"),
        "utf8",
    ).split("\n");
    const headers = guide.filter((line) => line.startsWith("## "));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.filter((header) => header.includes("[lines="))).toEqual([]);
});

test("every manual page the guide names ships in docs/", () => {
    const skill = join(bundledSkillDirectory(), "vera-help");
    const guide = readFileSync(join(skill, "llms.txt"), "utf8");
    const pages = [...guide.matchAll(/`(docs\/[^`]+\.md)`/g)].map((match) => match[1]!);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
        expect([page, existsSync(join(skill, "..", "..", "..", "..", page))]).toEqual([page, true]);
    }
});

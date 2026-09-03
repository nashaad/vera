import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    findSkill,
    loadSkillCatalog,
    projectSkillDirectory,
} from "../../src/skills/catalog.ts";
import { SKILL_FILENAME } from "../../src/skills/package.ts";

test("catalog discovery reads immediate user and project skill packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const userDirectory = join(root, "user");
    const projectRoot = join(root, "project");
    writeSkill(userDirectory, "review", "user review");
    writeSkill(projectSkillDirectory(projectRoot), "consult", "project consult");
    writeFileSync(join(userDirectory, "loose.md"), "not a skill\n");

    const catalog = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        systemDirectory: join(root, "system"),
    });

    expect(catalog.skills.map((skill) => [
        skill.metadata.name,
        skill.scope,
    ])).toEqual([
        ["consult", "project"],
        ["review", "user"],
    ]);
    expect(catalog.warnings).toEqual([]);
});

test("a project skill overrides a user skill with the same name", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const userDirectory = join(root, "user");
    const projectRoot = join(root, "project");
    writeSkill(userDirectory, "review", "user review");
    writeSkill(projectSkillDirectory(projectRoot), "review", "project review");

    const catalog = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        systemDirectory: join(root, "system"),
    });

    expect(findSkill(catalog, "review")?.metadata.description).toBe(
        "project review",
    );
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("overrides");
});

test("invalid packages become warnings without hiding valid skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const userDirectory = join(root, "user");
    const projectRoot = join(root, "project");
    writeSkill(userDirectory, "valid", "works");
    const invalid = join(userDirectory, "invalid");
    mkdirSync(invalid);
    writeFileSync(join(invalid, SKILL_FILENAME), "missing frontmatter\n");

    const catalog = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        systemDirectory: join(root, "system"),
    });

    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([
        "valid",
    ]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain("must begin with YAML frontmatter");
});

function writeSkill(root: string, name: string, description: string): void {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, SKILL_FILENAME), `---
name: ${name}
description: ${description}
---
# ${name}
`);
}

test("the only skill Vera ships is the guide to itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory: join(root, "user"),
    });

    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([
        "vera-help",
    ]);
});

test("copyable example skills are valid opt-in packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory: join(root, "user"),
        systemDirectory: join(import.meta.dir, "../../examples/skills"),
    });

    expect(catalog.warnings).toEqual([]);
    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([
        "browser-research",
        "consult",
    ]);
});

test("catalog discovery follows a symlinked skill directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const canonical = join(root, "canonical");
    writeSkill(canonical, "review", "user review");
    const userDirectory = join(root, "user");
    mkdirSync(userDirectory, { recursive: true });
    symlinkSync(join(canonical, "review"), join(userDirectory, "review"));

    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory,
        systemDirectory: join(root, "system"),
    });

    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([
        "review",
    ]);
    expect(catalog.warnings).toEqual([]);
});

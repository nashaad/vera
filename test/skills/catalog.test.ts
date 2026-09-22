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

test("bundled skills include guidance and explicit authoring", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory: join(root, "user"),
    });

    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([
        "create-agent",
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
        "consult",
        "wireframe",
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

test("disabled skills leave the catalog and are listed separately", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const userDirectory = join(root, "user");
    writeSkill(userDirectory, "review", "user review");
    writeSkill(userDirectory, "data-clean", "clean");
    writeSkill(userDirectory, "data-plot", "plot");

    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory,
        systemDirectory: join(root, "system"),
        disabledSkills: ["review", "data-*"],
        extensionRoots: [],
    });

    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([]);
    expect(catalog.disabledSkills.map((skill) => skill.metadata.name)).toEqual([
        "data-clean",
        "data-plot",
        "review",
    ]);
});

test("a lone star disables every skill including bundled ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory: join(root, "user"),
        disabledSkills: ["*"],
        extensionRoots: [],
    });

    expect(catalog.skills).toEqual([]);
    expect(catalog.disabledSkills.map((skill) => skill.metadata.name)).toEqual([
        "create-agent",
        "vera-help",
    ]);
});

test("extension skills sit between bundled and user skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const systemDirectory = join(root, "system");
    const extensionDirectory = join(root, "extension");
    const userDirectory = join(root, "user");
    const projectRoot = join(root, "project");
    writeSkill(systemDirectory, "analyze", "bundled analyze");
    writeSkill(extensionDirectory, "analyze", "extension analyze");
    writeSkill(extensionDirectory, "plot", "extension plot");
    writeSkill(systemDirectory, "plot", "bundled plot");
    writeSkill(userDirectory, "plot", "user plot");
    writeSkill(extensionDirectory, "notebook", "extension notebook");
    writeSkill(projectSkillDirectory(projectRoot), "notebook", "project notebook");

    const catalog = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        systemDirectory,
        disabledSkills: [],
        extensionRoots: [{ extensionId: "vera.kernel", path: extensionDirectory }],
    });

    const byName = new Map(catalog.skills.map((skill) => [skill.metadata.name, skill]));
    expect(byName.get("analyze")?.scope).toBe("extension");
    expect(byName.get("analyze")?.extensionId).toBe("vera.kernel");
    expect(byName.get("analyze")?.metadata.description).toBe("extension analyze");
    expect(byName.get("plot")?.scope).toBe("user");
    expect(byName.get("notebook")?.scope).toBe("project");
});

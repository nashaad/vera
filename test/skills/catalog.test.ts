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
    findDisabledSkillByPath,
    findSkill,
    findSkillByPath,
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

test("a disabled skill is found by path only through the disabled lookup", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const userDirectory = join(root, "user");
    writeSkill(userDirectory, "review", "user review");
    writeSkill(userDirectory, "deploy", "ship it");

    const catalog = await loadSkillCatalog({
        projectRoot: join(root, "project"),
        userDirectory,
        systemDirectory: join(root, "system"),
        disabledSkills: ["deploy"],
        extensionRoots: [],
    });
    const deploy = catalog.disabledSkills[0];

    expect(deploy?.metadata.name).toBe("deploy");
    expect(findSkillByPath(catalog, deploy!.skillPath)).toBeUndefined();
    expect(findDisabledSkillByPath(catalog, deploy!.skillPath)).toBe(deploy);
    const review = findSkill(catalog, "review");
    expect(findDisabledSkillByPath(catalog, review!.skillPath)).toBeUndefined();
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

test("a project's disabled_skills adds to the home list and covers every source", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const projectRoot = join(root, "project");
    const userDirectory = join(root, "user");
    writeSkill(userDirectory, "review", "user review");
    writeSkill(userDirectory, "deploy", "ship it");
    writeSkill(projectSkillDirectory(projectRoot), "plunder", "count the hoard");
    writeFileSync(
        join(projectRoot, ".vera", "config.json"),
        JSON.stringify({ disabled_skills: ["deploy", "vera-*"], inbox: { admit: [] } }),
    );

    const catalog = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        disabledSkills: ["review"],
        extensionRoots: [],
    });

    expect(catalog.skills.map((skill) => skill.metadata.name)).toEqual([
        "create-agent",
        "plunder",
    ]);
    expect(catalog.disabledSkills.map((skill) => skill.metadata.name)).toEqual([
        "deploy",
        "review",
        "vera-help",
    ]);
    expect(catalog.warnings).toEqual([]);
});

test("an invalid project disabled_skills is ignored with a warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-skills-"));
    const projectRoot = join(root, "project");
    const userDirectory = join(root, "user");
    writeSkill(userDirectory, "review", "user review");
    writeSkill(userDirectory, "crow-call", "caw");
    mkdirSync(join(projectRoot, ".vera"), { recursive: true });
    const configPath = join(projectRoot, ".vera", "config.json");
    writeFileSync(configPath, JSON.stringify({ disabled_skills: ["cr*w"] }));

    const invalid = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        systemDirectory: join(root, "system"),
        disabledSkills: ["review"],
        extensionRoots: [],
    });

    expect(invalid.skills.map((skill) => skill.metadata.name)).toEqual(["crow-call"]);
    expect(invalid.disabledSkills.map((skill) => skill.metadata.name)).toEqual(["review"]);
    expect(invalid.warnings).toEqual([
        `disabled_skills in ${configPath} is not a valid list and was ignored`,
    ]);

    writeFileSync(configPath, "{ not json");
    const unreadable = await loadSkillCatalog({
        projectRoot,
        userDirectory,
        systemDirectory: join(root, "system"),
        disabledSkills: ["review"],
        extensionRoots: [],
    });

    expect(unreadable.disabledSkills.map((skill) => skill.metadata.name)).toEqual(["review"]);
    expect(unreadable.warnings).toHaveLength(1);
    expect(unreadable.warnings[0]).toStartWith(`${configPath} could not be read: `);
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

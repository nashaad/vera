import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findCatalogAgent, loadAgentCatalog } from "../../src/agents/catalog.ts";
import { bundledSkillDirectory, findSkill, loadSkillCatalog } from "../../src/skills/catalog.ts";
import { invocationRefusal } from "../../src/skills/invocation-gate.ts";
import { skillScriptTool } from "../../src/skills/script.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const root = await mkdtemp(join(tmpdir(), "vera-create-agent-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const valid = `---
description: Find decisions in supplied meeting notes.
tools: [read, grep, list]
skills: []
posture: readonly
forbidden_access: [auto, full_access]
subagent_assignment: eco
---
Read supplied meeting notes and cite explicit decisions. Do not change files.
`;

test("the bundled authoring skill requires an explicit top-level invocation", async () => {
    const catalog = await loadSkillCatalog({
        projectRoot: root,
        userDirectory: join(root, "skills"),
    });
    const skill = findSkill(catalog, "create-agent");
    expect(catalog.warnings).toEqual([]);
    expect(skill?.scope).toBe("system");
    expect(skill?.metadata.disableModelInvocation).toBe(true);
    if (skill === undefined) throw new Error("Missing create-agent skill");
    expect(invocationRefusal(skill.metadata, false)).toBeDefined();
    expect(invocationRefusal(skill.metadata, true, "create-agent")).toBeDefined();
    expect(invocationRefusal(skill.metadata, false, "create-agent")).toBeUndefined();
});

test("the declared validator accepts a loadable definition without changing it", async () => {
    const path = join(root, "meeting-reader.md");
    await writeFile(path, valid);
    const runtime = new ToolRuntime(root);
    runtime.userInvokedSkill = "create-agent";
    const result = await skillScriptTool.execute({
        skill: "create-agent",
        script: "scripts/validate.sh",
        args: [path],
    }, runtime, new AbortController().signal);

    expect(result.kind).toBe("output");
    if (result.kind !== "output") throw new Error("Expected validation output");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
        name: "meeting-reader",
        tools: ["read", "grep", "list"],
        skills: [],
        subagentAssignment: "eco",
    });
    expect(await readFile(path, "utf8")).toBe(valid);
    const catalog = await loadAgentCatalog({
        projectRoot: root,
        projectDirectory: root,
        userDirectory: join(root, "agents"),
        permissionModes: ["readonly", "ask", "auto", "full_access"],
    });
    expect(catalog.notices).toEqual([]);
    expect(findCatalogAgent(catalog, "meeting-reader")?.definition)
        .toMatchObject({ name: "meeting-reader", subagentAssignment: "eco" });
});

test.each([
    ["wrong-field.md", valid.replace("subagent_assignment:", "assignment:"), "unknown key"],
    ["Wrong_Name.md", valid, "must be lowercase"],
    ["invalid-posture.md", valid.replace("posture: readonly", "posture: factual"), "no permission mode named factual"],
    ["invalid-forbidden.md", valid.replace("[auto, full_access]", "[invented]"), "no permission mode named invented"],
    ["no-description.md", valid.replace("description: Find decisions in supplied meeting notes.\n", ""), "description and instructions"],
    ["empty-body.md", valid.slice(0, valid.lastIndexOf("---") + 3), "description and instructions"],
] as const)("validation refuses %s", async (filename, source, message) => {
    const path = join(root, filename);
    await writeFile(path, source);
    const runtime = new ToolRuntime(root);
    runtime.userInvokedSkill = "create-agent";
    const result = await skillScriptTool.execute({
        skill: "create-agent",
        script: "scripts/validate.sh",
        args: [path],
    }, runtime, new AbortController().signal);
    expect(result.kind).toBe("output");
    if (result.kind !== "output") throw new Error("Expected validation output");
    expect(result.isError).toBe(true);
    expect(result.output).toContain(message);
    expect(await readFile(path, "utf8")).toBe(source);
});

test("a packaged validator uses the bundled runtime without a system installation", async () => {
    const release = join(root, "release with spaces");
    const skillDirectory = join(release, "src/skills/bundled/create-agent");
    const definitionsDirectory = join(release, "src/agents");
    await cp(join(bundledSkillDirectory(), "create-agent"), skillDirectory, {
        recursive: true,
    });
    await mkdir(definitionsDirectory, { recursive: true });
    await cp(join(import.meta.dir, "../../src/agents/definition.ts"),
        join(definitionsDirectory, "definition.ts"));
    await symlink(process.execPath, join(release, "bun"));
    const path = join(release, "meeting-reader.md");
    await writeFile(path, valid);

    const result = Bun.spawnSync([join(skillDirectory, "scripts/validate.sh"), path], {
        env: { PATH: "/usr/bin:/bin", VERA_SKILL_DIR: skillDirectory },
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).name).toBe("meeting-reader");
});

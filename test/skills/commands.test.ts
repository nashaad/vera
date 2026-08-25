import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decideSkillInvocation,
    loadSkillCommandCatalog,
} from "../../src/skills/commands.ts";
import { projectSkillDirectory } from "../../src/skills/catalog.ts";

test("the command catalog applies the active agent's skill allow-list", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-skill-commands-"));
    for (const name of ["deploy", "inspect"]) {
        const directory = join(projectSkillDirectory(workspace), name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), `---
name: ${name}
description: ${name} things.
${name === "deploy" ? "disable-model-invocation: true\n" : ""}---
Body.
`);
    }

    const catalog = await loadSkillCommandCatalog({
        projectRoot: workspace,
        allowedSkills: ["deploy"],
    });
    expect(catalog.skills).toEqual([{
        name: "deploy",
        description: "deploy things.",
        disableModelInvocation: true,
    }]);

    await expect(decideSkillInvocation({
        projectRoot: workspace,
        name: "deploy",
        allowedSkills: ["deploy"],
        isSubagent: false,
    })).resolves.toEqual({ allowed: true });
    await expect(decideSkillInvocation({
        projectRoot: workspace,
        name: "inspect",
        allowedSkills: ["deploy"],
        isSubagent: false,
    })).resolves.toEqual({
        allowed: false,
        reason: "No skill named inspect is available to this agent.",
    });
});

test("child sessions cannot invoke user slash commands", async () => {
    await expect(decideSkillInvocation({
        projectRoot: "/missing",
        name: "deploy",
        isSubagent: true,
    })).resolves.toEqual({
        allowed: false,
        reason: "Skill slash commands are available only in top-level sessions.",
    });
});

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import {
    agentNameFromPath,
    parseAgentDefinition,
} from "../../../../agents/definition.ts";
import type { BuiltInPermissionModeName } from "../../../../sdk/permissions.ts";

const permissionModes: readonly BuiltInPermissionModeName[] = [
    "readonly", "ask", "auto", "full_access",
];

try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || extname(args[0]!) !== ".md") {
        throw new Error("Expected one definition path ending in .md");
    }
    const path = resolve(args[0]!);
    const source = await readFile(path, "utf8");
    const definition = parseAgentDefinition(agentNameFromPath(path), source, {
        permissionModes,
        interactive: true,
    });
    if (definition.description === undefined || definition.instructions.length === 0) {
        throw new Error("Provide both a description and instructions");
    }
    console.log(JSON.stringify({
        path,
        name: definition.name,
        description: definition.description,
        tools: definition.tools ?? "all available",
        skills: definition.skills ?? "all available",
        posture: definition.posture ?? "session posture",
        subagentAssignment: definition.subagentAssignment ?? "subagents",
        validation: "Definition syntax and built-in permission modes are valid. Availability and trial are separate checks.",
    }, null, 2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCatalog } from "../agents/catalog.ts";
import { loadSkillCatalog, type CatalogSkill } from "../skills/catalog.ts";
import { loadProjectInstructions } from "../engine/project-instructions.ts";
import { loadMemory, MEMORY_ENABLED, type InstructionRoot } from "../engine/memory.ts";
import { listExtensions } from "../extensions/manager.ts";
import { loadOptionalVeraConfig } from "../config.ts";
import { includedExtensions } from "../extensions/included.ts";
import { loadExtensionManifest } from "../extensions/manifest.ts";
import type { CustomizationCatalog, CustomizationSource } from "./types.ts";

const MAX_PREVIEW_BYTES = 256 * 1024;

function isIncluded(scope: string): boolean {
    return scope === "included" || scope === "core";
}

function skillScopeLabel(skill: CatalogSkill): string {
    return skill.extensionId === undefined ? skill.scope : `extension ${skill.extensionId}`;
}

export async function loadCustomizationCatalog(options: {
    readonly workspace: string;
    readonly instructionRoot: InstructionRoot;
    readonly agents: AgentCatalog;
}): Promise<CustomizationCatalog> {
    const sources: CustomizationSource[] = [];
    const warnings: string[] = [...options.agents.notices];
    async function add(source: CustomizationSource): Promise<void> {
        if (source.path === undefined) {
            sources.push(source);
            return;
        }
        try {
            const info = await stat(source.path);
            if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) {
                throw new Error("Preview requires a regular file under 256 KiB");
            }
            const content = await readFile(source.path, "utf8");
            if (Buffer.byteLength(content) > MAX_PREVIEW_BYTES) {
                throw new Error("File grew beyond the preview limit");
            }
            sources.push({ ...source, content });
        } catch (error) {
            sources.push({ ...source, content: String(error), editable: false, status: "unreadable" });
        }
    }
    for (const row of options.agents.agents) {
        await add({
            id: `agents:${row.definition.name}`, category: "agents",
            name: row.definition.name, description: row.definition.description ?? "",
            scope: row.scope, path: row.path, editable: row.writable,
            content: JSON.stringify({ ...row.definition, instructions: undefined }, null, 4)
                + "\n\n" + row.definition.instructions,
            contextIds: [`agent:${row.definition.name}`],
        });
    }
    const skills = await loadSkillCatalog({ projectRoot: options.workspace });
    warnings.push(...skills.warnings);
    for (const row of skills.skills) {
        await add({
            id: `skills:${row.metadata.name}`, category: "skills",
            name: row.metadata.name, description: row.metadata.description,
            scope: skillScopeLabel(row), path: row.skillPath, editable: row.scope === "user" || row.scope === "project",
            content: row.instructions, contextIds: [row.skillPath],
            status: row.metadata.disableModelInvocation ? "explicit invocation only" : "available",
        });
    }
    for (const row of skills.disabledSkills) {
        await add({
            id: `skills:${row.metadata.name}`, category: "skills",
            name: row.metadata.name, description: row.metadata.description,
            scope: skillScopeLabel(row), path: row.skillPath, editable: row.scope === "user" || row.scope === "project",
            content: row.instructions, contextIds: [],
            status: "disabled",
        });
    }
    const instructions = await loadProjectInstructions(options.workspace);
    warnings.push(...instructions.warnings);
    for (const file of instructions.files) {
        await add({
            id: `instructions:${file.path}`, category: "instructions",
            name: file.name, description: "Project instructions and imports",
            scope: "project", path: file.path, editable: true,
            content: file.content, contextIds: [file.path],
        });
    }
    const memory = await loadMemory(options.instructionRoot);
    warnings.push(...memory.warnings);
    for (const file of memory.files) {
        for (const item of [
            { path: file.path, name: "MEMORY.md", contextIds: [file.path] },
            ...file.topics.filter((topic) => topic.availability === "available" || topic.availability === "stale").map((topic) => ({
                path: topic.path, name: topic.title ?? topic.file,
                contextIds: [`${topic.scope}:${topic.file}`],
            })),
        ]) {
            await add({
                id: `memory:${item.path}`, category: "memory", name: item.name,
                description: "Saved memory", scope: file.scope, path: item.path,
                content: "", editable: true, contextIds: item.contextIds,
                status: MEMORY_ENABLED ? "available" : "memory loading disabled",
            });
        }
    }
    const config = loadOptionalVeraConfig();
    const disabled = config?.disabled_included_extensions ?? [];
    const entries: { path: string; enabled: boolean; scope: string; id: string }[] = listExtensions().map((row) => ({
        path: row.path, enabled: row.enabled, scope: "user", id: row.id,
    }));
    const paths = new Set(entries.map((row) => row.path));
    for (const row of [
        ...(config?.extensions ?? []).map((value) => ({ ...value, scope: "user" })),
        ...includedExtensions().map((value) => ({ path: value.path, enabled: true, scope: value.core ? "core" : "included" })),
    ]) {
        if (paths.has(row.path)) continue;
        paths.add(row.path);
        try {
            const { manifest } = loadExtensionManifest(row.path);
            entries.push({
                path: row.path,
                enabled: row.enabled && (!isIncluded(row.scope) || !disabled.includes(manifest.id)),
                scope: row.scope,
                id: manifest.id,
            });
        } catch (error) { warnings.push(String(error)); }
    }
    const explicitIds = new Set(entries.filter((row) => !isIncluded(row.scope)).map((row) => row.id));
    for (const row of entries) {
        await add({
            id: `extensions:${row.scope}:${row.id}`, category: "extensions",
            name: row.id, description: "Extension manifest", scope: row.scope,
            path: join(row.path, "vera.extension.json"), content: "",
            editable: !isIncluded(row.scope), contextIds: [],
            status: isIncluded(row.scope) && explicitIds.has(row.id)
                ? "shadowed"
                : row.enabled ? "enabled" : "disabled",
        });
    }
    return { sources, warnings };
}

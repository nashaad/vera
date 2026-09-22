import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentCatalog } from "../../src/agents/catalog.ts";
import { loadCustomizationCatalog } from "../../src/customize/catalog.ts";

const originalHome = process.env.VERA_HOME;
const roots: string[] = [];
afterEach(async () => {
    if (originalHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = originalHome;
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("catalog uses winning definitions, keeps source bodies, and reports invalid files", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-")); roots.push(root);
    const home = join(root, "home"); const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(join(home, "agents"), { recursive: true });
    await mkdir(join(workspace, ".vera/agents"), { recursive: true });
    await writeFile(join(home, "agents/reader.md"), "---\ndescription: User reader\n---\nUser instructions\n");
    const path = join(workspace, ".vera/agents/reader.md");
    await writeFile(path, "---\ndescription: Project reader\nposture: readonly\n---\nProject instructions\n");
    await writeFile(join(workspace, ".vera/agents/broken.md"), "---\nposture: invented\n---\nBody\n");
    await writeFile(join(workspace, "AGENTS.md"), "Instructions for this project\n");
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    const reader = catalog.sources.find((source) => source.name === "reader");
    expect(reader?.scope).toBe("project");
    expect(reader?.path).toBe(path);
    expect(reader?.content).toContain("Project instructions");
    expect(catalog.sources.filter((source) => source.name === "reader")).toHaveLength(1);
    expect(catalog.sources.some((source) => source.name === "broken")).toBe(false);
    expect(catalog.warnings.join("\n")).toContain("broken");
    expect(catalog.sources.find((source) => source.name === "AGENTS.md")?.editable).toBe(true);
    expect(catalog.sources.find((source) => source.name === "vera-help")?.editable).toBe(false);
});

test("included extension status respects explicit copies and disabled IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-batteries-")); roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await cp(join(import.meta.dir, "../../extensions/btw"), join(home, "btw"), { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        disabled_included_extensions: ["vera.btw", "vera.command-hooks"],
        extensions: [
            { path: join(import.meta.dir, "../../extensions/diff"), enabled: false },
            { path: join(home, "btw"), enabled: true },
        ],
    }));
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    const extensions = catalog.sources.filter((source) => source.category === "extensions");
    expect(extensions.filter((source) => source.name === "vera.diff"))
        .toMatchObject([{ scope: "user", status: "disabled" }]);
    expect(extensions.find((source) => source.name === "vera.command-hooks"))
        .toMatchObject({ scope: "core", status: "disabled" });
    expect(extensions.find((source) => source.name === "vera.btw" && source.scope === "user"))
        .toMatchObject({ status: "enabled" });
    expect(extensions.find((source) => source.name === "vera.btw" && source.scope === "included"))
        .toMatchObject({ status: "shadowed" });
});


for (const mode of ["included", "disabled-builtin", "override", "disabled-copy"] as const) {
    test(`Context catalog reports ${mode}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "customize-context-")); roots.push(root);
        const home = join(root, "home");
        const workspace = join(root, "project");
        process.env.VERA_HOME = home;
        await mkdir(home, { recursive: true });
        await mkdir(workspace, { recursive: true });
        await cp(join(import.meta.dir, "../../src/core-extensions/context"), join(home, "context"), { recursive: true });
        const explicit = mode === "override" || mode === "disabled-copy";
        await writeFile(join(home, "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "faux/test",
            disabled_included_extensions: mode === "disabled-builtin" ? ["vera.context"] : [],
            extensions: explicit ? [{
                path: join(home, "context"),
                enabled: mode === "override",
            }] : [],
        }));
        const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
        const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
        const entries = catalog.sources.filter((source) => source.name === "vera.context");
        expect(entries.find((source) => source.scope === "core"))
            .toMatchObject({ status: explicit ? "shadowed" : mode === "included" ? "enabled" : "disabled" });
        if (explicit) expect(entries.find((source) => source.scope === "user"))
            .toMatchObject({ status: mode === "override" ? "enabled" : "disabled" });
    });
}

test("skills turned off by disabled_skills still appear, marked disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-skills-")); roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(workspace, { recursive: true });
    await mkdir(join(home, "skills/review"), { recursive: true });
    await writeFile(join(home, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nBody\n");
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        disabled_skills: ["review", "vera-*"],
    }));
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    const skills = catalog.sources.filter((source) => source.category === "skills");
    expect(skills.find((source) => source.name === "review")?.status).toBe("disabled");
    expect(skills.find((source) => source.name === "vera-help")?.status).toBe("disabled");
    expect(skills.find((source) => source.name === "create-agent")?.status).not.toBe("disabled");
});

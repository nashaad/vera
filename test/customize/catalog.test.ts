import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentCatalog } from "../../src/agents/catalog.ts";
import { loadCustomizationCatalog } from "../../src/customize/catalog.ts";
import { includedExtensionIds } from "../../src/extensions/included.ts";
import { installPlugin, setPluginEnabled } from "../../src/plugins/manager.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { parseSources } from "../../clients/ui/src/customize/wire.ts";

const originalHome = process.env.VERA_HOME;
const roots: string[] = [];
afterEach(async () => {
    if (originalHome === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
    else process.env.VERA_HOME = originalHome;
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("@core plugin skills and agents keep their plugin name in the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-plugin-")); roots.push(root);
    const home = join(root, "home"); const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(workspace, { recursive: true });
    const source = join(root, "plugin-source");
    await mkdir(join(source, "skills", "plunder"), { recursive: true });
    await mkdir(join(source, "dev.vera", "agents"), { recursive: true });
    await writeFile(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name: "fixture-plugin",
        version: "1.0.0",
    }));
    await writeFile(
        join(source, "skills", "plunder", "SKILL.md"),
        "---\nname: plunder\ndescription: Takes the cargo\n---\nPlunder the hold.\n",
    );
    await writeFile(
        join(source, "dev.vera", "agents", "plugin-agent.md"),
        "---\ndescription: Sails with the plugin\n---\nSail with the plugin.\n",
    );
    installPlugin(source);

    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });

    expect(catalog.sources).toContainEqual(expect.objectContaining({
        id: "plugins:fixture-plugin",
        category: "plugins",
        scope: "plugin",
        plugin: "fixture-plugin",
        status: "enabled",
        path: join(home, "plugins", "fixture-plugin"),
        editable: false,
    }));
    const firstAgent = agents.agents[0]!;
    const crowdedAgents = {
        ...agents,
        agents: Array.from({ length: 500 }, (_, index) => ({
            ...firstAgent,
            path: undefined,
            definition: { ...firstAgent.definition, name: `crow-${index}` },
        })),
    };
    const crowded = await loadCustomizationCatalog({ workspace, agents: crowdedAgents });
    expect(parseSources(crowded.sources).some((item) => item.id === "plugins:fixture-plugin")).toBe(true);
    setPluginEnabled("fixture-plugin", false);
    const disabledCatalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    expect(disabledCatalog.sources.find((source) => source.id === "plugins:fixture-plugin")).toMatchObject({
        path: join(home, "plugins", "fixture-plugin"),
        status: "disabled",
    });
    expect(catalog.sources).toContainEqual(expect.objectContaining({
        id: "skills:plunder",
        category: "skills",
        scope: "plugin fixture-plugin",
        plugin: "fixture-plugin",
        editable: false,
    }));
    expect(catalog.sources).toContainEqual(expect.objectContaining({
        id: "agents:plugin-agent",
        category: "agents",
        scope: "plugin",
        plugin: "fixture-plugin",
        editable: false,
    }));
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

async function writeExtension(directory: string, id: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "vera.extension.json"), JSON.stringify({
        id, version: "1.0.0", sdk: "1", entrypoint: "./extension.ts", capabilities: [],
    }));
    await writeFile(join(directory, "extension.ts"), "export default {};\n");
}

test("@core the Customize plugin row shows a different host extension id", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-plugin-id-")); roots.push(root);
    process.env.VERA_HOME = join(root, "home");
    const source = join(root, "extension");
    await writeExtension(source, "crow_bridge");
    installPlugin(source);

    const agents = await loadAgentCatalog({ permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ agents });
    const plugin = catalog.sources.find((item) => item.id === "plugins:crow-bridge");
    expect(plugin).toMatchObject({
        name: "crow-bridge",
        plugin: "crow-bridge",
        description: "skills:0 agents:0 mcp:0 host:crow_bridge",
    });
});

test("@core included and core extensions are not listed, installed and configured ones are", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-batteries-")); roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(workspace, { recursive: true });
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const load = () => loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    const extensionRows = (catalog: Awaited<ReturnType<typeof load>>) => catalog.sources.filter((source) => source.category === "extensions");

    await mkdir(home, { recursive: true });
    expect(extensionRows(await load())).toEqual([]);

    await writeExtension(join(home, "extensions", "acme.crow"), "acme.crow");
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        disabled_included_extensions: ["vera.command-hooks"],
        extensions: [{ path: join(import.meta.dir, "../../extensions/diff"), enabled: false }],
    }));
    const rows = extensionRows(await load());
    expect(rows.map((source) => [source.name, source.scope, source.status, source.editable]).sort())
        .toEqual([["acme.crow", "user", "enabled", true], ["vera.diff", "user", "disabled", true]]);
    expect(rows.some((source) => source.scope === "included" || source.scope === "core")).toBe(false);
    for (const id of includedExtensionIds().filter((id) => id !== "vera.diff")) {
        expect(rows.some((source) => source.name === id)).toBe(false);
    }
});

test("a copy of an included extension in the home is listed once, as the user's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-copy-")); roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(workspace, { recursive: true });
    await cp(join(import.meta.dir, "../../extensions/btw"), join(home, "btw"), { recursive: true });
    await cp(join(import.meta.dir, "../../src/core-extensions/context"), join(home, "context"), { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        disabled_included_extensions: ["vera.btw", "vera.context"],
        extensions: [
            { path: join(home, "btw"), enabled: true },
            { path: join(home, "context"), enabled: false },
        ],
    }));
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    const extensions = catalog.sources.filter((source) => source.category === "extensions");
    expect(extensions.map((source) => [source.name, source.scope, source.status]).sort())
        .toEqual([["vera.btw", "user", "enabled"], ["vera.context", "user", "disabled"]]);
});

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

test("a broken config.json keeps skills and configured extensions on their last settings with one warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-broken-")); roots.push(root);
    const home = join(root, "home");
    const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(workspace, { recursive: true });
    await mkdir(join(home, "skills/plunder"), { recursive: true });
    await writeFile(join(home, "skills/plunder/SKILL.md"), "---\nname: plunder\ndescription: Take the loot\n---\nBody\n");
    await writeExtension(join(home, "crow"), "acme.crow");
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        disabled_skills: ["plunder"],
        extensions: [{ path: join(home, "crow"), enabled: false }],
    }));
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    await writeFile(join(home, "config.json"), "{ not json");

    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });

    expect(catalog.sources.find((source) => source.name === "plunder")?.status).toBe("disabled");
    expect(catalog.sources.find((source) => source.name === "acme.crow")?.status).toBe("disabled");
    const notices = catalog.warnings.filter((warning) => warning.startsWith("config.json could not be read:"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEndWith(". Skills use the last settings that loaded.");
});

test("catalog lists home and project rules as instructions keyed by their loaded path", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-rules-")); roots.push(root);
    const home = join(root, "home"); const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(join(home, "rules"), { recursive: true });
    await mkdir(join(workspace, ".vera/rules"), { recursive: true });
    const global = join(home, "rules/global.md");
    await writeFile(global, "Keep the parrot off the rigging.\n");
    await writeFile(join(workspace, ".vera/rules/tui.md"), "---\npaths:\n  - \"clients/tui/**\"\n---\nCrow's nest rules.\n");
    const agents = await loadAgentCatalog({ projectRoot: workspace, permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ workspace, instructionRoot: { path: root, source: "git" }, agents });
    const user = catalog.sources.find((source) => source.name === "<home>/rules/global.md");
    expect(user?.category).toBe("instructions");
    expect(user?.scope).toBe("user");
    expect(user?.contextIds).toEqual([global]);
    expect(user?.content).toContain("parrot");
    expect(user?.description).toBe("User rule, always on");
    const project = catalog.sources.find((source) => source.name === ".vera/rules/tui.md");
    expect(project?.scope).toBe("project");
    expect(project?.description).toBe("Project rule for clients/tui/**");
});

test("@core without a workspace only what the home holds is listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-chat-")); roots.push(root);
    const home = join(root, "home");
    process.env.VERA_HOME = home;
    await mkdir(join(home, "agents"), { recursive: true });
    await mkdir(join(home, "skills/mast-watch"), { recursive: true });
    await writeFile(join(home, "agents/reader.md"), "---\ndescription: User reader\n---\nUser instructions\n");
    await writeFile(join(home, "skills/mast-watch/SKILL.md"), "---\nname: mast-watch\ndescription: Looks from the mast.\n---\nBody.\n");
    await mkdir(join(home, "rules"), { recursive: true });
    await writeFile(join(home, "rules/global.md"), "Keep the parrot off the rigging.\n");
    await mkdir(join(home, "memory/user"), { recursive: true });
    await writeFile(join(home, "memory/user/MEMORY.md"), "- [Biscuits](biscuits.md): where the crow hides them\n");
    await writeFile(join(home, "memory/user/biscuits.md"), "Under the third plank of the crow's nest.\n");
    const agents = await loadAgentCatalog({ permissionModes: ["readonly"], interactive: true });
    const catalog = await loadCustomizationCatalog({ agents });
    expect(catalog.sources.find((source) => source.name === "reader")?.scope).toBe("user");
    expect(catalog.sources.find((source) => source.name === "mast-watch")?.scope).toBe("user");
    expect(catalog.sources.find((source) => source.name === "<home>/rules/global.md")).toMatchObject({ category: "instructions", scope: "user" });
    expect(catalog.sources.find((source) => source.category === "memory")).toMatchObject({ name: "MEMORY.md", scope: "user" });
    expect(catalog.sources.some((source) => source.scope === "project")).toBe(false);
    expect(catalog.warnings).toEqual([]);
});

test("@core the home AGENTS.md is listed as user instructions, with or without a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "customize-home-agents-")); roots.push(root);
    const home = join(root, "home"); const workspace = join(root, "project");
    process.env.VERA_HOME = home;
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(home, "AGENTS.md"), "Call me Captain.\n");
    await writeFile(join(home, "AGENTS.local.md"), "Never listed.\n");
    await writeFile(join(workspace, "AGENTS.md"), "Project charter.\n");
    for (const options of [{}, { workspace }]) {
        const agents = await loadAgentCatalog({ permissionModes: ["readonly"], interactive: true });
        const catalog = await loadCustomizationCatalog({ ...options, agents });
        const homeRows = catalog.sources.filter((source) => source.name.startsWith("<home>/AGENTS"));
        expect(homeRows).toEqual([expect.objectContaining({
            category: "instructions",
            name: "<home>/AGENTS.md",
            description: "User instructions and imports",
            scope: "user",
            editable: true,
            content: "Call me Captain.\n",
        })]);
    }
});

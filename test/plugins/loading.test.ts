import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentCatalog } from "../../src/agents/catalog.ts";
import { readPluginCatalog } from "../../src/plugins/catalog.ts";
import {
    installPlugin,
    setPluginEnabled,
} from "../../src/plugins/manager.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { loadSkillCatalog } from "../../src/skills/catalog.ts";
import { SKILL_FILENAME } from "../../src/skills/package.ts";
import { pluginDirectoryIn } from "../../src/profile-paths.ts";

interface TestHome {
    readonly root: string;
    readonly home: string;
    readonly veraHome: string;
}

function temporaryHome(): TestHome {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-loading-"));
    const home = join(root, "home");
    return { root, home, veraHome: join(home, ".vera") };
}

function writeSkill(
    directory: string,
    name: string,
    description: string,
): void {
    const packageDirectory = join(directory, name);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
        join(packageDirectory, SKILL_FILENAME),
        `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
    );
}

function writeAgent(
    directory: string,
    name: string,
    description: string,
): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, `${name}.md`),
        `---\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`,
    );
}

function writeManifest(source: string, name = "sample-plugin"): void {
    writeFileSync(join(source, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA,
        name,
        version: "1.0.0",
    }));
}

test("skills win in scope order: project, user, plugin, extension, system", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-precedence-"));
    try {
        const system = join(root, "system");
        const extension = join(root, "extension");
        const plugin = join(root, "plugin");
        const user = join(root, "user");
        const project = join(root, "project");
        writeSkill(system, "shared", "system copy");
        writeSkill(extension, "shared", "extension copy");
        writeSkill(plugin, "shared", "plugin copy");
        writeSkill(user, "shared", "user copy");
        writeSkill(join(project, ".vera", "skills"), "shared", "project copy");
        writeSkill(plugin, "plugin-only", "plugin only");

        const catalog = await loadSkillCatalog({
            projectRoot: project,
            systemDirectory: system,
            userDirectory: user,
            disabledSkills: [],
            extensionRoots: [{ extensionId: "acme.kernel", path: extension }],
            pluginRoots: [{ plugin: "sample-plugin", path: plugin }],
        });

        expect(catalog.skills.map((skill) => [
            skill.metadata.name,
            skill.metadata.description,
            skill.scope,
        ])).toEqual([
            ["plugin-only", "plugin only", "plugin"],
            ["shared", "project copy", "project"],
        ]);
        expect(catalog.skills.find((skill) => skill.metadata.name === "plugin-only")?.plugin)
            .toBe("sample-plugin");
        expect(catalog.warnings).toHaveLength(2);
        expect(catalog.pluginWarnings).toHaveLength(2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("disabled_skills turns off a plugin skill and still lists it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-disabled-"));
    try {
        const plugin = join(root, "plugin");
        writeSkill(plugin, "plunder", "Takes the cargo");

        const catalog = await loadSkillCatalog({
            projectRoot: join(root, "project"),
            systemDirectory: join(root, "system"),
            userDirectory: join(root, "user"),
            disabledSkills: ["plunder"],
            extensionRoots: [],
            pluginRoots: [{ plugin: "sample-plugin", path: plugin }],
        });

        expect(catalog.skills).toEqual([]);
        expect(catalog.disabledSkills).toHaveLength(1);
        expect(catalog.disabledSkills[0]).toMatchObject({
            scope: "plugin",
            plugin: "sample-plugin",
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core an enabled plugin loads its skills and agents from the home store", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = join(root, "source");
        mkdirSync(source, { recursive: true });
        writeManifest(source);
        writeSkill(join(source, "skills"), "hello", "A hello skill");
        writeAgent(join(source, "dev.vera", "agents"), "scribe", "Writes it down");

        installPlugin(source, { home });

        const enabled = readPluginCatalog({ home });
        expect(enabled.warnings).toEqual([]);
        expect(enabled.skill_roots).toEqual([{
            plugin: "sample-plugin",
            path: join(veraHome, "plugins", "sample-plugin", "skills"),
        }]);
        expect(enabled.agent_roots).toEqual([{
            plugin: "sample-plugin",
            path: join(veraHome, "plugins", "sample-plugin", "dev.vera", "agents"),
        }]);

        setPluginEnabled("sample-plugin", false, { home });
        const disabled = readPluginCatalog({ home });
        expect(disabled.skill_roots).toEqual([]);
        expect(disabled.agent_roots).toEqual([]);
        expect(disabled.plugins[0]?.enabled).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing installed folder and an unrecorded folder load nothing", () => {
    const { root, home, veraHome } = temporaryHome();
    try {
        const source = join(root, "source");
        mkdirSync(source, { recursive: true });
        writeManifest(source);
        writeSkill(join(source, "skills"), "hello", "A hello skill");
        installPlugin(source, { home });

        rmSync(pluginDirectoryIn(veraHome, "sample-plugin"), {
            recursive: true,
            force: true,
        });
        const missing = readPluginCatalog({ home });
        expect(missing.skill_roots).toEqual([]);
        expect(missing.warnings).toEqual([
            "plugin sample-plugin: the installed folder is missing",
        ]);

        const other = temporaryHome();
        try {
            writeSkill(
                join(other.veraHome, "plugins", "rogue", "skills"),
                "rogue-skill",
                "Not recorded",
            );
            const unrecorded = readPluginCatalog({ home: other.home });
            expect(unrecorded.plugins).toEqual([]);
            expect(unrecorded.skill_roots).toEqual([]);
            expect(unrecorded.warnings).toEqual([]);
        } finally {
            rmSync(other.root, { recursive: true, force: true });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the catalog reads the installed copy, so an edit reaches the next build", async () => {
    const { root, home } = temporaryHome();
    try {
        const source = join(root, "source");
        mkdirSync(source, { recursive: true });
        writeManifest(source);
        writeSkill(join(source, "skills"), "hello", "Before the edit");
        installPlugin(source, { home });

        const catalog = readPluginCatalog({ home });
        const skillPath = join(
            catalog.skill_roots[0]!.path,
            "hello",
            SKILL_FILENAME,
        );
        writeFileSync(
            skillPath,
            "---\nname: hello\ndescription: After the edit\n---\n\nBody.\n",
        );

        const skills = await loadSkillCatalog({
            disabledSkills: [],
            extensionRoots: [],
            pluginRoots: catalog.skill_roots,
            systemDirectory: join(root, "system"),
            userDirectory: join(root, "user"),
        });
        expect(skills.skills[0]?.metadata.description).toBe("After the edit");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a host extension's skill roots join the plugin's own skills without duplicates", () => {
    const { root, home } = temporaryHome();
    try {
        const source = join(root, "source");
        mkdirSync(join(source, ".claude-plugin"), { recursive: true });
        writeFileSync(
            join(source, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: "sample-plugin", version: "1.0.0" }),
        );
        writeSkill(join(source, "skills"), "hello", "A hello skill");
        writeSkill(join(source, "extra"), "extra", "An extra skill");
        writeFileSync(join(source, "extension.ts"), "export default {};\n");
        writeFileSync(join(source, "vera.extension.json"), JSON.stringify({
            id: "dev.vera.sample",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: [],
            contributes: { skills: ["skills", "extra"] },
        }));

        const installed = installPlugin(source, { home });
        expect(installed.record?.components.skills).toEqual(["extra", "hello"]);
        expect(installed.record?.components.skill_roots).toEqual([
            "extra",
            "skills",
        ]);
        expect(readPluginCatalog({ home }).skill_roots).toHaveLength(2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("plugin agents are read-only and let user and project agents shadow them", async () => {
    const { root, home } = temporaryHome();
    try {
        const source = join(root, "source");
        mkdirSync(source, { recursive: true });
        writeManifest(source);
        writeAgent(join(source, "dev.vera", "agents"), "scribe", "Plugin scribe");
        writeAgent(join(source, "dev.vera", "agents"), "reviewer", "Plugin reviewer");
        writeAgent(join(source, "dev.vera", "agents"), "planner", "Plugin planner");
        installPlugin(source, { home });

        const project = join(root, "project");
        writeAgent(join(root, "user", "agents"), "reviewer", "User reviewer");
        writeAgent(join(project, ".vera", "agents"), "planner", "Project planner");
        const catalog = readPluginCatalog({ home });

        const agents = await loadAgentCatalog({
            projectRoot: project,
            userDirectory: join(root, "user", "agents"),
            pluginRoots: catalog.agent_roots,
        });

        expect(agents.agents.find((agent) => agent.definition.name === "scribe"))
            .toMatchObject({
                scope: "plugin",
                plugin: "sample-plugin",
                writable: false,
            });
        expect(agents.agents.find((agent) => agent.definition.name === "reviewer"))
            .toMatchObject({ scope: "user" });
        expect(agents.agents.find((agent) => agent.definition.name === "planner"))
            .toMatchObject({ scope: "project" });
        expect(agents.notices).toContain(
            "agent reviewer: user definition shadows the plugin sample-plugin one",
        );
        expect(agents.notices).toContain(
            "agent planner: project definition shadows the plugin sample-plugin one",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

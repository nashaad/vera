import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { readFolderCustomizations } from "../../clients/desktop/src/customization-requests.ts";
import { connectHost } from "../../src/host/connection.ts";
import { parseHostRequest, type FolderCustomizationsResponse } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { installPlugin } from "../../src/plugins/manager.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

test("@core folder_customizations parses with and without a folder", () => {
    expect(parseHostRequest('{"type":"folder_customizations"}')).toEqual({ type: "folder_customizations" });
    expect(parseHostRequest('{"type":"folder_customizations","workspace":"/nest/crow"}')).toEqual({
        type: "folder_customizations",
        workspace: "/nest/crow",
    });
});

test("folder_customizations refuses a folder that is not an absolute path", () => {
    for (const workspace of ["", "nest/crow", "./crow", 7, null, ["/nest"], "/nest\0crow"]) {
        expect(parseHostRequest(JSON.stringify({ type: "folder_customizations", workspace }))).toBeUndefined();
    }
});

async function ask(socketPath: string, request: Record<string, unknown>): Promise<FolderCustomizationsResponse> {
    const connection = await connectHost({ socketPath });
    connection.expectPeerClose();
    try {
        await connection.send(request);
        return await connection.receiveWithin(5_000, "The host did not answer in time.") as FolderCustomizationsResponse;
    } finally {
        connection.close();
    }
}

// The host keeps writing under runtime/ on its own after it starts, so that folder is left out.
async function treeOf(directory: string): Promise<readonly string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries
        .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
        .filter((path) => path !== "runtime" && !path.startsWith("runtime/"))
        .sort();
}

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`);
}

interface Setup {
    readonly root: string;
    readonly home: string;
    readonly folder: string;
    readonly sessions: string;
    readonly socketPath: string;
    readonly close: () => Promise<void>;
}

async function startHost(
    prefix: string,
    withPlugin = false,
    corruptRegistry = false,
): Promise<Setup> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const home = join(root, "home");
    const folder = join(root, "crow-nest");
    const sessions = join(root, "sessions");
    await mkdir(join(home, "agents"), { recursive: true });
    await mkdir(join(folder, ".vera", "agents"), { recursive: true });
    await writeSkill(join(home, "skills"), "mast-watch", "Looks from the mast");
    await writeSkill(join(folder, ".vera", "skills"), "nest-check", "Checks the nest");
    await writeFile(join(home, "agents", "scout.md"), "---\ndescription: Looks ahead\n---\nScout the water.");
    await writeFile(join(folder, ".vera", "agents", "plan.md"), "---\ndescription: Plans before it edits\n---\nPlan only.");
    await writeFile(join(folder, "AGENTS.md"), "Caw before you commit.\n");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    if (withPlugin) {
        const source = join(root, "plugin-source");
        await mkdir(join(source, "dev.vera", "agents"), { recursive: true });
        await writeFile(join(source, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: "fixture-plugin",
            version: "1.0.0",
        }));
        await writeSkill(join(source, "skills"), "plugin-skill", "Ships with the plugin");
        await writeFile(
            join(source, "dev.vera", "agents", "plugin-agent.md"),
            "---\ndescription: Sails with the plugin\n---\nSail with the plugin.\n",
        );
        installPlugin(source);
    }
    if (corruptRegistry) {
        await mkdir(join(home, "machine"), { recursive: true });
        await writeFile(join(home, "machine", "plugins.json"), "{ not json");
    }
    const host = await startResidentHost({
        config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
        createAdapter: () => new FauxAdapter([]),
        home,
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: sessions,
        eventLogDirectory: join(root, "logs"),
    });
    return {
        root,
        home,
        folder,
        sessions,
        socketPath: host.server.socketPath,
        close: async () => {
            await host.close();
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        },
    };
}

socketTest("@core a real host reads a folder's skills, agents and instruction files without a session", async () => {
    const setup = await startHost("vera-folder-customizations-");
    try {
        const before = [await treeOf(setup.home), await treeOf(setup.folder), await treeOf(setup.sessions)];
        const read = await ask(setup.socketPath, { type: "folder_customizations", workspace: setup.folder });
        expect(read.type).toBe("folder_customizations");

        const skillNames = read.skills.skills.map((skill) => skill.name);
        expect(skillNames).toContain("nest-check");
        expect(skillNames).toContain("mast-watch");

        expect(read.agents.starts_on).toBe("default");
        expect(read.agents.agents).toContainEqual(expect.objectContaining({ name: "plan", scope: "project" }));
        expect(read.agents.agents).toContainEqual(expect.objectContaining({ name: "scout", scope: "user" }));

        const sources = read.sources.sources;
        expect(sources).toContainEqual(expect.objectContaining({
            id: "skills:nest-check",
            category: "skills",
            scope: "project",
            description: "Checks the nest",
        }));
        expect(sources).toContainEqual(expect.objectContaining({ id: "agents:plan", category: "agents", scope: "project" }));
        expect(sources.find((source) => source.category === "instructions")?.content).toContain("Caw before you commit.");

        expect([await treeOf(setup.home), await treeOf(setup.folder), await treeOf(setup.sessions)]).toEqual(before);
        const stored = await readdir(setup.sessions).catch(() => []);
        expect(stored.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    } finally {
        await setup.close();
    }
});

socketTest("@core a real host names the plugin behind each skill, agent and source", async () => {
    const setup = await startHost("vera-folder-customizations-plugin-", true);
    try {
        const read = await ask(setup.socketPath, { type: "folder_customizations" });
        expect(read.skills.skills).toContainEqual(expect.objectContaining({
            name: "plugin-skill",
            plugin: "fixture-plugin",
        }));
        expect(read.agents.agents).toContainEqual(expect.objectContaining({
            name: "plugin-agent",
            scope: "plugin",
            plugin: "fixture-plugin",
            writable: false,
        }));
        expect(read.sources.sources).toContainEqual(expect.objectContaining({
            id: "skills:plugin-skill",
            category: "skills",
            plugin: "fixture-plugin",
        }));
        expect(read.sources.sources).toContainEqual(expect.objectContaining({
            id: "agents:plugin-agent",
            category: "agents",
            plugin: "fixture-plugin",
        }));
        expect(read.sources.sources).toContainEqual(expect.objectContaining({
            id: "plugins:fixture-plugin",
            category: "plugins",
            scope: "plugin",
            plugin: "fixture-plugin",
            status: "enabled",
        }));
    } finally {
        await setup.close();
    }
});

socketTest("a corrupt plugin registry is reported once in a folder read", async () => {
    const setup = await startHost("vera-folder-customizations-corrupt-", true);
    try {
        await writeFile(join(setup.home, "machine", "plugins.json"), "{ not json");
        const read = await ask(setup.socketPath, { type: "folder_customizations" });
        expect(read.sources.warnings.filter((warning) => warning.startsWith("Plugins:")))
            .toHaveLength(1);
        expect(read.sources.sources.some((source) => source.category === "plugins"))
            .toBe(false);
    } finally {
        await setup.close();
    }
});

socketTest("@core a corrupt plugin registry does not stop the host from booting", async () => {
    const setup = await startHost("vera-folder-customizations-boot-", true, true);
    try {
        const read = await ask(setup.socketPath, { type: "folder_customizations" });
        expect(read.sources.warnings.filter((warning) => warning.startsWith("Plugins:")))
            .toHaveLength(1);
        expect(read.sources.sources.some((source) => source.category === "plugins"))
            .toBe(false);
    } finally {
        await setup.close();
    }
});

socketTest("@core a read with no folder lists the home's items and none of a folder's", async () => {
    const setup = await startHost("vera-folder-customizations-chat-");
    try {
        const read = await ask(setup.socketPath, { type: "folder_customizations" });
        const skillNames = read.skills.skills.map((skill) => skill.name);
        expect(skillNames).toContain("mast-watch");
        expect(skillNames).not.toContain("nest-check");

        const agentNames = read.agents.agents.map((agent) => agent.name);
        expect(agentNames).toContain("scout");
        expect(agentNames).toContain("default");
        expect(agentNames).not.toContain("plan");

        const sources = read.sources.sources;
        expect(sources.some((source) => source.id === "skills:mast-watch")).toBe(true);
        expect(sources.some((source) => source.id === "skills:nest-check")).toBe(false);
        expect(sources.some((source) => source.id === "agents:plan")).toBe(false);
        expect(sources.some((source) => source.category === "instructions" && source.scope === "project")).toBe(false);
    } finally {
        await setup.close();
    }
});

socketTest("a folder that does not exist reads as the home's items alone", async () => {
    const setup = await startHost("vera-folder-customizations-gone-");
    try {
        const read = await ask(setup.socketPath, { type: "folder_customizations", workspace: join(setup.root, "no-such-folder") });
        expect(read.skills.skills.map((skill) => skill.name)).toContain("mast-watch");
        expect(read.skills.skills.map((skill) => skill.name)).not.toContain("nest-check");
        expect(read.agents.agents.map((agent) => agent.name)).not.toContain("plan");
    } finally {
        await setup.close();
    }
});

socketTest("a malformed folder_customizations request gets no reading", async () => {
    const setup = await startHost("vera-folder-customizations-bad-");
    try {
        await expect(ask(setup.socketPath, { type: "folder_customizations", workspace: "relative/folder" })).rejects.toThrow();
        await expect(ask(setup.socketPath, { type: "folder_customizations", workspace: "" })).rejects.toThrow();
    } finally {
        await setup.close();
    }
});

socketTest("@core the window reads a real host's answer for a folder and for a chat", async () => {
    const setup = await startHost("vera-folder-customizations-window-");
    try {
        const inFolder = await readFolderCustomizations(setup.socketPath, setup.folder);
        if (!inFolder.ok) throw new Error(inFolder.reason);
        expect(inFolder.startsOn).toBe("default");
        expect(inFolder.skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["nest-check", "mast-watch"]));
        expect(inFolder.agents.find((agent) => agent.name === "plan")).toMatchObject({ scope: "project" });
        expect(inFolder.sources.find((source) => source.id === "skills:nest-check")).toMatchObject({ scope: "project", category: "skills" });
        expect(inFolder.sources.find((source) => source.category === "instructions")?.content).toContain("Caw before you commit.");

        const chat = await readFolderCustomizations(setup.socketPath, undefined);
        if (!chat.ok) throw new Error(chat.reason);
        expect(chat.skills.map((skill) => skill.name)).toContain("mast-watch");
        expect(chat.skills.map((skill) => skill.name)).not.toContain("nest-check");
        expect(chat.agents.map((agent) => agent.name)).not.toContain("plan");
    } finally {
        await setup.close();
    }
});

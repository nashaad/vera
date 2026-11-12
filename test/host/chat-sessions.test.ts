import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { indexStoredSession } from "../../src/host/session-host/storage.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { chatFolderPath, isChatFolder } from "../../src/store/chat-folder.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function withChats<T>(
    body: (context: {
        readonly root: string;
        readonly registry: AgentRegistry;
        readonly path: (name: string) => string;
    }) => Promise<T>,
    options: { readonly agents?: boolean; readonly trash?: (path: string) => Promise<void> } = {},
): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "vera-chat-"));
    const extensions = await startExtensionRegistry({
        extensions: includedExtensionConfigs([]),
    });
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        model: "faux/test",
        approvalMode: "auto",
        ...(options.agents === false ? {} : { registeredAgents: extensions.agents() }),
        trashSessionArtifacts: (artifacts) => trashSessionArtifacts(artifacts, {
            moveToTrash: async ([bundle]) => {
                await options.trash?.(bundle!);
            },
        }),
    });
    try {
        return await body({ root, registry, path: (name) => join(root, `${name}.jsonl`) });
    } finally {
        await registry.close();
        await extensions.close();
        await rm(root, { recursive: true, force: true });
    }
}

function row(registry: AgentRegistry, id: string): RegisteredAgentSummary {
    const found = registry.list().find((agent) => agent.id === id);
    if (found === undefined) throw new Error(`No row for ${id}`);
    return found;
}

test("@core a create without a workspace makes the session's own folder and records it as the cwd", async () => {
    await withChats(async ({ registry, path }) => {
        const sessionPath = path("chat");
        const agent = await registry.create({ id: "chat", sessionPath });
        const folder = chatFolderPath(sessionPath);

        expect((await stat(folder)).isDirectory()).toBe(true);
        expect(agent.workspace).toBe(await realpath(folder));
        const stored = await SessionStore.open(sessionPath);
        expect(stored.header.cwd).toBe(await realpath(folder));
        expect(stored.selectedAgent()?.name).toBe("chat");
        expect([...(stored.selectedAgent()?.snapshot.tools ?? [])].sort())
            .toEqual(["edit", "list", "read", "web_fetch", "web_search", "write"]);
    });
});

test("@core a chat row carries chat: true and an ordinary session's row does not", async () => {
    await withChats(async ({ root, registry, path }) => {
        const project = join(root, "project");
        await mkdir(project);
        await registry.create({ id: "chat", sessionPath: path("chat") });
        await registry.create({ id: "plain", workspace: project, sessionPath: path("plain") });

        expect(row(registry, "chat").chat).toBe(true);
        expect("chat" in row(registry, "plain")).toBe(false);

        const stored = new Map<string, RegisteredAgentSummary>();
        await indexStoredSession(path("chat"), stored);
        await indexStoredSession(path("plain"), stored);
        expect(stored.get("chat")?.chat).toBe(true);
        expect("chat" in stored.get("plain")!).toBe(false);
    });
});

test("a chat folder is recognised through a symlinked parent and nowhere else", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-chat-link-"));
    try {
        const real = join(root, "real");
        await mkdir(real);
        const { symlink } = await import("node:fs/promises");
        await symlink(real, join(root, "link"));
        const sessionPath = join(root, "link", "one.jsonl");

        expect(isChatFolder(sessionPath, `${sessionPath}.files`)).toBe(true);
        expect(isChatFolder(sessionPath, join(real, "one.jsonl.files"))).toBe(true);
        expect(isChatFolder(sessionPath, join(real, "two.jsonl.files"))).toBe(false);
        expect(isChatFolder(sessionPath, real)).toBe(false);
        expect(isChatFolder(sessionPath, join(root, "other", "one.jsonl.files"))).toBe(false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a chat starts on the default agent when the catalog has no chat agent", async () => {
    await withChats(async ({ registry, path }) => {
        await registry.create({ id: "chat", sessionPath: path("chat") });

        const stored = await SessionStore.open(path("chat"));
        expect(stored.selectedAgent()).toBeUndefined();
        expect(row(registry, "chat").chat).toBe(true);
    }, { agents: false });
});

test("a create with a workspace stays on the default agent", async () => {
    await withChats(async ({ root, registry, path }) => {
        const project = join(root, "project");
        await mkdir(project);
        await registry.create({ id: "plain", workspace: project, sessionPath: path("plain") });

        expect((await SessionStore.open(path("plain"))).selectedAgent()).toBeUndefined();
        await expect(stat(chatFolderPath(path("plain")))).rejects.toMatchObject({ code: "ENOENT" });
    });
});

test("a failed chat create removes the folder it made and keeps an existing session file", async () => {
    await withChats(async ({ root, registry, path }) => {
        const sessionPath = path("taken");
        await writeFile(sessionPath, "existing\n");

        await expect(registry.create({ id: "chat", sessionPath })).rejects.toThrow();

        await expect(stat(chatFolderPath(sessionPath))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(sessionPath, "utf8")).toBe("existing\n");
        expect(registry.find("chat")).toBeUndefined();
        expect(await readdir(root)).toEqual(["taken.jsonl"]);
    });
});

test("deleting a chat moves its folder to the trash with the session", async () => {
    let bundled: string | undefined;
    await withChats(async ({ registry, path }) => {
        const sessionPath = path("chat");
        const agent = await registry.create({ id: "chat", sessionPath });
        await writeFile(join(agent.workspace, "notes.txt"), "kept\n");

        expect(await registry.trashSession("chat")).toBe("trashed");

        await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(chatFolderPath(sessionPath))).rejects.toMatchObject({ code: "ENOENT" });
        expect(bundled).toBe("kept\n");
    }, {
        trash: async (bundle) => {
            bundled = await readFile(join(bundle, "files", "notes.txt"), "utf8");
        },
    });
});

test("resuming a chat recreates its own folder when it is missing", async () => {
    await withChats(async ({ registry, path }) => {
        const sessionPath = path("chat");
        const agent = await registry.create({ id: "chat", sessionPath });
        const folder = agent.workspace;
        await registry.closeAgent("chat");
        await rm(folder, { recursive: true });

        const resumed = await registry.resume({ sessionPath });

        expect(resumed.workspace).toBe(folder);
        expect(await readdir(folder)).toEqual([]);
        expect(row(registry, "chat").chat).toBe(true);
    });
});

test("resuming a session whose ordinary folder is missing does not recreate it", async () => {
    await withChats(async ({ root, registry, path }) => {
        const project = join(root, "project");
        await mkdir(project);
        await registry.create({ id: "plain", workspace: project, sessionPath: path("plain") });
        await registry.closeAgent("plain");
        await rm(project, { recursive: true });

        await registry.resume({ sessionPath: path("plain") });

        await expect(stat(project)).rejects.toMatchObject({ code: "ENOENT" });
        expect("chat" in row(registry, "plain")).toBe(false);

        await expect(registry.create({ id: "again", workspace: project, sessionPath: path("again") }))
            .rejects.toThrow(`Session workspace is unavailable: ${project}`);
    });
});

test("branching a chat copies its folder and records the copy as the branch's cwd", async () => {
    await withChats(async ({ registry, path }) => {
        const source = await registry.create({ id: "chat", sessionPath: path("chat") });
        await mkdir(join(source.workspace, "drafts"));
        await writeFile(join(source.workspace, "drafts", "one.md"), "one\n");

        const branched = await registry.branch({
            sourceId: "chat",
            id: "copy",
            sessionPath: path("copy"),
            position: "at",
        });

        const copyFolder = branched!.agent.workspace;
        expect(copyFolder).not.toBe(source.workspace);
        expect(copyFolder).toBe(await realpath(chatFolderPath(path("copy"))));
        expect((await SessionStore.open(path("copy"))).header.cwd).toBe(copyFolder);
        expect(await readFile(join(copyFolder, "drafts", "one.md"), "utf8")).toBe("one\n");
        await writeFile(join(copyFolder, "drafts", "one.md"), "changed\n");
        expect(await readFile(join(source.workspace, "drafts", "one.md"), "utf8")).toBe("one\n");
        expect(row(registry, "copy").chat).toBe(true);
        expect(row(registry, "chat").chat).toBe(true);
    });
});

test("a failed branch of a chat leaves no copied folder", async () => {
    await withChats(async ({ root, registry, path }) => {
        await registry.create({ id: "chat", sessionPath: path("chat") });
        const controller = new AbortController();
        controller.abort();

        await expect(registry.branch({
            sourceId: "chat",
            id: "copy",
            sessionPath: path("copy"),
            position: "at",
            signal: controller.signal,
        })).rejects.toThrow();

        expect((await readdir(root)).filter((name) => name.startsWith("copy"))).toEqual([]);
    });
});

test("an ephemeral branch of a chat keeps working in the source's folder", async () => {
    await withChats(async ({ registry, path }) => {
        const source = await registry.create({ id: "chat", sessionPath: path("chat") });

        const branched = await registry.branch({
            sourceId: "chat",
            id: "side",
            position: "at",
            ephemeral: true,
        });

        expect(branched!.agent.workspace).toBe(source.workspace);
        await expect(stat(chatFolderPath(path("side")))).rejects.toMatchObject({ code: "ENOENT" });
    });
});

test("a delegated child of a chat works in its parent's folder and is not a chat", async () => {
    await withChats(async ({ registry, path }) => {
        const parent = await registry.create({ id: "chat", sessionPath: path("chat") });

        const child = await registry.createWithKind(
            { id: "child", workspace: parent.workspace, sessionPath: path("child") },
            "background",
            { approvalMode: "auto", parentId: "chat" },
        );

        expect(child.workspace).toBe(parent.workspace);
        expect("chat" in row(registry, "child")).toBe(false);
        await expect(stat(chatFolderPath(path("child")))).rejects.toMatchObject({ code: "ENOENT" });
    });
});

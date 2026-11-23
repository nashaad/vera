import { expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { copyChatFolder } from "../../src/host/agent-registry/chat.ts";
import { indexStoredSession } from "../../src/host/session-host/storage.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { chatFolderPath, isChatFolder } from "../../src/store/chat-folder.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function withChats<T>(
    body: (context: {
        readonly root: string;
        readonly registry: AgentRegistry;
        readonly path: (name: string) => string;
    }) => Promise<T>,
    options: {
        readonly trash?: (path: string) => Promise<void>;
        readonly createAdapter?: () => ModelAdapter;
    } = {},
): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "vera-chat-"));
    const extensions = await startExtensionRegistry({
        extensions: includedExtensionConfigs([]),
    });
    const registry = new AgentRegistry({
        createAdapter: options.createAdapter ?? (() => new FauxAdapter([])),
        model: "faux/test",
        approvalMode: "auto",
        registeredAgents: extensions.agents(),
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
        const store = registry.agents.get("chat")!.store;
        expect(store.header.cwd).toBe(await realpath(folder));
        expect(store.selectedAgent()).toBeUndefined();
        await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
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

        await registry.renameSession("chat", "saved chat");
        await registry.renameSession("plain", "saved project");
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

test("the chat agent can still be picked in a chat", async () => {
    await withChats(async ({ registry, path }) => {
        await registry.create({ id: "chat", sessionPath: path("chat") });
        await registry.selectAgentFor("chat", "chat");

        const stored = await SessionStore.open(path("chat"));
        expect(stored.selectedAgent()?.name).toBe("chat");
        expect([...(stored.selectedAgent()?.snapshot.tools ?? [])].sort())
            .toEqual(["builtin_browser", "builtin_browser_eval", "edit", "file_feedback", "list", "read", "web_fetch", "web_search", "write"]);
        expect(row(registry, "chat").chat).toBe(true);
    });
});

test("a create with a workspace stays on the default agent", async () => {
    await withChats(async ({ root, registry, path }) => {
        const project = join(root, "project");
        await mkdir(project);
        await registry.create({ id: "plain", workspace: project, sessionPath: path("plain") });

        expect(registry.agents.get("plain")!.store.selectedAgent()).toBeUndefined();
        await expect(stat(path("plain"))).rejects.toMatchObject({ code: "ENOENT" });
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
        await registry.renameSession("chat", "saved");
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
        await registry.renameSession("plain", "saved");
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

test("@core branching a chat preserves nested files, file modes, and empty directories", async () => {
    await withChats(async ({ registry, path }) => {
        const source = await registry.create({ id: "chat", sessionPath: path("chat") });
        const nested = join(source.workspace, "drafts", "nested");
        await mkdir(nested, { recursive: true });
        await mkdir(join(source.workspace, "empty"));
        await writeFile(join(nested, "one.md"), "one\n");
        await chmod(join(nested, "one.md"), 0o640);

        const branched = await registry.branch({
            sourceId: "chat",
            id: "copy",
            sessionPath: path("copy"),
            position: "at",
        });

        const folder = branched!.agent.workspace;
        const copiedFile = join(folder, "drafts", "nested", "one.md");
        expect(folder).toBe(await realpath(chatFolderPath(path("copy"))));
        expect((await SessionStore.open(path("copy"))).header.cwd).toBe(folder);
        expect((await stat(folder)).mode & 0o777).toBe(0o700);
        expect((await stat(copiedFile)).mode & 0o777).toBe(0o640);
        expect(await readFile(copiedFile, "utf8")).toBe("one\n");
        expect(await readdir(join(folder, "empty"))).toEqual([]);
        await writeFile(copiedFile, "changed\n");
        expect(await readFile(join(nested, "one.md"), "utf8")).toBe("one\n");
    });
});

test("branching a chat with an empty or missing folder creates an empty copy", async () => {
    await withChats(async ({ registry, path }) => {
        const source = await registry.create({ id: "chat", sessionPath: path("chat") });

        const branched = await registry.branch({
            sourceId: "chat",
            id: "copy",
            sessionPath: path("copy"),
            position: "at",
        });

        const folder = branched!.agent.workspace;
        expect(folder).toBe(await realpath(chatFolderPath(path("copy"))));
        expect((await SessionStore.open(path("copy"))).header.cwd).toBe(folder);
        expect((await stat(folder)).mode & 0o777).toBe(0o700);
        expect(await readdir(folder)).toEqual([]);

        await rm(source.workspace, { recursive: true });
        const missing = await registry.branch({
            sourceId: "chat",
            id: "missing-copy",
            sessionPath: path("missing-copy"),
            position: "at",
        });
        const missingFolder = missing!.agent.workspace;
        expect(missingFolder).toBe(await realpath(chatFolderPath(path("missing-copy"))));
        expect((await SessionStore.open(path("missing-copy"))).header.cwd).toBe(missingFolder);
        expect((await stat(missingFolder)).mode & 0o777).toBe(0o700);
        expect(await readdir(missingFolder)).toEqual([]);
    });
});

test("copying a missing chat folder creates a private empty folder", async () => {
    await withChats(async ({ root, path }) => {
        const copy = await copyChatFolder(join(root, "missing"), path("copy"));
        const folder = chatFolderPath(path("copy"));

        expect(copy).toEqual({ cwd: await realpath(folder), created: true });
        expect((await stat(folder)).mode & 0o777).toBe(0o700);
        expect(await readdir(folder)).toEqual([]);
    });
});

test("branching a chat does not merge into an existing destination folder", async () => {
    await withChats(async ({ registry, path }) => {
        await registry.create({ id: "chat", sessionPath: path("chat") });
        const folder = chatFolderPath(path("copy"));
        await mkdir(folder);
        await writeFile(join(folder, "existing.md"), "keep\n");

        await expect(registry.branch({
            sourceId: "chat",
            id: "copy",
            sessionPath: path("copy"),
            position: "at",
        })).rejects.toMatchObject({ code: "EEXIST" });

        expect(await readdir(folder)).toEqual(["existing.md"]);
        expect(await readFile(join(folder, "existing.md"), "utf8")).toBe("keep\n");
        await expect(stat(path("copy"))).rejects.toMatchObject({ code: "ENOENT" });
    });
});

test("a chat folder copy failure removes its destination", async () => {
    await withChats(async ({ registry, path }) => {
        const source = await registry.create({ id: "chat", sessionPath: path("chat") });
        await writeFile(join(source.workspace, "one.md"), "one\n");
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(join(source.workspace, "socket"), resolve);
        });
        try {
            await expect(registry.branch({
                sourceId: "chat",
                id: "copy",
                sessionPath: path("copy"),
                position: "at",
            })).rejects.toMatchObject({ code: "ERR_FS_CP_SOCKET" });

            await expect(stat(chatFolderPath(path("copy")))).rejects.toMatchObject({ code: "ENOENT" });
            await expect(stat(path("copy"))).rejects.toMatchObject({ code: "ENOENT" });
            expect(await readFile(join(source.workspace, "one.md"), "utf8")).toBe("one\n");
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => error === undefined ? resolve() : reject(error));
            });
        }
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

const CHAT_FOLDER_PARAGRAPH = "This conversation has no project folder. The working directory is its own folder, created empty when the conversation started, and the person sees its files only under Files. Keep anything they may want in it.";

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function runPrompt(attachment: AgentAttachment, content: string): Promise<void> {
    expect((await attachment.receive()).type).toBe("history");
    attachment.send({ type: "prompt", content });
    while ((await attachment.receive()).type !== "turn_finished") {
        // Drain the ordered update stream up to the turn boundary.
    }
}

test("a chat's system prompt says its folder is its own, on every turn and after a resume, and a project session's does not", async () => {
    const requests: ModelRequest[] = [];
    await withChats(async ({ root, registry, path }) => {
        const project = join(root, "project");
        await mkdir(project);
        const chat = await registry.create({ id: "chat", sessionPath: path("chat") });
        const plain = await registry.create({ id: "plain", workspace: project, sessionPath: path("plain") });

        const chatAttachment = chat.attach();
        await runPrompt(chatAttachment, "first");
        chatAttachment.send({ type: "prompt", content: "second" });
        while ((await chatAttachment.receive()).type !== "turn_finished") {
            // Drain the second turn.
        }
        await runPrompt(plain.attach(), "first");
        await registry.closeAgent("chat");
        const resumed = await registry.resume({ sessionPath: path("chat") });
        await runPrompt(resumed.attach(), "after resume");

        const promptOf = (request: ModelRequest): string => request.systemPrompt ?? "";
        const stable = (request: ModelRequest): string =>
            promptOf(request).split("\n\n## Date")[0]!;
        expect(requests).toHaveLength(4);
        const [first, second, plainRequest, afterResume] = requests as [
            ModelRequest, ModelRequest, ModelRequest, ModelRequest,
        ];
        for (const request of [first, second, afterResume]) {
            expect(promptOf(request)).toContain(
                `Working directory: ${chat.workspace}\n\n${CHAT_FOLDER_PARAGRAPH}`,
            );
        }
        expect(stable(second)).toBe(stable(first));
        expect(stable(afterResume)).toBe(stable(first));
        expect(promptOf(plainRequest)).toContain(`Working directory: ${plain.workspace}`);
        expect(promptOf(plainRequest)).not.toContain("This conversation has no project folder");
    }, {
        createAdapter: () => ({
            stream(request) {
                requests.push(request);
                return new FauxAdapter([textResponse("done")]).stream(request);
            },
        }),
    });
});

const NOTES_PARAGRAPH = "The person may want to keep notes from this conversation. When it would help (documents were shared, a decision was settled, a topic keeps coming back), offer once, in one sentence, and ask where they keep notes, such as a notes app they already use or a folder. Do not offer again if they decline or ignore it. Keep the notes where they say, one page per topic, current as the conversation goes on. If your tools cannot write there, say so. If they have nowhere in mind, use a notes/ folder in the working directory with an index.md that links the pages.";

test("a session created with the notes offer keeps it fixed in its header and its stable prompt, through turns, a resume and a branch", async () => {
    const requests: ModelRequest[] = [];
    await withChats(async ({ root, registry, path }) => {
        const project = join(root, "project");
        await mkdir(project);
        const offered = await registry.create({ id: "offered", sessionPath: path("offered"), notesOffer: true });
        const inProject = await registry.create({ id: "project", workspace: project, sessionPath: path("project"), notesOffer: true });
        const plain = await registry.create({ id: "plain", sessionPath: path("plain") });

        expect(registry.agents.get("offered")!.store.header.notesOffer).toBe(true);
        expect(registry.agents.get("project")!.store.header.notesOffer).toBe(true);
        expect("notesOffer" in registry.agents.get("plain")!.store.header).toBe(false);

        const attachment = offered.attach();
        await runPrompt(attachment, "first");
        attachment.send({ type: "prompt", content: "second" });
        while ((await attachment.receive()).type !== "turn_finished") {
            // Drain the second turn.
        }
        await runPrompt(inProject.attach(), "first");
        await runPrompt(plain.attach(), "first");
        await registry.closeAgent("offered");
        const resumed = await registry.resume({ sessionPath: path("offered") });
        await runPrompt(resumed.attach(), "after resume");
        const branched = await registry.branch({ sourceId: "offered", id: "copy", sessionPath: path("copy"), position: "at" });
        await runPrompt(branched!.agent.attach(), "in the copy");

        expect((await SessionStore.open(path("copy"))).header.notesOffer).toBe(true);
        const promptOf = (request: ModelRequest): string => request.systemPrompt ?? "";
        const stable = (request: ModelRequest): string => promptOf(request).split("\n\n## Date")[0]!;
        expect(requests).toHaveLength(6);
        const [first, second, projectRequest, plainRequest, afterResume, copyRequest] = requests as [
            ModelRequest, ModelRequest, ModelRequest, ModelRequest, ModelRequest, ModelRequest,
        ];
        for (const request of [first, second, projectRequest, afterResume, copyRequest]) {
            expect(promptOf(request)).toContain(`## Notes\n${NOTES_PARAGRAPH}`);
        }
        expect(promptOf(plainRequest)).not.toContain("## Notes");
        expect(promptOf(plainRequest)).not.toContain("notes/");
        expect(stable(second)).toBe(stable(first));
        expect(stable(afterResume)).toBe(stable(first));
        expect(promptOf(first).indexOf("## Notes")).toBeLessThan(promptOf(first).indexOf("## Date"));
    }, {
        createAdapter: () => ({
            stream(request) {
                requests.push(request);
                return new FauxAdapter([textResponse("done")]).stream(request);
            },
        }),
    });
});

test("@core a create stores canonical write roots in the session header", async () => {
    await withChats(async ({ root, registry, path }) => {
        const target = join(root, "shared");
        await mkdir(target);
        const link = join(root, "shared-link");
        await symlink(target, link);
        const rooted = await registry.create({
            id: "rooted",
            sessionPath: path("rooted"),
            writeRoots: [link],
        });
        expect(registry.agents.get("rooted")!.store.header.writeRoots).toEqual([target]);
        await runPrompt(rooted.attach(), "first");
        expect((await SessionStore.open(path("rooted"))).header.writeRoots).toEqual([target]);

        const plain = await registry.create({ id: "plain", sessionPath: path("plain") });
        await runPrompt(plain.attach(), "first");
        expect("writeRoots" in (await SessionStore.open(path("plain"))).header).toBe(false);
    }, {
        createAdapter: () => new FauxAdapter([textResponse("done")]),
    });
});

test("@core a create stores canonical read roots in the session header and a branch keeps them", async () => {
    await withChats(async ({ root, registry, path }) => {
        const target = join(root, "reference");
        await mkdir(target);
        const link = join(root, "reference-link");
        await symlink(target, link);
        const rooted = await registry.create({
            id: "rooted",
            sessionPath: path("rooted"),
            readRoots: [link],
        });
        expect(registry.agents.get("rooted")!.store.header.readRoots).toEqual([target]);
        await runPrompt(rooted.attach(), "first");
        expect((await SessionStore.open(path("rooted"))).header.readRoots).toEqual([target]);

        const branched = await registry.branch({ sourceId: "rooted", id: "copy", sessionPath: path("copy"), position: "at" });
        await runPrompt(branched!.agent.attach(), "in the copy");
        expect((await SessionStore.open(path("copy"))).header.readRoots).toEqual([target]);

        const plain = await registry.create({ id: "plain", sessionPath: path("plain") });
        await runPrompt(plain.attach(), "first");
        expect("readRoots" in (await SessionStore.open(path("plain"))).header).toBe(false);
    }, {
        createAdapter: () => new FauxAdapter([textResponse("done"), textResponse("done"), textResponse("done"), textResponse("done")]),
    });
});

test("a create with an invalid read root is refused before a session exists", async () => {
    await withChats(async ({ root, registry, path }) => {
        await expect(registry.create({
            id: "bad",
            sessionPath: path("bad"),
            readRoots: [join(root, "missing")],
        })).rejects.toThrow("does not exist");
        expect(registry.agents.has("bad")).toBe(false);
    });
});

import { expect, test } from "bun:test";
import {
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defaultEventLogPath, modelRequestSnapshotPath } from "../../src/engine/events.ts";
import { includedExtensionConfigs } from "../../src/extensions/included.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { indexStoredSession } from "../../src/host/session-host/storage.ts";
import { trashSessionArtifacts } from "../../src/host/session-trash.ts";
import { chatFolderPath } from "../../src/store/chat-folder.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface MoveContext {
    readonly sessions: string;
    readonly project: string;
    readonly registry: AgentRegistry;
    readonly path: (name: string) => string;
    readonly eventLog: (id: string, cwd: string) => string;
}

// The project sits beside the sessions directory: a move into the sessions directory is refused.
async function withMoves<T>(
    body: (context: MoveContext) => Promise<T>,
    options: {
        readonly delayMs?: number;
        readonly eventLogs?: boolean;
        readonly trash?: (path: string) => Promise<void>;
    } = {},
): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "vera-move-"));
    const sessions = join(root, "sessions");
    const project = join(root, "project");
    await mkdir(sessions);
    await mkdir(join(project, ".vera", "agents"), { recursive: true });
    await writeFile(join(project, ".vera", "agents", "builder.md"), "---\ndescription: Builds things.\n---\nBuild things.");
    const extensions = await startExtensionRegistry({
        extensions: includedExtensionConfigs([]),
    });
    const logs = join(root, "logs");
    const eventLog = (id: string, cwd: string) => defaultEventLogPath(id, cwd, logs);
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([textResponse("done")], { delayMs: options.delayMs ?? 0 }),
        ...(options.eventLogs === true ? { eventLogPathForId: eventLog } : {}),
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
        return await body({
            sessions,
            project: await realpath(project),
            registry,
            path: (name) => join(sessions, `${name}.jsonl`),
            eventLog,
        });
    } finally {
        await registry.close();
        await extensions.close();
        await rm(root, { recursive: true, force: true });
    }
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function row(registry: AgentRegistry, id: string): RegisteredAgentSummary {
    const found = registry.list().find((agent) => agent.id === id);
    if (found === undefined) throw new Error(`No row for ${id}`);
    return found;
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
}

async function chatWithFiles(context: MoveContext, id = "chat") {
    const agent = await context.registry.create({ id, sessionPath: context.path(id) });
    await mkdir(join(agent.workspace, "drafts"));
    await writeFile(join(agent.workspace, "drafts", "one.md"), "one\n");
    await writeFile(join(agent.workspace, "notes.txt"), "kept\n");
    return agent;
}

test("@core moving an idle chat that a client is attached to carries its files and resumes it in the project", async () => {
    await withMoves(async (context) => {
        const { registry, project, path } = context;
        const before = await chatWithFiles(context);
        const folder = before.workspace;
        const attachment = before.attach();
        expect((await attachment.receive()).type).toBe("history");
        expect(await exists(path("chat"))).toBe(false);

        const outcome = await registry.moveSession("chat", { workspace: project }, context.sessions);

        expect(outcome).toEqual({ status: "moved", workspace: project });
        expect(await readFile(join(project, "notes.txt"), "utf8")).toBe("kept\n");
        expect(await readFile(join(project, "drafts", "one.md"), "utf8")).toBe("one\n");
        expect(await exists(chatFolderPath(path("chat")))).toBe(false);
        const after = registry.find("chat");
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
        expect(after!.workspace).toBe(project);
        expect(after!.workspace).not.toBe(folder);
        expect(row(registry, "chat").workspace).toBe(project);
        expect("chat" in row(registry, "chat")).toBe(false);
        expect((await SessionStore.open(path("chat"))).header.cwd).toBe(project);
        const reattached = after!.attach();
        expect((await reattached.receive()).type).toBe("history");
    });
});

test("@core a chat's top-level name that already exists in the project refuses the move and touches nothing", async () => {
    await withMoves(async (context) => {
        const { registry, project, path } = context;
        const before = await chatWithFiles(context);
        await writeFile(join(project, "notes.txt"), "project notes\n");

        const outcome = await registry.moveSession("chat", { workspace: project }, context.sessions);

        expect(outcome).toEqual({ status: "collision" });
        expect(await readFile(join(project, "notes.txt"), "utf8")).toBe("project notes\n");
        expect((await readdir(project)).sort()).toEqual([".vera", "notes.txt"]);
        expect((await readdir(before.workspace)).sort()).toEqual(["drafts", "notes.txt"]);
        expect(await readFile(join(before.workspace, "notes.txt"), "utf8")).toBe("kept\n");
        expect(registry.find("chat")).toBe(before);
        expect(row(registry, "chat").chat).toBe(true);
        expect(await exists(path("chat"))).toBe(false);
        expect(registry.agents.get("chat")!.store.header.cwd).toBe(before.workspace);
    });
});

test("@core a session that is not a chat moves only its working folder and keeps its agent", async () => {
    await withMoves(async (context) => {
        const { registry, sessions, project, path } = context;
        const other = join(sessions, "..", "other");
        await mkdir(join(other, ".vera", "agents"), { recursive: true });
        await writeFile(join(other, ".vera", "agents", "builder.md"), "---\ndescription: Builds things.\n---\nBuild things.");
        const origin = await realpath(other);
        await writeFile(join(origin, "mine.txt"), "stays\n");
        await registry.create({ id: "plain", workspace: origin, sessionPath: path("plain") });
        await registry.selectAgentFor("plain", "builder");
        expect((await registry.listAgentsFor("plain")).selected).toBe("builder");

        const outcome = await registry.moveSession("plain", { workspace: project }, sessions);

        expect(outcome).toEqual({ status: "moved", workspace: project });
        expect(await readFile(join(origin, "mine.txt"), "utf8")).toBe("stays\n");
        expect(await readdir(project)).toEqual([".vera"]);
        expect(registry.find("plain")!.workspace).toBe(project);
        expect((await registry.listAgentsFor("plain")).selected).toBe("builder");
        const stored = await SessionStore.open(path("plain"));
        expect(stored.header.cwd).toBe(project);
        expect(stored.selectedAgent()?.name).toBe("builder");
    });
});

test("a chat keeps the chat agent through a move", async () => {
    await withMoves(async (context) => {
        const { registry, project, path } = context;
        await chatWithFiles(context);
        await registry.selectAgentFor("chat", "chat");
        expect((await SessionStore.open(path("chat"))).selectedAgent()?.name).toBe("chat");

        expect(await registry.moveSession("chat", { workspace: project }, context.sessions))
            .toEqual({ status: "moved", workspace: project });

        expect((await registry.listAgentsFor("chat")).selected).toBe("chat");
        expect((await SessionStore.open(path("chat"))).selectedAgent()?.name).toBe("chat");
    });
});

test("a move is refused as busy while a prompt is queued or running and succeeds once the turn ends", async () => {
    await withMoves(async (context) => {
        const { registry, project } = context;
        const agent = await chatWithFiles(context);
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "prompt", content: "work" });

        expect(await registry.moveSession("chat", { workspace: project }, context.sessions))
            .toEqual({ status: "busy" });
        expect(await readdir(project)).toEqual([".vera"]);
        expect(registry.find("chat")).toBe(agent);

        while ((await attachment.receive()).type !== "turn_finished") {
            // Consume the turn to its boundary.
        }
        expect(await registry.moveSession("chat", { workspace: project }, context.sessions))
            .toEqual({ status: "moved", workspace: project });
    }, { delayMs: 150 });
});

test("a move is refused as busy while the same id is being moved or trashed", async () => {
    await withMoves(async (context) => {
        const { registry, project } = context;
        await chatWithFiles(context);
        registry.trashingIds.add("chat");
        expect(await registry.moveSession("chat", { workspace: project }, context.sessions))
            .toEqual({ status: "busy" });
        registry.trashingIds.delete("chat");

        registry.startingIds.add("chat");
        expect(await registry.moveSession("chat", { workspace: project }, context.sessions))
            .toEqual({ status: "busy" });
        registry.startingIds.delete("chat");

        const [first, second] = await Promise.all([
            registry.moveSession("chat", { workspace: project }, context.sessions),
            registry.moveSession("chat", { workspace: project }, context.sessions),
        ]);
        expect([first.status, second.status].sort()).toEqual(["busy", "moved"]);
        expect(registry.find("chat")!.workspace).toBe(project);
    });
});

test("an unknown id is not_found for a live move and for a stored move", async () => {
    await withMoves(async ({ registry, project, sessions }) => {
        expect(await registry.moveSession("ghost", { workspace: project }, sessions))
            .toEqual({ status: "not_found" });
        expect(await registry.moveStoredSession("ghost", { workspace: project }, sessions, async () => undefined))
            .toEqual({ status: "not_found" });
        expect(registry.trashingIds.has("ghost")).toBe(false);
        expect(registry.movingIds.has("ghost")).toBe(false);
    });
});

test("a workspace that is relative, missing, a file, the current folder, the chat folder or inside the sessions directory is invalid", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path } = context;
        const chat = await chatWithFiles(context);
        await writeFile(join(project, "a-file"), "x");
        const link = join(sessions, "..", "link-to-chat");
        await symlink(chat.workspace, link);

        const refusals = [
            "project",
            join(project, "missing"),
            join(project, "a-file"),
            chat.workspace,
            join(chat.workspace, "drafts"),
            link,
            sessions,
            join(sessions, "elsewhere"),
        ];
        for (const workspace of refusals) {
            expect(await registry.moveSession("chat", { workspace }, sessions)).toEqual({ status: "invalid" });
        }
        expect((await readdir(chat.workspace)).sort()).toEqual(["drafts", "notes.txt"]);
        expect(registry.find("chat")).toBe(chat);

        await registry.create({ id: "plain", workspace: project, sessionPath: path("plain") });
        expect(await registry.moveSession("plain", { workspace: project }, sessions)).toEqual({ status: "invalid" });
        expect(registry.find("plain")!.workspace).toBe(project);
    });
});

async function seedEventLog(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    await writeFile(modelRequestSnapshotPath(path), `${text}snapshot\n`);
}

test("moving a session carries its event log and model request snapshot to the new folder's key", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, eventLog } = context;
        const before = await chatWithFiles(context);
        const from = eventLog("chat", before.workspace);
        const to = eventLog("chat", project);
        expect(registry.agents.get("chat")!.eventLogPath).toBe(from);
        await seedEventLog(from, "old log\n");

        expect(await registry.moveSession("chat", { workspace: project }, sessions))
            .toEqual({ status: "moved", workspace: project });

        expect(await exists(from)).toBe(false);
        expect(await exists(modelRequestSnapshotPath(from))).toBe(false);
        expect(await readFile(to, "utf8")).toStartWith("old log\n");
        expect(await readFile(modelRequestSnapshotPath(to), "utf8")).toBe("old log\nsnapshot\n");
        expect(registry.agents.get("chat")!.eventLogPath).toBe(to);
    }, { eventLogs: true });
});

test("a move with no event log on disk still moves and the restart logs under the new key", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, eventLog } = context;
        const before = await chatWithFiles(context);
        await rm(eventLog("chat", before.workspace), { force: true });

        expect(await registry.moveSession("chat", { workspace: project }, sessions))
            .toEqual({ status: "moved", workspace: project });

        expect(await exists(eventLog("chat", before.workspace))).toBe(false);
        expect(registry.agents.get("chat")!.eventLogPath).toBe(eventLog("chat", project));
    }, { eventLogs: true });
});

test("an event log already at the new key is left as it was", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, eventLog } = context;
        const before = await chatWithFiles(context);
        const from = eventLog("chat", before.workspace);
        const to = eventLog("chat", project);
        await seedEventLog(from, "old log\n");
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, "already here\n");

        expect(await registry.moveSession("chat", { workspace: project }, sessions))
            .toEqual({ status: "moved", workspace: project });

        expect(await readFile(from, "utf8")).toBe("old log\n");
        expect(await readFile(to, "utf8")).toStartWith("already here\n");
    }, { eventLogs: true });
});

test("a stored session's event log follows it to the new folder's key", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path, eventLog } = context;
        const chat = await chatWithFiles(context);
        const from = eventLog("chat", chat.workspace);
        await registry.renameSession("chat", "saved");
        await registry.closeAgent("chat");
        await seedEventLog(from, "old log\n");

        expect(await registry.moveStoredSession("chat", { workspace: project }, sessions, async () => path("chat")))
            .toEqual({ status: "moved", workspace: project });

        expect(await exists(from)).toBe(false);
        expect(await readFile(eventLog("chat", project), "utf8")).toBe("old log\n");
    }, { eventLogs: true });
});

test("a failed header rewrite puts the chat files and the event log back and restarts the session where it was", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path, eventLog } = context;
        const before = await chatWithFiles(context);
        const from = eventLog("chat", before.workspace);
        await seedEventLog(from, "old log\n");
        // A directory where the temporary copy belongs makes the rewrite fail after the files moved.
        await mkdir(`${path("chat")}.moving`);

        expect(await registry.moveSession("chat", { workspace: project }, sessions))
            .toEqual({ status: "failed" });

        expect((await readdir(before.workspace)).sort()).toEqual(["drafts", "notes.txt"]);
        expect(await readdir(project)).toEqual([".vera"]);
        expect(await readFile(from, "utf8")).toStartWith("old log\n");
        expect(await exists(eventLog("chat", project))).toBe(false);
        expect((await SessionStore.open(path("chat"))).header.cwd).toBe(before.workspace);
        expect(registry.find("chat")!.workspace).toBe(before.workspace);
        expect(registry.agents.get("chat")!.eventLogPath).toBe(from);
        expect(registry.trashingIds.has("chat")).toBe(false);
        expect(registry.movingIds.has("chat")).toBe(false);
    }, { eventLogs: true });
});

test("a stored session moves without a resident agent and its listing follows the new folder", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path } = context;
        const chat = await chatWithFiles(context);
        const folder = chat.workspace;
        await registry.selectAgentFor("chat", "chat");
        await registry.closeAgent("chat");

        const outcome = await registry.moveStoredSession(
            "chat",
            { workspace: project },
            sessions,
            async () => path("chat"),
        );

        expect(outcome).toEqual({ status: "moved", workspace: project });
        expect(registry.find("chat")).toBeUndefined();
        expect(await exists(folder)).toBe(false);
        expect(await readFile(join(project, "notes.txt"), "utf8")).toBe("kept\n");
        const stored = await SessionStore.open(path("chat"));
        expect(stored.header.cwd).toBe(project);
        expect(stored.selectedAgent()?.name).toBe("chat");
        const index = new Map<string, RegisteredAgentSummary>();
        await indexStoredSession(path("chat"), index);
        expect(index.get("chat")?.workspace).toBe(project);
        expect("chat" in index.get("chat")!).toBe(false);
        expect(registry.trashingIds.has("chat")).toBe(false);
        expect(registry.movingIds.has("chat")).toBe(false);
    });
});

test("a stored chat refuses a collision and leaves both folders as they were", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path } = context;
        const chat = await chatWithFiles(context);
        await registry.renameSession("chat", "saved");
        await registry.closeAgent("chat");
        await mkdir(join(project, "drafts"));

        expect(await registry.moveStoredSession("chat", { workspace: project }, sessions, async () => path("chat")))
            .toEqual({ status: "collision" });

        expect((await readdir(chat.workspace)).sort()).toEqual(["drafts", "notes.txt"]);
        expect(await readdir(join(project, "drafts"))).toEqual([]);
        expect((await SessionStore.open(path("chat"))).header.cwd).toBe(chat.workspace);
    });
});

test("trashing a moved session succeeds although its chat folder is gone", async () => {
    let bundled: string[] = [];
    await withMoves(async (context) => {
        const { registry, project, sessions, path } = context;
        await chatWithFiles(context);
        await registry.moveSession("chat", { workspace: project }, sessions);
        expect(await exists(chatFolderPath(path("chat")))).toBe(false);

        expect(await registry.trashSession("chat")).toBe("trashed");

        expect(await exists(path("chat"))).toBe(false);
        expect(await readFile(join(project, "notes.txt"), "utf8")).toBe("kept\n");
        expect(bundled).not.toContain("files");
    }, {
        trash: async (bundle) => {
            bundled = await readdir(bundle);
        },
    });
});

test("trashing a stored session after a stored move succeeds", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path } = context;
        await chatWithFiles(context);
        await registry.renameSession("chat", "saved");
        await registry.closeAgent("chat");
        await registry.moveStoredSession("chat", { workspace: project }, sessions, async () => path("chat"));

        expect(await registry.trashStoredSession("chat", async () => ({
            sessionPath: path("chat"),
            attachmentsPath: `${path("chat")}.attachments`,
            filesPath: chatFolderPath(path("chat")),
        }))).toBe("trashed");

        expect(await exists(path("chat"))).toBe(false);
        expect(await readFile(join(project, "notes.txt"), "utf8")).toBe("kept\n");
    });
});

test("branching a moved session copies no chat folder and the branch is not a chat", async () => {
    await withMoves(async (context) => {
        const { registry, project, sessions, path } = context;
        await chatWithFiles(context);
        await registry.moveSession("chat", { workspace: project }, sessions);

        const branched = await registry.branch({
            sourceId: "chat",
            id: "copy",
            sessionPath: path("copy"),
            position: "at",
        });

        expect(branched!.agent.workspace).toBe(project);
        expect(await exists(chatFolderPath(path("copy")))).toBe(false);
        expect((await SessionStore.open(path("copy"))).header.cwd).toBe(project);
        expect("chat" in row(registry, "copy")).toBe(false);
        expect("chat" in row(registry, "chat")).toBe(false);
    });
});

test("an explicit selection of the default agent in a chat survives a restart", async () => {
    await withMoves(async ({ registry, path }) => {
        await registry.create({ id: "chat", sessionPath: path("chat") });
        await registry.selectAgentFor("chat", "chat");
        expect((await registry.listAgentsFor("chat")).selected).toBe("chat");

        await registry.selectAgentFor("chat", "default");
        await registry.closeAgent("chat");
        await registry.resume({ sessionPath: path("chat") });

        expect((await registry.listAgentsFor("chat")).selected).toBe("default");
        expect((await SessionStore.open(path("chat"))).selectedAgent()?.name).toBe("default");
        expect(row(registry, "chat").chat).toBe(true);
    });
});

import { describe, expect, test } from "bun:test";

import { SESSION_COMMANDS } from "../../clients/ui/src/commands/session-commands.ts";
import { askSession, type SlashSession } from "../../clients/ui/src/composer/slash/host.ts";
import { buildSlashEntries, type SlashEntry } from "../../clients/ui/src/composer/slash/model.ts";
import { requestPill } from "../../clients/ui/src/composer/slash/pillRequests.ts";
import { EXTENSION_BUSY, runSlashEntry, type SlashRunContext } from "../../clients/ui/src/composer/slash/run.ts";
import { parseSlashReply } from "../../clients/ui/src/composer/slash/wire.ts";
import type { DesktopBridge, DesktopEvent } from "../../clients/ui/src/protocol/bridge.ts";
import { renameSession } from "../../clients/ui/src/session/rename.ts";

type Fields = Record<string, unknown>;

interface FakeSession extends SlashSession {
    readonly lines: Fields[];
}

// Answers each line the menu writes with whatever `answer` returns for it, on the matching request id.
function fakeSession(answer: (line: Fields) => Fields | undefined, running = false): FakeSession {
    const listeners = new Set<(event: DesktopEvent) => void>();
    const lines: Fields[] = [];
    const bridge = {
        onEvent: (listener: (event: DesktopEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    } as unknown as DesktopBridge;
    return {
        bridge,
        agentId: "crow-1",
        attached: true,
        running,
        lines,
        send: (text) => {
            const line = JSON.parse(text) as Fields;
            lines.push(line);
            const response = answer(line);
            if (response === undefined) return;
            const requestId = line.requestId ?? line.request_id;
            const key = "request_id" in line ? "request_id" : "requestId";
            const frame = JSON.stringify({ ...response, [key]: requestId });
            for (const listener of listeners) listener({ type: "session_frame", pane: "main", agentId: "crow-1", text: frame });
        },
    };
}

interface Recorded {
    readonly context: SlashRunContext;
    readonly ran: Array<{ command: string; args?: unknown }>;
    readonly notes: string[];
    readonly restored: { count: number };
}

function recorded(session: SlashSession | undefined): Recorded {
    const ran: Recorded["ran"] = [];
    const notes: string[] = [];
    const restored = { count: 0 };
    return {
        ran,
        notes,
        restored,
        context: {
            session,
            run: (command, args) => ran.push(args === undefined ? { command } : { command, args }),
            notify: (text) => notes.push(text),
            restore: () => {
                restored.count += 1;
            },
        },
    };
}

const ENTRIES = buildSlashEntries(
    [{ name: "budget", description: "", usage: "", source: "vera.budget/budget" }],
    [{ name: "scout", description: "" }],
);

function entry(name: string): SlashEntry {
    const found = ENTRIES.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no entry ${name}`);
    return found;
}

describe("running a slash entry", () => {
    test("@core a command the window cannot run says so and sends nothing", async () => {
        const session = fakeSession(() => undefined);
        const { context, notes, ran } = recorded(session);
        for (const name of ["animations", "import", "usage", "reload-extensions", "extension"]) {
            await runSlashEntry(entry(name), "some/file", context);
        }
        expect(notes).toEqual([
            "/animations: Not implemented yet",
            "/import: Not implemented yet",
            "/usage: Not implemented yet",
            "/reload-extensions: Not implemented yet",
            "/extension: Not implemented yet",
        ]);
        expect(ran).toEqual([]);
        expect(session.lines).toEqual([]);
    });

    test("@core a window command runs with its arguments, and a session-only one needs a session", async () => {
        const home = recorded(undefined);
        await runSlashEntry(entry("settings"), "", home.context);
        await runSlashEntry(entry("rename"), "Crow's nest", home.context);
        expect(home.ran).toEqual([{ command: "go.settings" }]);
        expect(home.notes).toEqual(["/rename needs an open session"]);

        const open = recorded(fakeSession(() => undefined));
        await runSlashEntry(entry("rename"), "Crow's nest", open.context);
        await runSlashEntry(entry("clone"), "", open.context);
        expect(open.ran).toEqual([{ command: SESSION_COMMANDS.rename, args: "Crow's nest" }, { command: SESSION_COMMANDS.clone }]);
    });

    test("@core a pill with no mounted control says it is not available", async () => {
        expect(requestPill("effort", "high")).toEqual({ done: false, message: "That control is not available here" });
        const { context, notes } = recorded(undefined);
        await runSlashEntry(entry("effort"), "high", context);
        expect(notes).toEqual(["That control is not available here"]);
    });

    test("an extension command runs on an idle session and shows its result", async () => {
        const session = fakeSession(() => ({
            type: "extension_command_result",
            result: { source: "vera.budget/budget", body: { kind: "text", text: "5 left" } },
        }));
        const { context, notes, restored } = recorded(session);
        await runSlashEntry(entry("budget"), "5", context);
        expect(session.lines).toHaveLength(1);
        expect(session.lines[0]).toMatchObject({ type: "run_extension_command", command: "budget", arguments_text: "5" });
        expect(notes).toEqual(["vera.budget/budget: 5 left"]);
        expect(restored.count).toBe(0);
    });

    test("@core an extension command waits for an idle agent and keeps the typed line", async () => {
        const session = fakeSession(() => undefined, true);
        const { context, notes, restored } = recorded(session);
        await runSlashEntry(entry("budget"), "", context);
        expect(notes).toEqual([EXTENSION_BUSY]);
        expect(restored.count).toBe(1);
        expect(session.lines).toEqual([]);
    });

    test("a failed extension command shows the failure and keeps the typed line", async () => {
        const session = fakeSession(() => ({
            type: "extension_command_failed",
            failure: { source: "vera.budget/budget", reason: "handler_failed", message: "no ledger" },
        }));
        const { context, notes, restored } = recorded(session);
        await runSlashEntry(entry("budget"), "", context);
        expect(notes).toEqual(["vera.budget/budget: no ledger"]);
        expect(restored.count).toBe(1);
    });

    test("@core a skill is sent as an invocation and says nothing when it starts at once", async () => {
        const session = fakeSession(() => ({ type: "skill_invocation_accepted", name: "scout", queued: false, prompt: "/scout the corn" }));
        const { context, notes, restored } = recorded(session);
        await runSlashEntry(entry("scout"), "the corn", context);
        expect(session.lines[0]).toMatchObject({ type: "invoke_skill", name: "scout", argumentsText: "the corn" });
        expect(notes).toEqual([]);
        expect(restored.count).toBe(0);
    });

    test("a skill queued behind a running turn says when it will run", async () => {
        const session = fakeSession(() => ({ type: "skill_invocation_accepted", name: "scout", queued: true, prompt: "/scout" }), true);
        const { context, notes } = recorded(session);
        await runSlashEntry(entry("scout"), "", context);
        expect(notes).toEqual(["/scout will run when this turn ends"]);
    });

    test("@core a rejected skill shows the reason and keeps the typed line", async () => {
        const session = fakeSession(() => ({ type: "skill_invocation_rejected", name: "scout", reason: "Skill scout is not available" }));
        const { context, notes, restored } = recorded(session);
        await runSlashEntry(entry("scout"), "", context);
        expect(notes).toEqual(["Skill scout is not available"]);
        expect(restored.count).toBe(1);
    });

    test("skills and extension commands need a session on New Chat", async () => {
        const { context, notes } = recorded(undefined);
        await runSlashEntry(entry("scout"), "", context);
        await runSlashEntry(entry("budget"), "", context);
        expect(notes).toEqual(["/scout needs an open session", "/budget needs an open session"]);
    });

    test("/agent with no name opens the picker, and with a name asks the host", async () => {
        const none = recorded(fakeSession(() => undefined));
        await runSlashEntry(entry("agent"), "", none.context);
        expect(none.ran).toEqual([{ command: "session.chooseAgent" }]);

        const session = fakeSession(() => ({ type: "agent_selected", name: "scout", notice: "Scout takes over at the next turn" }));
        const named = recorded(session);
        await runSlashEntry(entry("agent"), "scout", named.context);
        expect(session.lines[0]).toMatchObject({ type: "select_agent", name: "scout" });
        expect(named.notes).toEqual(["Scout takes over at the next turn"]);

        const refusing = recorded(fakeSession(() => ({ type: "agent_rejected", reason: "No agent named crow" })));
        await runSlashEntry(entry("agent"), "crow", refusing.context);
        expect(refusing.notes).toEqual(["No agent named crow"]);
    });
});

describe("askSession", () => {
    test("@core the first reply on the request id wins and other frames are ignored", async () => {
        const listeners = new Set<(event: DesktopEvent) => void>();
        const bridge = {
            onEvent: (listener: (event: DesktopEvent) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        } as unknown as DesktopBridge;
        const emit = (agentId: string, pane: "main" | "side", value: unknown): void => {
            for (const listener of listeners) listener({ type: "session_frame", pane, agentId, text: JSON.stringify(value) } as DesktopEvent);
        };
        const answer = askSession(
            { bridge, agentId: "crow-1", send: () => {
                emit("crow-2", "main", { type: "session_name", requestId: "r1", name: "other agent" });
                emit("crow-1", "main", { type: "session_name", requestId: "other", name: "other request" });
                emit("crow-1", "main", { type: "session_name", requestId: "r1", name: "right" });
            } },
            "r1",
            "{}\n",
            parseSlashReply,
        );
        expect(await answer).toEqual({ type: "renamed", requestId: "r1", name: "right" });
        expect(listeners.size).toBe(0);
    });

    test("@core no reply in time resolves undefined and stops listening", async () => {
        const listeners = new Set<(event: DesktopEvent) => void>();
        const bridge = {
            onEvent: (listener: (event: DesktopEvent) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        } as unknown as DesktopBridge;
        const result = await askSession({ bridge, agentId: "crow-1", send: () => undefined }, "r1", "{}\n", parseSlashReply, 5);
        expect(result).toBeUndefined();
        expect(listeners.size).toBe(0);
    });
});

describe("renameSession", () => {
    test("@core a confirmed name comes back, and a rejection becomes a sentence", async () => {
        const ok = fakeSession((line) => ({ type: "session_name", name: String(line.name).trim() }));
        expect(await renameSession(ok, "Crow's nest")).toEqual({ ok: true, name: "Crow's nest" });
        expect(ok.lines[0]).toMatchObject({ type: "update_session_name", name: "Crow's nest" });

        const invalid = fakeSession(() => ({ type: "session_name_rejected", reason: "invalid" }));
        expect(await renameSession(invalid, "")).toEqual({
            ok: false,
            message: "That is not a usable session name. Use 1 to 200 characters.",
        });
        const unavailable = fakeSession(() => ({ type: "session_name_rejected", reason: "unavailable" }));
        expect(await renameSession(unavailable, "x")).toEqual({ ok: false, message: "This session cannot be renamed." });
    });
});

import { afterEach, describe, expect, test } from "bun:test";

import { buildMenuTemplate } from "../../clients/desktop/src/app-menu.ts";
import { SESSION_SHORTCUTS, shortcutCommand, type ShortcutInput } from "../../clients/desktop/src/shortcuts.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerSessionCommands, SESSION_COMMANDS } from "../../clients/ui/src/commands/session-commands.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import { clearActiveSession, publishActiveSession } from "../../clients/ui/src/session/activeSession.ts";
import {
    collectChanges,
    fileFolder,
    fileName,
    lastTurn,
    latestChecklist,
    MAX_CHANGED_FILES,
} from "../../clients/ui/src/session/changes.ts";
import { contextSegments } from "../../clients/ui/src/session/ContextPill.tsx";
import { patchLines } from "../../clients/ui/src/session/DiffRollup.tsx";
import { conversationText } from "../../clients/ui/src/session/conversationText.ts";
import { offerDraft, takeDraft } from "../../clients/ui/src/session/drafts.ts";
import type { Block, ContextState, Presentation, ToolsBlock } from "../../clients/ui/src/session/model.ts";
import { closeCompanion, cyclePaneLayout, openCompanion, paneState, setPaneLayout } from "../../clients/ui/src/session/paneLayout.ts";
import { closeSessionSheet, openedSessionSheet } from "../../clients/ui/src/session/sessionSheets.ts";
import { childRows, companionFor, runningChildCount, unlistedChildTitles } from "../../clients/ui/src/session/subagents.ts";
import { initialWatch } from "../../clients/ui/src/session/transcript.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";

function diffCall(path: string, patch: string, scratch = false): ToolsBlock["calls"][number] {
    const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const presentation: Presentation = { kind: "diff", diff: { path, patch, added, removed, scratch } };
    return { tool: "edit", title: `Edit ${path}`, args: {}, state: "done", presentation };
}

function tools(key: string, calls: ToolsBlock["calls"]): ToolsBlock {
    return { kind: "tools", key, calls, active: false };
}

function row(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace: "/work", status: "idle", live: true, chat: false, ...overrides };
}

describe("changed files", () => {
    test("@core edits to one file merge into one entry in first-touched order", () => {
        const blocks: Block[] = [
            tools("a", [diffCall("/work/src/a.ts", "@@\n+one\n-two"), diffCall("/work/b.ts", "@@\n+x")]),
            { kind: "text", key: "t", text: "done" },
            tools("b", [diffCall("/work/src/a.ts", "@@\n+three")]),
        ];
        const changes = collectChanges(blocks);
        expect(changes.map((change) => change.path)).toEqual(["/work/src/a.ts", "/work/b.ts"]);
        expect(changes[0]).toMatchObject({ added: 2, removed: 1, patches: ["@@\n+one\n-two", "@@\n+three"] });
    });

    test("the list stops at its cap but keeps adding to files already in it", () => {
        const calls = Array.from({ length: MAX_CHANGED_FILES + 5 }, (_, index) => diffCall(`/f/${index}.ts`, "+a"));
        const changes = collectChanges([tools("a", calls), tools("b", [diffCall("/f/0.ts", "+b")])]);
        expect(changes).toHaveLength(MAX_CHANGED_FILES);
        expect(changes[0]?.added).toBe(2);
    });

    test("the last turn is everything after the newest prompt", () => {
        const blocks: Block[] = [
            { kind: "user", key: "u1", text: "first" },
            tools("a", [diffCall("/a", "+a")]),
            { kind: "user", key: "u2", text: "second" },
            tools("b", [diffCall("/b", "+b")]),
        ];
        expect(lastTurn(blocks).map((block) => block.key)).toEqual(["b"]);
        expect(lastTurn([tools("c", [])]).map((block) => block.key)).toEqual(["c"]);
    });

    test("the plan is the newest checklist any call wrote", () => {
        const checklist = (title: string): Presentation => ({
            kind: "checklist",
            checklist: { path: "/plan.md", title, items: [{ text: "step", done: false, justDone: false }] },
        });
        const call = (title: string): ToolsBlock["calls"][number] => ({
            tool: "write",
            title: "Write plan",
            args: {},
            state: "done",
            presentation: checklist(title),
        });
        expect(latestChecklist([tools("a", [call("old")]), tools("b", [call("new")])])?.title).toBe("new");
        expect(latestChecklist([tools("a", [diffCall("/a", "+a")])])).toBeUndefined();
    });

    test("paths read as a name plus a folder relative to the session folder", () => {
        expect(fileName("/work/src/a.ts")).toBe("a.ts");
        expect(fileFolder("/work/src/deep/a.ts", "/work")).toBe("src/deep");
        expect(fileFolder("/work/a.ts", "/work")).toBe("");
        expect(fileFolder("/elsewhere/a.ts", "/work")).toBe("/elsewhere");
    });
});

describe("patch lines", () => {
    test("drops the file headers the row already shows and keeps hunks", () => {
        const patch = "Index: nest.txt\n===================================================================\n--- nest.txt\n+++ nest.txt\n@@ -1,2 +1,2 @@\n-twigs\n+feathers\n mud\n";
        expect(patchLines([patch])).toEqual({ lines: ["@@ -1,2 +1,2 @@", "-twigs", "+feathers", " mud"], cut: false });
    });

    test("cuts long patches at the line cap", () => {
        const patch = Array.from({ length: 450 }, (_, index) => `+line ${index}`).join("\n");
        const result = patchLines([patch]);
        expect(result.cut).toBe(true);
        expect(result.lines).toHaveLength(400);
    });
});

describe("context segments", () => {
    const context = (overrides: Partial<ContextState>): ContextState => ({
        tokens: 1000,
        estimated: false,
        components: [
            { kind: "prompt_contribution", id: "p1", source: "core", displayName: "System prompt", estimatedTokens: 200 },
            { kind: "prompt_contribution", id: "p2", source: "core", displayName: "System prompt", estimatedTokens: 100 },
            { kind: "prompt_contribution", id: "p3", source: "skill", displayName: "Skills", estimatedTokens: 50 },
            { kind: "tool_schema", id: "t1", source: "core", displayName: "read", estimatedTokens: 150 },
            { kind: "message", id: "m1", source: "user", displayName: "You", estimatedTokens: 300 },
        ],
        ...overrides,
    });

    test("@core prompts group by name, and the measured rest shows as Other before free space", () => {
        const segments = contextSegments(context({ capacity: 4000 }));
        expect(segments.map((segment) => [segment.label, segment.tokens])).toEqual([
            ["System prompt", 300],
            ["Skills", 50],
            ["Tool definitions", 150],
            ["Conversation", 300],
            ["Other", 200],
            ["Free space", 3000],
        ]);
    });

    test("without a capacity there is no free space, and no Other when the parts cover the total", () => {
        const segments = contextSegments(context({ tokens: 800 }));
        expect(segments.map((segment) => segment.label)).toEqual(["System prompt", "Skills", "Tool definitions", "Conversation"]);
    });
});

describe("drafts", () => {
    test("a draft is taken once", () => {
        offerDraft("agent-1", "edit me");
        expect(takeDraft("agent-1")).toBe("edit me");
        expect(takeDraft("agent-1")).toBeUndefined();
    });

    test("only the newest sixteen drafts are kept", () => {
        for (let index = 0; index < 20; index += 1) offerDraft(`cap-${index}`, `text ${index}`);
        expect(takeDraft("cap-0")).toBeUndefined();
        expect(takeDraft("cap-3")).toBeUndefined();
        expect(takeDraft("cap-4")).toBe("text 4");
        expect(takeDraft("cap-19")).toBe("text 19");
    });
});

describe("agent panes", () => {
    afterEach(() => closeCompanion());

    test("@core the layout cycles one pane, beside, below", () => {
        expect(paneState().layout).toBe("single");
        cyclePaneLayout();
        expect(paneState().layout).toBe("split");
        cyclePaneLayout();
        expect(paneState().layout).toBe("stack");
        cyclePaneLayout();
        expect(paneState().layout).toBe("single");
    });

    test("opening a subagent splits a single pane and keeps a chosen layout; closing goes back to one", () => {
        openCompanion("parent", "child");
        expect(paneState()).toEqual({ layout: "split", companion: { parentId: "parent", agentId: "child" } });
        setPaneLayout("stack");
        openCompanion("parent", "other");
        expect(paneState().layout).toBe("stack");
        closeCompanion();
        expect(paneState()).toEqual({ layout: "single" });
    });

    test("the second pane shows the chosen subagent, else a running one, else the newest", () => {
        const rows = [
            row("old", { parentId: "p", updatedAt: 1 }),
            row("new", { parentId: "p", updatedAt: 9 }),
            row("busy", { parentId: "p", status: "working", updatedAt: 2 }),
            row("stranger", { parentId: "q", status: "working" }),
        ];
        expect(companionFor("p", { parentId: "p", agentId: "old" }, rows)).toBe("old");
        expect(companionFor("p", { parentId: "q", agentId: "stranger" }, rows)).toBe("busy");
        expect(companionFor("p", undefined, rows.filter((candidate) => candidate.id !== "busy"))).toBe("new");
        expect(companionFor("none", undefined, rows)).toBeUndefined();
    });
});

describe("subagents", () => {
    const rows = [
        row("a", { parentId: "p" }),
        row("b", { parentId: "p", status: "waiting" }),
        row("c", { parentId: "x", status: "working" }),
    ];

    test("children list running ones first", () => {
        expect(childRows(rows, "p").map((child) => child.id)).toEqual(["b", "a"]);
    });

    test("the running count takes the larger of the listing and the session's own count", () => {
        expect(runningChildCount(rows, "p", undefined)).toBe(1);
        expect(runningChildCount(rows, "p", { running: 3, children: [], hasParent: false })).toBe(3);
    });

    test("titles the listing does not carry are reported once each", () => {
        const background = { running: 3, children: ["a", "late", "late"], hasParent: false };
        expect(unlistedChildTitles(background, rows)).toEqual(["late"]);
    });
});

describe("session commands", () => {
    afterEach(() => {
        closeSessionSheet();
        closeCompanion();
        clearActiveSession("agent");
    });

    test("@core sheet commands open their sheet only while a session page is open", () => {
        const registry = new CommandRegistry();
        registerSessionCommands(registry);
        registry.execute(SESSION_COMMANDS.rewind);
        expect(openedSessionSheet()).toBeUndefined();
        publishActiveSession({
            bridge: {} as DesktopBridge,
            agentId: "agent",
            title: "Title",
            chat: false,
            watch: initialWatch("agent"),
            send: () => undefined,
        });
        registry.execute(SESSION_COMMANDS.rewind);
        expect(openedSessionSheet()).toBe("rewind");
        registry.execute(SESSION_COMMANDS.compact);
        expect(openedSessionSheet()).toBe("compact");
    });

    test("layout commands set and cycle the panes, ignoring unknown layouts", () => {
        const registry = new CommandRegistry();
        registerSessionCommands(registry);
        registry.execute(SESSION_COMMANDS.setLayout, "stack");
        expect(paneState().layout).toBe("stack");
        registry.execute(SESSION_COMMANDS.setLayout, "grid");
        expect(paneState().layout).toBe("stack");
        registry.execute(SESSION_COMMANDS.cycleLayout);
        expect(paneState().layout).toBe("single");
    });

    test("the conversation copies as Markdown prompts and replies without tool work", () => {
        const blocks: Block[] = [
            { kind: "user", key: "u", text: "Fix the bug" },
            tools("a", [diffCall("/a", "+a")]),
            { kind: "text", key: "t", text: "Fixed." },
        ];
        expect(conversationText("Bug", blocks)).toBe("# Bug\n\n## You\n\nFix the bug\n\n## Vera\n\nFixed.\n");
    });
});

describe("agent pane shortcut", () => {
    function key(code: string, overrides: Partial<ShortcutInput> = {}): ShortcutInput {
        return { type: "keyDown", code, alt: false, shift: false, control: false, meta: false, isAutoRepeat: false, ...overrides };
    }

    test("Cmd+Alt+A cycles the pane layouts and sits in the View menu", () => {
        expect(shortcutCommand(key("KeyA", { meta: true, alt: true }), "darwin")).toBe(SESSION_COMMANDS.cycleLayout);
        expect(shortcutCommand(key("KeyA", { meta: true }), "darwin")).toBeUndefined();
        const view = buildMenuTemplate("darwin", () => undefined).find((entry) => entry.label === "View");
        if (!Array.isArray(view?.submenu)) throw new Error("The View menu has no items.");
        const entry = view.submenu.find((item) => item.id === SESSION_COMMANDS.cycleLayout);
        expect(entry?.accelerator).toBe(SESSION_SHORTCUTS[0]?.accelerator);
    });
});

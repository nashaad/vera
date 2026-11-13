import { expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import {
    buildCommandItems,
    buildSessionItems,
    commandGroup,
    fuzzyMatch,
    labelSegments,
    PALETTE_LIMIT,
    rankItems,
    sectionRows,
} from "../../clients/ui/src/overlays/palette.ts";

function registryWith(ids: readonly { readonly id: string; readonly title: string; readonly needsArgs?: true }[]): CommandRegistry {
    const registry = new CommandRegistry();
    for (const entry of ids) {
        registry.register({ id: entry.id, title: entry.title, ...(entry.needsArgs ? { needsArgs: true as const } : {}), run() {} });
    }
    return registry;
}

function row(overrides: Partial<SessionRow> & { readonly id: string; readonly name: string }): SessionRow {
    return { workspace: "/Users/nash/Projects/vera", status: "idle", live: false, chat: false, ...overrides };
}

test("@core a prefix or word-start match outranks a scattered match", () => {
    const prefix = fuzzyMatch("set", "Settings");
    const wordStart = fuzzyMatch("sb", "Toggle Sidebar");
    const scattered = fuzzyMatch("cs", "accessories");
    expect(prefix).toBeDefined();
    expect(wordStart).toBeDefined();
    expect(scattered).toBeDefined();
    expect(prefix!.score).toBeGreaterThan(wordStart!.score);
    expect(wordStart!.score).toBeGreaterThan(scattered!.score);
    expect(fuzzyMatch("xyz", "Settings")).toBeUndefined();

    const items = buildCommandItems(
        registryWith([
            { id: "session.cycleLayout", title: "Session Cycle Agent Panes" },
            { id: "go.settings", title: "Settings" },
        ]).list(),
        "darwin",
    );
    const ranked = rankItems(items, "set");
    expect(ranked[0]?.item.id).toBe("go.settings");
    expect(ranked[0]?.indices).toEqual([0, 1, 2]);
});

test("@core command entries leave out commands that need arguments and the palette itself", () => {
    const registry = registryWith([
        { id: "go.newChat", title: "New Chat" },
        { id: "session.open", title: "Open Session", needsArgs: true },
        { id: "palette.commands", title: "Command Palette" },
        { id: "palette.sessions", title: "Go to Session" },
        { id: "layout.toggleSidebar", title: "Toggle Sidebar" },
    ]);
    const items = buildCommandItems(registry.list(), "darwin");
    expect(items.map((item) => item.id)).toEqual(["go.newChat", "layout.toggleSidebar", "palette.sessions"]);
    const sidebar = items.find((item) => item.id === "layout.toggleSidebar");
    expect(sidebar?.keys).toEqual(["⌘", "B"]);
    expect(items.find((item) => item.id === "go.newChat")?.keys).toEqual(["⌘", "N"]);
});

test("command groups follow the id prefix and sort by group, then title", () => {
    expect(commandGroup("go.back")).toBe("Go");
    expect(commandGroup("page.usage")).toBe("Pages");
    expect(commandGroup("layout.togglePanel")).toBe("Window");
    expect(commandGroup("view.open")).toBe("Window");
    expect(commandGroup("container.focus")).toBe("Window");
    expect(commandGroup("session.cycleLayout")).toBe("Session");
    expect(commandGroup("theme.dark")).toBe("Theme");
    expect(commandGroup("help.shortcuts")).toBe("Help");
    expect(commandGroup("palette.sessions")).toBe("Help");
    expect(commandGroup("extension.run")).toBe("Other");

    const items = buildCommandItems(
        registryWith([
            { id: "theme.dark", title: "Dark" },
            { id: "go.settings", title: "Settings" },
            { id: "go.back", title: "Back" },
            { id: "misc.thing", title: "Thing" },
        ]).list(),
        "linux",
    );
    expect(items.map((item) => item.group)).toEqual(["Go", "Go", "Theme", "Other"]);
    expect(items.map((item) => item.label)).toEqual(["Back", "Settings", "Dark", "Thing"]);
    expect(sectionRows(rankItems(items, "")).map((section) => section.title)).toEqual(["Go", "Theme", "Other"]);
});

test("a chat entry says Chat, not its internal folder", () => {
    const [item] = buildSessionItems([row({ id: "c1", name: "Ask crow", workspace: "/h/runtime/sessions/c1.jsonl.files", chat: true })], 0);
    expect(item?.detail).toBe("Chat");
    expect(item?.fields).toEqual(["Ask crow", "Chat"]);
});

test("session entries carry the name, folder, age and a dot only while working or waiting", () => {
    const now = 1_700_000_000_000;
    const items = buildSessionItems(
        [
            row({ id: "a1", name: "Fix the parser", updatedAt: now - 5 * 60_000, status: "working" }),
            row({ id: "b2", name: "Review notes", workspace: "/Users/nash/Projects/other", updatedAt: now - 2 * 3_600_000, status: "waiting" }),
            row({ id: "c3", name: "Done thing", workspace: "", status: "completed" }),
        ],
        now,
    );
    expect(items[0]).toMatchObject({ id: "a1", label: "Fix the parser", detail: "vera", age: "5m", status: "working" });
    expect(items[1]).toMatchObject({ id: "b2", detail: "other", age: "2h", status: "waiting" });
    expect(items[2]?.status).toBeUndefined();
    expect(items[2]?.detail).toBe("No folder");

    const matches = rankItems(items, "other");
    expect(matches.map((entry) => entry.item.id)).toEqual(["b2"]);
    expect(rankItems(items, "vera").map((entry) => entry.item.id)).toEqual(["a1"]);
});

test("@core results are capped at fifty, with and without a query", () => {
    const registry = registryWith(
        Array.from({ length: 80 }, (_, index) => ({ id: `misc.command${index}`, title: `Command ${index}` })),
    );
    const items = buildCommandItems(registry.list(), "darwin");
    expect(PALETTE_LIMIT).toBe(50);
    expect(rankItems(items, "").length).toBe(50);
    expect(rankItems(items, "command").length).toBe(50);
    expect(rankItems(items, "command 7").map((entry) => entry.item.label)[0]).toBe("Command 7");
});

test("label segments split matched and unmatched runs", () => {
    expect(labelSegments("Settings", [0, 1, 2])).toEqual([
        { text: "Set", hit: true },
        { text: "tings", hit: false },
    ]);
    expect(labelSegments("Back", [])).toEqual([{ text: "Back", hit: false }]);
});

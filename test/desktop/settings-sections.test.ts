import { describe, expect, test } from "bun:test";

import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import { agentMeta, scopeLabel } from "../../clients/ui/src/pages/settings/agents.ts";
import { filterSettings } from "../../clients/ui/src/pages/settings/filter.ts";
import { railNarrow } from "../../clients/ui/src/pages/settings/useNarrowRail.ts";
import { filterShortcutGroups } from "../../clients/ui/src/commands/keys.ts";
import { THEME_LABELS, themeFromAttribute, themeSwatch } from "../../clients/ui/src/pages/settings/appearance.ts";
import { FOLDER_LIMIT, folderSummary, workspaceFolders } from "../../clients/ui/src/pages/settings/workspaces.ts";
import { DEFAULT_THEME, THEME_NAMES } from "../../clients/ui/src/theme/tokens.ts";

const sections = [
    { id: "approvals", name: "Approvals", terms: "permission approve deny allow mode grant always" },
    { id: "appearance", name: "Appearance", terms: "theme font density" },
    { id: "providers", name: "Providers", terms: "model provider api key" },
];

describe("filterSettings", () => {
    test("an empty or blank query keeps every section in order", () => {
        expect(filterSettings(sections, "").map((section) => section.id)).toEqual(["approvals", "appearance", "providers"]);
        expect(filterSettings(sections, "   ").map((section) => section.id)).toEqual(["approvals", "appearance", "providers"]);
    });

    test("matches the section name, ignoring case", () => {
        expect(filterSettings(sections, "APPEAR").map((section) => section.id)).toEqual(["appearance"]);
    });

    test("matches keyword terms", () => {
        expect(filterSettings(sections, "api").map((section) => section.id)).toEqual(["providers"]);
        expect(filterSettings(sections, "theme").map((section) => section.id)).toEqual(["appearance"]);
    });

    test("every word must match, in any order", () => {
        expect(filterSettings(sections, "mode permission").map((section) => section.id)).toEqual(["approvals"]);
        expect(filterSettings(sections, "permission theme")).toEqual([]);
    });

    test("a query no section matches returns nothing", () => {
        expect(filterSettings(sections, "zzz")).toEqual([]);
    });
});

function row(id: string, workspace: string, updatedAt?: number): SessionRow {
    return { id, name: id, workspace, status: "idle", live: false, chat: false, ...(updatedAt === undefined ? {} : { updatedAt }) };
}

describe("workspaceFolders", () => {
    test("@core leaves out chats", () => {
        const rows = [{ ...row("c", "/home/runtime/sessions/c.jsonl.files", 900), chat: true }, row("a", "/work/alpha", 100)];
        expect(workspaceFolders(rows)).toEqual(["/work/alpha"]);
    });

    test("@core lists distinct folders, most recently active first, skipping empty folders", () => {
        const rows = [
            row("a", "/work/alpha", 100),
            row("b", "", 500),
            row("c", "/work/beta", 300),
            row("d", "/work/alpha", 400),
            row("e", "/work/gamma", 200),
        ];
        expect(workspaceFolders(rows)).toEqual(["/work/alpha", "/work/beta", "/work/gamma"]);
    });

    test("a folder takes the age of its newest session", () => {
        const rows = [row("a", "/old", 100), row("b", "/new", 300), row("c", "/old", 900)];
        expect(workspaceFolders(rows)).toEqual(["/old", "/new"]);
    });

    test("folders without a time keep the host's order and sort after timed ones", () => {
        const rows = [row("a", "/untimed-first"), row("b", "/timed", 50), row("c", "/untimed-second")];
        expect(workspaceFolders(rows)).toEqual(["/timed", "/untimed-first", "/untimed-second"]);
    });

    test("caps the list at the limit", () => {
        const rows = Array.from({ length: 60 }, (_, index) => row(`s${index}`, `/folder/${index}`, index));
        const folders = workspaceFolders(rows);
        expect(folders.length).toBe(FOLDER_LIMIT);
        expect(folders[0]).toBe("/folder/59");
        expect(workspaceFolders(rows, 2)).toEqual(["/folder/59", "/folder/58"]);
    });

    test("no rows, or only rows without a folder, give an empty list", () => {
        expect(workspaceFolders([])).toEqual([]);
        expect(workspaceFolders([row("a", ""), row("b", "")])).toEqual([]);
    });
});

describe("folderSummary", () => {
    test("counts sessions, marks a partial count, and lower-cases the last activity", () => {
        expect(folderSummary({ sessions: "3", running: "0", needsYou: "0", lastActive: "2h ago" })).toBe("3 sessions · last active 2h ago");
        expect(folderSummary({ sessions: "1", running: "0", needsYou: "0", lastActive: "Now" })).toBe("1 session · last active now");
        expect(folderSummary({ sessions: "50+", running: "0", needsYou: "0", lastActive: "3d ago" })).toBe("50+ sessions · last active 3d ago");
    });
});

describe("filterShortcutGroups", () => {
    const groups = [
        { title: "Window", rows: [{ label: "Toggle Sidebar", chords: [["⌘", "B"]] }, { label: "Toggle Panel", chords: [["⌘", "J"]] }] },
        { title: "Help", rows: [{ label: "Command Palette", chords: [["⌘", "K"]] }] },
    ];

    test("@core keeps the rows whose label has every word of the query", () => {
        expect(filterShortcutGroups(groups, "toggle").map((group) => group.rows.map((item) => item.label))).toEqual([
            ["Toggle Sidebar", "Toggle Panel"],
        ]);
        expect(filterShortcutGroups(groups, "TOGGLE side")).toEqual([{ title: "Window", rows: [groups[0]!.rows[0]!] }]);
    });

    test("drops groups left with no rows and matches nothing for an unknown query", () => {
        expect(filterShortcutGroups(groups, "palette").map((group) => group.title)).toEqual(["Help"]);
        expect(filterShortcutGroups(groups, "zzz")).toEqual([]);
    });

    test("a blank query returns every group unchanged", () => {
        expect(filterShortcutGroups(groups, "  ")).toBe(groups);
    });

    test("matches labels only, not chord keys", () => {
        expect(filterShortcutGroups(groups, "⌘")).toEqual([]);
    });
});

describe("theme helpers", () => {
    test("every theme has a label and a swatch with four colors", () => {
        for (const name of THEME_NAMES) {
            expect(THEME_LABELS[name].length).toBeGreaterThan(0);
            const swatch = themeSwatch(name);
            for (const value of [swatch.surface, swatch.text, swatch.accent, swatch.border]) expect(value.length).toBeGreaterThan(0);
        }
    });

    test("an unknown or missing theme attribute falls back to the default theme", () => {
        expect(themeFromAttribute("light")).toBe("light");
        expect(themeFromAttribute("high-contrast")).toBe("high-contrast");
        expect(themeFromAttribute("neon")).toBe(DEFAULT_THEME);
        expect(themeFromAttribute(null)).toBe(DEFAULT_THEME);
    });
});

describe("agent labels", () => {
    test("scope names read as the person sees them", () => {
        expect(scopeLabel("project")).toBe("This folder");
        expect(scopeLabel("user")).toBe("Your home");
        expect(scopeLabel("extension")).toBe("Extension");
    });

    test("the meta line shows scope, model and effort when present", () => {
        const base = { name: "reviewer", scope: "project" as const, writable: false };
        expect(agentMeta(base)).toBe("This folder");
        expect(agentMeta({ ...base, defaultModel: "model-a", defaultEffort: "high" })).toBe("This folder · model-a · effort high");
        expect(agentMeta({ ...base, scope: "user", defaultEffort: "" })).toBe("Your home");
    });
});

describe("settings rail", () => {
    test("keeps only its icons below 150 space units", () => {
        expect(railNarrow(599, 4)).toBe(true);
        expect(railNarrow(600, 4)).toBe(false);
        expect(railNarrow(700, 5)).toBe(true);
    });

    test("stays whole until the space token is read", () => {
        expect(railNarrow(100, 0)).toBe(false);
        expect(railNarrow(100, Number.NaN)).toBe(false);
    });
});

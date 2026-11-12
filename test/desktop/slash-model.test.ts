import { describe, expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerLayoutCommands } from "../../clients/ui/src/commands/layout-commands.ts";
import { registerNavigationCommands } from "../../clients/ui/src/commands/navigation-commands.ts";
import { OVERLAY_COMMANDS } from "../../clients/ui/src/commands/overlay-ids.ts";
import { registerSessionCommands } from "../../clients/ui/src/commands/session-commands.ts";
import { registerSessionWindowCommands } from "../../clients/ui/src/commands/session-window-commands.ts";
import {
    BUILTIN_SLASH_ENTRIES,
    buildSlashEntries,
    defaultSlashIndex,
    notImplementedMessage,
    resolveSlashLine,
    suggestSlash,
    unknownSlashMessage,
    type SlashEntry,
} from "../../clients/ui/src/composer/slash/model.ts";

const ENTRIES = buildSlashEntries(
    [
        { name: "budget", description: "Show the budget", usage: "/budget [amount]", source: "vera.budget/budget" },
        { name: "model", description: "Shadows a built-in", usage: "", source: "acme/model" },
    ],
    [
        { name: "scout-the-field", description: "Look over the north corn" },
        { name: "scout", description: "Shadows nothing, shares a prefix" },
        { name: "clear", description: "Shadows a built-in alias target" },
        { name: "new", description: "Shadows a built-in alias" },
    ],
);

function names(entries: readonly SlashEntry[]): string[] {
    return entries.map((entry) => entry.name);
}

function entryNamed(name: string): SlashEntry {
    const found = ENTRIES.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no entry ${name}`);
    return found;
}

describe("the slash entries", () => {
    test("@core every terminal built-in is listed once", () => {
        expect(names(BUILTIN_SLASH_ENTRIES)).toEqual([
            "rewind", "fork", "model", "effort", "permissions", "agent", "settings", "nudges", "configure",
            "themes", "animations", "resume", "work", "sidebar", "search", "subagents", "parent", "back",
            "clear", "rename", "import", "clone", "close", "compact", "diagnostics", "extensions",
            "extension", "doctor", "usage", "failure-report", "reload-extensions", "models", "palette",
        ]);
        expect(new Set(names(BUILTIN_SLASH_ENTRIES)).size).toBe(BUILTIN_SLASH_ENTRIES.length);
    });

    test("@core the commands the window cannot run are the five marked unsupported", () => {
        const unsupported = BUILTIN_SLASH_ENTRIES.filter((entry) => entry.action.kind === "unsupported");
        expect(names(unsupported)).toEqual(["animations", "import", "extension", "usage", "reload-extensions"]);
        expect(notImplementedMessage(entryNamed("usage"))).toBe("/usage: Not implemented yet");
    });

    test("@core every built-in that runs a window command names one the window registers", () => {
        const registry = new CommandRegistry();
        registerNavigationCommands(registry, () => {});
        registerLayoutCommands(registry, () => {});
        registerSessionCommands(registry);
        registerSessionWindowCommands(registry, { navigate: () => {}, parentRoute: () => undefined });
        // The overlay commands are registered by the overlay host, which needs a window.
        const overlayIds = new Set(Object.values(OVERLAY_COMMANDS).map((command) => command.id));
        for (const entry of BUILTIN_SLASH_ENTRIES) {
            if (entry.action.kind !== "command") continue;
            const known = registry.has(entry.action.id) || overlayIds.has(entry.action.id);
            expect([entry.name, known]).toEqual([entry.name, true]);
        }
    });

    test("@core the session-only built-ins say so, and the others do not", () => {
        const needing = BUILTIN_SLASH_ENTRIES
            .filter((entry) => entry.action.kind === "command" && entry.action.needsSession === true);
        expect(names(needing)).toEqual(["rewind", "fork", "subagents", "parent", "rename", "clone", "close", "compact"]);
    });

    test("@core an extension or skill that shares a built-in name or alias is left out", () => {
        const extra = ENTRIES.slice(BUILTIN_SLASH_ENTRIES.length);
        expect(names(extra)).toEqual(["budget", "scout-the-field", "scout"]);
        expect(extra.map((entry) => entry.group)).toEqual(["extension", "skill", "skill"]);
        expect(entryNamed("model").group).toBe("built-in");
    });

    test("an extension without usage text is shown as its bare name", () => {
        const [entry] = buildSlashEntries([{ name: "ledger", description: "", usage: "", source: "a/ledger" }], [])
            .slice(-1);
        expect(entry?.usage).toBe("/ledger");
    });
});

describe("suggestSlash", () => {
    test("@core a lone slash lists every entry, grouped built-in, extension, skill", () => {
        const all = suggestSlash(ENTRIES, "/");
        expect(all).toHaveLength(ENTRIES.length);
        const groups = all.map((entry) => entry.group);
        expect(groups).toEqual([...groups].sort((a, b) => order(a) - order(b)));
        expect(names(all).slice(-3)).toEqual(["budget", "scout-the-field", "scout"]);
    });

    test("@core typing narrows by prefix and keeps the groups apart", () => {
        expect(names(suggestSlash(ENTRIES, "/sc"))).toEqual(["scout-the-field", "scout"]);
        expect(names(suggestSlash(ENTRIES, "/se"))).toEqual(["settings", "search"]);
        expect(names(suggestSlash(ENTRIES, "/b"))).toEqual(["back", "budget"]);
        expect(names(suggestSlash(ENTRIES, "/zzz"))).toEqual([]);
    });

    test("@core an alias matches too", () => {
        expect(names(suggestSlash(ENTRIES, "/ne"))).toEqual(["clear"]);
    });

    test("@core there is nothing to suggest once arguments start or the text is not a command", () => {
        expect(suggestSlash(ENTRIES, "/model ")).toEqual([]);
        expect(suggestSlash(ENTRIES, "/model opus")).toEqual([]);
        expect(suggestSlash(ENTRIES, "hello")).toEqual([]);
        expect(suggestSlash(ENTRIES, "")).toEqual([]);
        expect(names(suggestSlash(ENTRIES, "  /mod"))).toEqual(["model", "models"]);
    });

    test("@core the highlighted row is the exact name when one is typed, else the first", () => {
        const model = suggestSlash(ENTRIES, "/model");
        expect(names(model)).toEqual(["model", "models"]);
        expect(defaultSlashIndex(model, "/model")).toBe(0);
        const scout = suggestSlash(ENTRIES, "/scout");
        expect(defaultSlashIndex(scout, "/scout")).toBe(1);
        expect(defaultSlashIndex(suggestSlash(ENTRIES, "/sc"), "/sc")).toBe(0);
        expect(defaultSlashIndex(suggestSlash(ENTRIES, "/new"), "/new")).toBe(0);
    });
});

function order(group: SlashEntry["group"]): number {
    return ["built-in", "extension", "skill"].indexOf(group);
}

describe("resolveSlashLine", () => {
    test("@core an exact name runs with its arguments", () => {
        const line = resolveSlashLine(ENTRIES, "/rename  Crow's nest  ");
        expect(line.kind === "command" && line.entry.name).toBe("rename");
        expect(line.kind === "command" && line.args).toBe("Crow's nest");
    });

    test("@core an alias runs the entry it belongs to", () => {
        const line = resolveSlashLine(ENTRIES, "/new");
        expect(line.kind === "command" && line.entry.name).toBe("clear");
    });

    test("@core a prefix that one command carries runs it, and an ambiguous one does not", () => {
        const sidebar = resolveSlashLine(ENTRIES, "/side");
        expect(sidebar.kind === "command" && sidebar.entry.name).toBe("sidebar");
        const subs = resolveSlashLine(ENTRIES, "/sub");
        expect(subs.kind === "command" && subs.entry.name).toBe("subagents");
        const scout = resolveSlashLine(ENTRIES, "/sc");
        expect(scout.kind).toBe("unknown");
        const mo = resolveSlashLine(ENTRIES, "/mo");
        expect(mo.kind).toBe("unknown");
    });

    test("@core an unknown name keeps the text and suggests the nearest commands", () => {
        const typo = resolveSlashLine(ENTRIES, "/modle ");
        expect(typo).toEqual({ kind: "unknown", message: "Unknown command: /modle. Did you mean /model?" });
        const far = resolveSlashLine(ENTRIES, "/qqqqqqqq");
        expect(far).toEqual({ kind: "unknown", message: "Unknown command: /qqqqqqqq" });
    });

    test("@core a path or plain text is sent as a message", () => {
        expect(resolveSlashLine(ENTRIES, "hello")).toEqual({ kind: "prompt" });
        expect(resolveSlashLine(ENTRIES, "/tmp/a.txt")).toEqual({ kind: "prompt" });
        expect(resolveSlashLine(ENTRIES, "/Users/crow/nest.md please read")).toEqual({ kind: "prompt" });
        expect(resolveSlashLine(ENTRIES, "/")).toEqual({ kind: "prompt" });
    });

    test("an extension command resolves to its own entry", () => {
        const line = resolveSlashLine(ENTRIES, "/budget 5");
        expect(line.kind === "command" && line.entry.action.kind).toBe("extension");
        expect(line.kind === "command" && line.args).toBe("5");
    });
});

describe("unknownSlashMessage", () => {
    test("@core a name that starts several commands lists up to three", () => {
        expect(unknownSlashMessage(ENTRIES, "/re")).toBe("Unknown command: /re. Did you mean /rewind, /resume or /rename?");
    });

    test("@core a one-character slip is matched by edit distance", () => {
        expect(unknownSlashMessage(ENTRIES, "/serch")).toBe("Unknown command: /serch. Did you mean /search?");
        expect(unknownSlashMessage(ENTRIES, "/docter ")).toBe("Unknown command: /docter. Did you mean /doctor?");
    });

    test("@core paths give no message", () => {
        expect(unknownSlashMessage(ENTRIES, "/tmp/a.txt")).toBeUndefined();
        expect(unknownSlashMessage(ENTRIES, "/etc/hosts")).toBeUndefined();
        expect(unknownSlashMessage(ENTRIES, "/./x")).toBeUndefined();
    });
});

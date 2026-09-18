import { describe, expect, test } from "bun:test";

import {
    createHomeState,
    handleHomeKey,
    homeCardLines,
    homeRows,
    HOME_CARD_COLUMNS,
    HOME_TYPING_HINT,
    HOME_WORDMARK,
    type HomeState,
} from "../../clients/tui/home-screen.ts";

const home = (hasSessions = true): HomeState => createHomeState(hasSessions);

const cold = (hasSessions = false): HomeState =>
    createHomeState(hasSessions, true);

const rendered = (state: HomeState): string =>
    homeCardLines(state).map((line) => line.text).join("\n");

/** The column the key hint starts on, which is the run of spaces before it. */
const hintColumn = (text: string): number =>
    text.length - (/\s(\S+)$/.exec(text)?.[1]?.length ?? 0);

/** Labels are the longest of the three, so the hints sit two past them. */
const HOME_HINT_COLUMN = 22;

describe("the home card", () => {
    test("names itself, rules under it, and lists the ways on", () => {
        expect(rendered(home())).toBe(
            [
                "             V  E  R  A",
                "  ────────────────────────────────",
                "",
                "❯ New conversation    enter",
                "  All conversations   Ctrl+R",
                "  Search past work    Ctrl+Shift+F",
                "  Commands            Ctrl+P",
                "",
                "  or just start typing",
            ].join("\n"),
        );
    });

    test("every key hint starts on the same column", () => {
        for (const line of homeCardLines(home())) {
            expect(line.text.length).toBeLessThanOrEqual(HOME_CARD_COLUMNS);
            if (line.tone !== "row") continue;
            expect(hintColumn(line.text)).toBe(HOME_HINT_COLUMN);
        }
        expect(HOME_WORDMARK).toBe("V  E  R  A");
        expect(rendered(home())).toContain(HOME_TYPING_HINT);
    });

    test("the hints hold their column when a row is absent", () => {
        for (const line of homeCardLines(home(false))) {
            if (line.tone !== "row") continue;
            expect(hintColumn(line.text)).toBe(HOME_HINT_COLUMN);
        }
    });

    test("a machine with no conversations has no past to offer", () => {
        const lines = rendered(home(false));
        expect(lines).not.toContain("All conversations");
        expect(lines).not.toContain("Search past work");
        expect(lines).toContain("New conversation");
        expect(lines).toContain("Commands");
    });

    test("a cold machine leads with the way to a provider", () => {
        // The reason comes before the rows, and the row that fixes it stands
        // apart from the rows that cannot work until it does.
        expect(rendered(cold())).toBe(
            [
                "             V  E  R  A",
                "  ────────────────────────────────",
                "",
                "  Vera has no provider yet",
                "",
                "❯ Connect a provider  enter",
                "",
                "  New conversation",
                "  Commands            Ctrl+P",
            ].join("\n"),
        );
    });

    test("the way out is a filled button, and still readable unfilled", () => {
        const row = homeCardLines(cold()).find((line) =>
            line.rowId === "connect"
        );
        // The fill covers the label and the space either side of it, and stops
        // before the key hint.
        expect(row?.text.slice(row.fill?.from, row.fill?.to))
            .toBe(" Connect a provider ");
        // Colour is decoration: the marker and the key say the same thing.
        expect(row?.text).toBe("❯ Connect a provider  enter");
        expect(homeCardLines(cold()).filter((line) => line.fill !== undefined))
            .toHaveLength(1);
    });

    test("the key hints line up whether a row is filled or not", () => {
        const withHints = new Set(
            homeRows(cold()).filter((row) => row.keyHint !== "").map((row) =>
                row.id
            ),
        );
        const lines = homeCardLines(cold()).filter((line) =>
            line.rowId !== undefined && withHints.has(line.rowId)
        );
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(hintColumn(line.text)).toBe(HOME_HINT_COLUMN);
        }
    });

    test("a cold machine offers no caret, having nowhere to send a prompt", () => {
        expect(rendered(cold())).not.toContain(HOME_TYPING_HINT);
        expect(homeCardLines(cold()).some((line) => line.tone === "hint"))
            .toBe(false);
    });

    test("a connected machine says nothing about providers", () => {
        expect(rendered(home())).not.toContain("Connect a provider");
        expect(homeRows(home()).map((row) => row.id)).not.toContain("connect");
    });

    test("the cursor is a text marker, not a colour", () => {
        const selected = homeCardLines(home()).filter((line) =>
            line.selected === true
        );
        expect(selected).toHaveLength(1);
        expect(selected[0]?.text.startsWith("❯ ")).toBe(true);
    });
});

describe("home keys", () => {
    test("enter starts a new conversation", () => {
        expect(handleHomeKey(home(), { name: "return" })).toEqual({
            action: { kind: "new_session" },
            handled: true,
        });
    });

    test("Ctrl+R opens the full session picker", () => {
        expect(handleHomeKey(home(), { name: "r", ctrl: true })).toEqual({
            action: { kind: "resume_picker" },
            handled: true,
        });
    });

    test("r on its own is typed, so no message loses its first word", () => {
        expect(handleHomeKey(home(), { name: "r", sequence: "r" })).toEqual({
            action: { kind: "type", text: "r" },
            handled: true,
        });
    });

    test("Ctrl+R reaches nothing once there is nothing to list", () => {
        expect(handleHomeKey(home(false), { name: "r", ctrl: true }))
            .toEqual({ handled: false });
    });

    test("the search chords belong to the client, not to the card", () => {
        // `Ctrl+Shift+F` searches from anywhere and `Ctrl+F` finds in the
        // conversation, so home answers neither itself and lets both fall
        // through to the one place that owns them. Enter on the row still
        // opens the pane, which is what the row is for.
        expect(handleHomeKey(home(), { name: "f", ctrl: true }))
            .toEqual({ handled: false });
        expect(handleHomeKey(home(), { name: "f", ctrl: true, shift: true }))
            .toEqual({ handled: false });
    });

    test("typing starts a conversation with that character", () => {
        expect(handleHomeKey(home(), { name: "h", sequence: "h" })).toEqual({
            action: { kind: "type", text: "h" },
            handled: true,
        });
        expect(handleHomeKey(home(), { name: "space" })).toEqual({
            action: { kind: "type", text: " " },
            handled: true,
        });
    });

    test("arrows move the cursor and enter runs the row it rests on", () => {
        const moved = handleHomeKey(home(), { name: "down" });
        expect(moved.state?.selectedId).toBe("all");
        expect(handleHomeKey(moved.state!, { name: "return" })).toEqual({
            action: { kind: "resume_picker" },
            handled: true,
        });
        const wrapped = handleHomeKey(home(), { name: "up" });
        expect(wrapped.state?.selectedId).toBe("commands");
    });

    test("the cursor skips the row a new machine does not have", () => {
        const moved = handleHomeKey(home(false), { name: "down" });
        expect(moved.state?.selectedId).toBe("commands");
        expect(homeRows(home(false)).map((row) => row.id)).toEqual([
            "new",
            "commands",
        ]);
    });

    test("enter goes to the provider while one is missing", () => {
        // Both rows would take enter, so only the one that leads out of a
        // machine that cannot answer yet claims it.
        expect(handleHomeKey(cold(), { name: "return" })).toEqual({
            action: { kind: "connect_provider" },
            handled: true,
        });
    });

    test("the conversation row leads to the provider until there is one", () => {
        // Opening a conversation nothing can answer is a dead end, so it goes
        // where the other row goes.
        const moved = handleHomeKey(cold(), { name: "down" });
        expect(moved.state?.selectedId).toBe("new");
        expect(handleHomeKey(moved.state!, { name: "return" })).toEqual({
            action: { kind: "connect_provider" },
            handled: true,
        });
        expect(handleHomeKey(home(), { name: "return" })).toEqual({
            action: { kind: "new_session" },
            handled: true,
        });
    });

    test("a chord home does not claim falls through to the keymap", () => {
        expect(handleHomeKey(home(), { name: "p", ctrl: true })).toEqual({
            handled: false,
        });
        expect(handleHomeKey(home(), { name: "escape" })).toEqual({
            handled: false,
        });
    });
});

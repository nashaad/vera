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

const rendered = (state: HomeState): string =>
    homeCardLines(state).map((line) => line.text).join("\n");

describe("the home card", () => {
    test("names itself, rules under it, and lists the three ways on", () => {
        expect(rendered(home())).toBe(
            [
                "        V  E  R  A",
                "  ───────────────────────",
                "",
                "❯ New conversation    enter",
                "  All conversations  ctrl+r",
                "  Commands           ctrl+p",
                "",
                "  or just start typing",
            ].join("\n"),
        );
    });

    test("every row ends on the same column", () => {
        for (const line of homeCardLines(home())) {
            expect(line.text.length).toBeLessThanOrEqual(HOME_CARD_COLUMNS);
        }
        expect(HOME_WORDMARK).toBe("V  E  R  A");
        expect(rendered(home())).toContain(HOME_TYPING_HINT);
    });

    test("a machine with no conversations has no row to list them", () => {
        const lines = rendered(home(false));
        expect(lines).not.toContain("All conversations");
        expect(lines).toContain("New conversation");
        expect(lines).toContain("Commands");
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

    test("ctrl+r opens the full session picker", () => {
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

    test("ctrl+r reaches nothing once there is nothing to list", () => {
        expect(handleHomeKey(home(false), { name: "r", ctrl: true }))
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

    test("a chord home does not claim falls through to the keymap", () => {
        expect(handleHomeKey(home(), { name: "p", ctrl: true })).toEqual({
            handled: false,
        });
        expect(handleHomeKey(home(), { name: "escape" })).toEqual({
            handled: false,
        });
    });
});

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import {
    createSettingsAnsweringClient,
} from "../../support/settings-answering-client.ts";
import {
    createTuiResumeScenario,
    IDLE_TARGET_TRANSCRIPT,
} from "../../support/tui-resume-child.ts";
import { searchSessions } from "../../../src/store/session-search.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import {
    HOME_CARD_COLUMNS,
    HOME_CONTENT_INDENT,
    HOME_RULE,
    HOME_TYPING_HINT,
} from "../../../clients/tui/home-screen.ts";

/** Home plus the listing, search, and creation hooks its rows reach for. */
function homeDependencies(
    home: string,
    hasSessions: boolean,
    createDelayMs = 0,
): TuiDependencies {
    const scenario = createTuiResumeScenario({ home });
    return {
        ...scenario.dependencies,
        client: createHomeClient("/work/vera"),
        homeHasSessions: hasSessions,
        // The real scan over the transcripts the scenario wrote: home reads
        // what is on disk, and it has no session of its own to read it for.
        searchSessions: (query) => searchSessions(join(home, "sessions"), query),
        createSession: async () => {
            if (createDelayMs > 0) await Bun.sleep(createDelayMs);
            return createSettingsAnsweringClient({
                agentId: "new-session-id",
                model: "new-model",
                mode: "review",
                onCommand: (command, push) => {
                    if (command.type !== "prompt") return;
                    push({
                        type: "user_prompt",
                        content: `SENT ${command.content}`,
                        seq: 1,
                    });
                },
            });
        },
    };
}

test("home paints the card with no composer behind it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        const pane = await session.waitForVisiblePane("V  E  R  A");
        expect(pane).toContain("❯ New conversation");
        expect(pane).toContain("All conversations");
        expect(pane).toContain("Commands");
        expect(pane).toContain("or just start typing");
        // Nothing else is on screen: no composer, and no second invitation
        // from the empty transcript underneath.
        expect(pane).not.toContain("Message Vera");
        expect(pane).not.toContain("Start a conversation with Vera");
        // The status band still says where the next conversation would run.
        expect(pane).toContain("vera");
    } finally {
        await session.close();
    }
}, 15_000);

test("the caret parks one column past the typing hint", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-caret-"));
    const parked: Array<{ x: number; y: number; visible: boolean }> = [];
    const session = await startTuiTestSession({
        home,
        dependencies: (renderer) => {
            const park = renderer.setCursorPosition.bind(renderer);
            renderer.setCursorPosition = (x, y, visible = true) => {
                parked.push({ x, y, visible });
                park(x, y, visible);
            };
            return homeDependencies(home, true);
        },
    });

    try {
        const pane = await session.waitForVisiblePane("V  E  R  A");
        const row = pane.split("\n").findIndex((line) =>
            line.includes(HOME_TYPING_HINT)
        );
        const column = pane.split("\n")[row]!.indexOf(HOME_TYPING_HINT)
            + HOME_TYPING_HINT.length;
        const last = parked[parked.length - 1];
        // One-based, and a space past the hint's last character.
        expect(last).toEqual({ x: column + 2, y: row + 1, visible: true });
    } finally {
        await session.close();
    }
}, 15_000);

test("first run drops the row it has nothing to list for", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-first-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, false),
    });

    try {
        const pane = await session.waitForVisiblePane("V  E  R  A");
        expect(pane).not.toContain("All conversations");
        // With nothing to list, ctrl+r reaches nothing, and r itself is an
        // ordinary character that starts a conversation carrying it.
        session.sendKey("C-r");
        session.sendText("r");
        const started = await session.waitForVisiblePane(
            "Start a conversation with Vera",
        );
        expect(started).not.toContain("V  E  R  A");
        // The composer holds the character rather than its placeholder.
        expect(started).not.toContain("Message Vera");
    } finally {
        await session.close();
    }
}, 15_000);

test("enter on the first row leaves home for a new conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-enter-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Message Vera");
        expect(pane).not.toContain("or just start typing");
    } finally {
        await session.close();
    }
}, 15_000);

test("ctrl+r opens the session picker from home", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-resume-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-r");
        const pane = await session.waitForVisiblePane(
            "Continue the theme picker",
        );
        expect(pane).toContain("The one already open");
    } finally {
        await session.close();
    }
}, 15_000);

test("the home palette offers only what needs no worker", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-palette-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-p");
        const pane = await session.waitForVisiblePane("/themes");
        // No conversation is open, so nothing that would need one is listed,
        // and there is no file behind home to resume.
        expect(pane).not.toContain("Resume this conversation");
        expect(pane).not.toContain("/compact");
        expect(pane).not.toContain("/rewind");
    } finally {
        await session.close();
    }
}, 15_000);

test("typing carries the first character into the new conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-typing-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("h");
        const pane = await session.waitForVisiblePane(
            "Start a conversation with Vera",
        );
        expect(pane).not.toContain("V  E  R  A");
        expect(pane).not.toContain("Message Vera");
        session.sendText("ello");
        const typed = await session.waitForVisiblePane("hello");
        expect(typed).toContain("hello");
    } finally {
        await session.close();
    }
}, 15_000);

test("a sentence typed on home arrives whole", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-sentence-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true, 300),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        // The composer does not exist for most of this: the rest of the
        // sentence would be dropped if home stopped collecting at the first
        // character.
        session.sendText("check the tests");
        const pane = await session.waitForVisiblePane("heck the tests");
        expect(pane).not.toContain("V  E  R  A");
    } finally {
        await session.close();
    }
}, 15_000);

test("enter sent before the composer exists still sends the message", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-early-enter-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true, 300),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        // Both the sentence and the Enter that ends it land while the
        // conversation is still being created.
        session.sendText("send this");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("SENT send this");
        expect(pane).not.toContain("V  E  R  A");
    } finally {
        await session.close();
    }
}, 15_000);

test("the home palette has no command for starting over", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-clear-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-p");
        const pane = await session.waitForVisiblePane("/themes");
        // There is no conversation to clear or to keep running, and the card
        // already has a row for starting one.
        expect(pane).not.toContain("/clear");
        expect(pane).not.toContain("/fresh");
    } finally {
        await session.close();
    }
}, 15_000);

test("the picker opened from home leaves nothing behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-picker-footer-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-r");
        const pane = await session.waitForVisiblePane("⏎ open");
        expect(pane).not.toContain("stop & switch");
        expect(pane).not.toContain("keep running");
    } finally {
        await session.close();
    }
}, 15_000);

test("the card centres on what the rail leaves, not on the terminal", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-rail-"));
    const columns = 100;
    const session = await startTuiTestSession({
        home,
        width: columns,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-e");
        const pane = await session.waitForVisiblePane("[ VERA ]");
        // The rule is the one line of the card drawn to a known width, so it
        // is what says where the card sits.
        const rule = pane.split("\n").find((line) => line.includes(HOME_RULE));
        expect(rule).toBeDefined();
        if (rule === undefined) throw new Error("no rule row");
        // Everything left of the rail's edge belongs to the rail, so the
        // space the card has to centre in starts one column past it. The edge
        // is heavy while the rail holds the keyboard and light when it does
        // not, and it is the same column either way.
        const rail = Math.max(
            rule.indexOf("\u2502"),
            rule.indexOf("\u2503"),
        ) + 1;
        expect(rail).toBeGreaterThan(1);
        // The rule starts at the card's content column, not its left edge.
        const start = rule.indexOf(HOME_RULE) - HOME_CONTENT_INDENT;
        const middle = start + HOME_CARD_COLUMNS / 2;
        // A column of slack: an odd remainder cannot be split evenly.
        expect(Math.abs(middle - (rail + (columns - rail) / 2)))
            .toBeLessThanOrEqual(1);
        expect(start).toBeGreaterThan(rail);
    } finally {
        await session.close();
    }
}, 15_000);

test("ctrl+f searches the transcripts without opening a session", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-home-search-"));
    const session = await startTuiTestSession({
        home,
        dependencies: () => homeDependencies(home, true),
    });

    try {
        await session.waitForVisiblePane("Search past work");
        session.sendKey("C-f");
        await session.waitForVisiblePane("Search · all · this workspace");
        session.sendText("transcript");
        // The hit comes from the seeded session file, so the scan is the real
        // one over real transcripts rather than a stubbed answer.
        const pane = await session.waitForVisiblePane(IDLE_TARGET_TRANSCRIPT);
        expect(pane).not.toContain("Message Vera");
        session.sendKey("Escape");
        const card = await session.waitForVisiblePane("V  E  R  A");
        // Back on the card, and still no conversation: searching costs no
        // worker, the same as landing on home does.
        expect(card).toContain("Search past work");
        expect(card).not.toContain("Message Vera");
    } finally {
        await session.close();
    }
}, 15_000);

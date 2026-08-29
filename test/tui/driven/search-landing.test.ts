import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { emptyUsage } from "../../../src/model/types.ts";
import { TUI_NOTICE } from "../../../clients/tui/state.ts";

const MATCH = "the thing I asked about regenerating";
/** Long enough that the match is nowhere near the end of the session. */
const MESSAGES = 60;
const TARGET = 4;

/**
 * A saved conversation whose match is a message the user typed.
 *
 * The user's own messages are the ones a search lands on most, and they draw
 * as a full-width band rather than through the gutter, so they are the case
 * that proves the marker reaches every kind of block.
 */
function writeSession(path: string, sessionId: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const timestamp = "2026-08-22T11:00:00.000Z";
    const lines = [JSON.stringify({
        type: "session",
        version: 1,
        id: sessionId,
        timestamp,
        cwd: "/work/vera",
    })];
    for (let index = 0; index < MESSAGES; index += 1) {
        const user = index === TARGET;
        lines.push(JSON.stringify({
            type: "message",
            id: `msg-${index}`,
            parentId: index === 0 ? null : `msg-${index - 1}`,
            timestamp,
            message: user
                ? { role: "user", content: [{ type: "text", text: MATCH }] }
                : {
                    role: "assistant",
                    content: [{
                        type: "text",
                        text: `filler line ${index}`,
                    }],
                    source: {
                        provider: "faux",
                        api: "scripted",
                        model: "test",
                    },
                    usage: emptyUsage(),
                    stopReason: "stop",
                },
        }));
    }
    writeFileSync(path, `${lines.join("\n")}\n`);
}

function dependencies(home: string, path: string): TuiDependencies {
    const scenario = createTuiResumeScenario({ home });
    return {
        ...scenario.dependencies,
        client: createHomeClient("/work/vera"),
        homeHasSessions: true,
        searchSessions: async () => ({
            truncated: false,
            results: [{
                session_id: "landing-session-id",
                session_path: path,
                title: "a conversation to land in",
                workspace: "/work/vera",
                updated_at: "2026-08-22T11:00:00.000Z",
                hits: [{
                    kind: "user_message" as const,
                    snippet: MATCH,
                    entry_id: `msg-${TARGET}`,
                }],
            }],
        }),
    };
}

test("the block a search lands on says so, user messages included", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-search-landing-"));
    const path = join(home, "sessions", "landing.jsonl");
    writeSession(path, "landing-session-id");
    const session = await startTuiTestSession({
        home,
        dependencies: () => dependencies(home, path),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendKey("C-f");
        await session.waitForVisiblePane("Search");
        session.sendText("regenerating");
        await session.waitForVisiblePane("a conversation to land in");
        session.sendKey("Enter");

        const pane = await session.waitForVisiblePane(MATCH);
        // The title bar names the session after its first message, so the
        // row wanted here is the band in the transcript, not that one.
        const index = pane.split("\n").findIndex((line) =>
            line.includes(MATCH) && !line.includes("Session:")
        );
        expect(index).toBeGreaterThan(0);

        // A rule down the left edge of the block is the whole mark, so the
        // proof is the colour the row opens with.
        const notice = RGBA.fromHex(TUI_NOTICE).toInts().toString();
        const opening = session.captureSpans().lines[index]?.spans[0];
        expect(opening?.bg?.toInts().toString()).toBe(notice);
    } finally {
        await session.close();
    }
}, 20_000);

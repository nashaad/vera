import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { emptyUsage } from "../../../src/model/types.ts";

const MATCH = "the model regenerates a fresh answer";
const TAIL = "the last thing anyone said here";
/** Long enough that the end of it is nowhere near the match. */
const MESSAGES = 60;
const TARGET = 4;

/** A saved conversation whose match is far above its end. */
function writeLongSession(path: string, sessionId: string): void {
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
        const text = index === TARGET
            ? MATCH
            : index === MESSAGES - 1
                ? TAIL
                : `filler line ${index}`;
        lines.push(JSON.stringify({
            type: "message",
            id: `msg-${index}`,
            parentId: index === 0 ? null : `msg-${index - 1}`,
            timestamp,
            message: {
                role: "assistant",
                content: [{ type: "text", text }],
                source: { provider: "faux", api: "scripted", model: "test" },
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
                session_id: "long-session-id",
                session_path: path,
                title: "a long conversation",
                workspace: "/work/vera",
                updated_at: "2026-08-22T11:00:00.000Z",
                hits: [{
                    kind: "agent_message" as const,
                    snippet: MATCH,
                    // The store's own id for the message. The transcript draws
                    // it as `msg-4#0`, which is what the row carries.
                    entry_id: `msg-${TARGET}`,
                }],
            }],
        }),
    };
}

test("opening a hit lands on the match, not on the end of the session", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-search-open-"));
    const path = join(home, "sessions", "long.jsonl");
    writeLongSession(path, "long-session-id");
    const session = await startTuiTestSession({
        home,
        dependencies: () => dependencies(home, path),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        // The card offers ctrl+shift+f, which only a kitty-protocol terminal
        // encodes. Everywhere else, this one included, it arrives as ctrl+f
        // and opens the same pane: home has no conversation to narrow to.
        session.sendKey("C-f");
        await session.waitForVisiblePane("Search");
        session.sendText("regenerates");
        await session.waitForVisiblePane("a long conversation");
        session.sendKey("Enter");

        const pane = await session.waitForVisiblePane(MATCH);
        // A session opened at its end would show this instead.
        expect(pane).not.toContain(TAIL);
        // The match is at the top of the pane rather than scraping its foot:
        // what follows a match is what someone came to read.
        const lines = pane.split("\n");
        const at = lines.findIndex((line) => line.includes(MATCH));
        expect(at).toBeLessThan(lines.length / 2);

        // This is a transcript-only view, but it is still the conversation on
        // screen and its search chord must not be swallowed by resume routing.
        session.sendKey("C-f");
        const search = await session.waitForVisiblePane("Search ·");
        expect(search).toContain("this conversation");
    } finally {
        await session.close();
    }
}, 20_000);

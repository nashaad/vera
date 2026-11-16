import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { applyAgentUpdate, createTuiState, type TuiState } from "../../clients/tui/state.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { projectTranscript } from "../../src/engine/protocol.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function headers(state: TuiState): string[] {
    return state.entries.flatMap((entry) =>
        entry.kind === "tool_header" && entry.header !== undefined ? [entry.header] : []
    );
}

test("a halted batch appears in the live transcript at the turn checkpoint", async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "vera-halt-live-")));
    const sessionId = basename(workspace);
    const path = join(workspace, "session.jsonl");
    const channel = createInProcessChannel();
    const end = new Error("checkpoint captured");
    let turnFinished = false;
    const endpoint = {
        ...channel.engine,
        send(update: Parameters<typeof channel.engine.send>[0]): void {
            channel.engine.send(update);
            if (update.type === "turn_finished") turnFinished = true;
            if (turnFinished && update.type === "history") throw end;
        },
    };
    let loop: Promise<unknown> | undefined;
    try {
        await writeFile(join(workspace, "a.txt"), "contents of a");
        const store = await SessionStore.create(path, { sessionId, cwd: workspace });
        const response: AssistantMessage = {
            role: "assistant",
            content: [
                { type: "tool_call", id: "a", name: "read", input: { path: "a.txt" } },
                { type: "tool_call", id: "b", name: "edit", input: { path: "b.txt", old_string: "old", new_string: "new" } },
                { type: "tool_call", id: "c", name: "write", input: { path: "c.txt", content: "new" } },
            ],
            source: { provider: "faux", api: "scripted", model: "test" },
            usage: emptyUsage(),
            stopReason: "tool_use",
        };
        let checks = 0;
        loop = runHeadlessLoop(endpoint, new FauxAdapter([response]), "test", undefined, {
            approvalMode: "readonly",
            loadOptionalContext: false,
        }, {
            sessionStore: store,
            haltCheck: () => ++checks >= 3 ? "session blocked" : undefined,
        }).then(() => undefined, (error: unknown) => error);
        channel.client.send({ type: "prompt", content: "read then edit the files" });

        let state = createTuiState();
        let beforeCheckpoint: TuiState | undefined;
        const started: string[] = [];
        const finished: string[] = [];
        const timeout = AbortSignal.timeout(10_000);
        while (true) {
            const update = await channel.client.receive(timeout);
            state = applyAgentUpdate(state, update);
            if (update.type === "tool_started") started.push(update.tool);
            if (update.type === "tool_finished") finished.push(update.tool);
            if (update.type === "turn_finished") beforeCheckpoint = state;
            if (beforeCheckpoint !== undefined && update.type === "history") break;
        }

        expect(started).toEqual(["read"]);
        expect(finished).toEqual(["read"]);
        expect(headers(beforeCheckpoint!)).not.toContain("Did not run");
        expect(headers(state)).toContain("Did not run");
        expect(state.entries.filter((entry) =>
            entry.kind === "tool" && entry.header === "Did not run" && entry.result !== true
        ).map((entry) => entry.text)).toEqual(["Edit b.txt", "Write c.txt"]);
        expect(await loop).toBe(end);

        const reopened = await SessionStore.open(path);
        const results = reopened.messages().filter((message) => message.role === "tool_result");
        expect(results.slice(1).map((result) => result.withheld)).toEqual([true, true]);
        const replayed = applyAgentUpdate(createTuiState(), {
            type: "history",
            entries: projectTranscript(reopened.messages()),
            seq: 1,
        });
        expect(headers(replayed)).toContain("Did not run");
        expect(replayed.entries.filter((entry) =>
            entry.kind === "tool" && entry.header === "Did not run" && entry.result !== true
        ).map((entry) => entry.text)).toEqual(["Edit b.txt", "Write c.txt"]);
    } finally {
        await rm(workspace, { recursive: true, force: true });
        await rm(join(tmpdir(), "vera", sessionId), { recursive: true, force: true });
    }
});

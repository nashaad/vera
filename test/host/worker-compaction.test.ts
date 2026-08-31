import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { FULL_SUMMARY_STRATEGY_ID, fullSummaryStrategy } from
    "../../src/engine/compaction-full-summary.ts";
import type { CompleteText } from "../../src/engine/completion-service.ts";
import type { SessionCompactionOptions } from "../../src/engine/run-turn.ts";
import { startWorker, type WorkerHandle } from "../../src/host/worker/handle.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

/**
 * Compaction's model call is host-side (`compaction.complete`). This is the
 * claim that `/compact` and the automatic trigger actually fire when the loop
 * runs in a worker, which is the default.
 */

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);

const directories: string[] = [];
const liveHome = mkdtempSync(join(tmpdir(), "vera-worker-compaction-"));
const previousVeraHome = process.env.VERA_HOME;

beforeAll(() => {
    process.env.VERA_HOME = join(liveHome, ".vera");
});

afterAll(() => {
    if (previousVeraHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = previousVeraHome;
    rmSync(liveHome, { recursive: true, force: true });
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-compaction-"));
    directories.push(directory);
    return directory;
}

function text(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

const SUMMARY =
    "# Task\nFinish the two jobs.\n\n# State\nBoth rounds completed.\n\n"
    + "# Decisions\nnot stated\n\n# Constraints\nnot stated\n\n# Open\n"
    + "not stated";

function summarizer(): CompleteText {
    return async () => ({
        text: SUMMARY,
        model: "summarizer-test",
        provider: "faux",
    });
}

function compaction(): SessionCompactionOptions {
    return {
        strategy: fullSummaryStrategy,
        models: { summarizer: summarizer() },
        diagnostics: {
            strategy: FULL_SUMMARY_STRATEGY_ID,
            provider: "faux",
            model: "summarizer-test",
        },
    };
}

interface StartedWorker {
    readonly handle: WorkerHandle;
    readonly store: SessionStore;
    readonly updates: AgentUpdate[];
}

async function startAgent(
    id: string,
    bound: SessionCompactionOptions = compaction(),
): Promise<StartedWorker> {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    let push: ((line: number, record: Record<string, unknown>) => void)
        | undefined;
    const store = await SessionStore.create(path, {
        sessionId: id,
        cwd: directory,
        onRecordAppended: (line, record) => push?.(line, record),
    });
    const updates: AgentUpdate[] = [];
    const handle = await startWorker({
        store,
        session: {
            path,
            header: JSON.parse(
                readFileSync(path, "utf8").split("\n")[0] as string,
            ) as Record<string, unknown>,
            records: [],
        },
        model: "test",
        adapter: {
            module: ADAPTER,
            options: { script: [text("first done"), text("second done")] },
        },
        data: { approvalMode: "full_access" },
        services: { compaction: bound },
        onUpdate: (update) => void updates.push(update),
    });
    push = handle.server.pushRecord;
    return { handle, store, updates };
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for the worker");
        }
        await Bun.sleep(25);
    }
}

test("a worker /compact request summarizes through the host", async () => {
    const agent = await startAgent("compact-me");
    try {
        agent.handle.send({
            type: "prompt",
            content: "first job: set up the workspace. " + "alpha ".repeat(800),
        });
        await waitFor(() =>
            agent.store.activeEntries().some((entry) =>
                entry.message.role === "assistant"
            )
        );
        agent.handle.send({
            type: "prompt",
            content: "second job: finish the remaining work. "
                + "beta ".repeat(800),
        });
        await waitFor(() =>
            agent.store.activeEntries().filter((entry) =>
                entry.message.role === "assistant"
            ).length >= 2
        );

        agent.handle.send({ type: "compact", requestId: "ask-1" });
        await waitFor(() =>
            agent.updates.some((update) =>
                update.type === "compaction" && update.phase === "finished"
            )
        );

        const finished = agent.updates.find((update) =>
            update.type === "compaction" && update.phase === "finished"
        );
        expect(finished).toMatchObject({
            type: "compaction",
            phase: "finished",
            outcome: "compacted",
            strategy: FULL_SUMMARY_STRATEGY_ID,
        });
        expect(agent.store.latestCompaction()).toBeDefined();
    } finally {
        agent.handle.kill();
        await agent.handle.outcome;
    }
}, 30_000);

test("a worker cannot start with a strategy it does not have", async () => {
    const agent = await startAgent("unknown-strategy", {
        strategy: {
            id: "ext/custom",
            models: ["summarizer"],
            compact: async () => {
                throw new Error("the host strategy must not run in the worker");
            },
        },
        models: { summarizer: summarizer() },
    });
    try {
        expect(await agent.handle.outcome).toMatchObject({
            kind: "failed",
            error: "Worker cannot reconstruct compaction strategy ext/custom.",
        });
    } finally {
        agent.handle.kill();
        await agent.handle.outcome;
    }
}, 15_000);

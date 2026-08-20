import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    bindCompaction,
    BUNDLED_COMPACTION_STRATEGIES,
} from "../../src/engine/compaction-binding.ts";
import {
    fullSummaryStrategy,
    FULL_SUMMARY_MODEL_SLOT,
} from "../../src/engine/compaction-full-summary.ts";
import {
    compactSession,
    type CompactionSchedulerOptions,
} from "../../src/engine/compaction-scheduler.ts";
import { createRoutedCompletionService } from
    "../../src/engine/completion-service.ts";
import { measureMessages } from "../../src/engine/context-measurement.ts";
import type { ResolvedCompactionProfile } from
    "../../src/config/model-catalog.ts";
import { assertToolCallsPaired } from "../../src/model/tool-pairing.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * The slice end to end: a real session on disk, the shipped strategy, and a
 * summarizer answering through the faux adapter. Nothing here is a stub except
 * the model's words, which is the one part that cannot be real in a test.
 */

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a session whose newest turn alone overflows still compacts, on disk", async () => {
    const store = await agenticSession();
    const seen: ModelRequest[] = [];
    const before = store.modelContext().length;

    const result = await compactSession(
        realOptions(store, seen, summaryText("first")),
        // Tighter than the newest turn, so only an intra-turn seam can fit.
        pressure(store, 6_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    if (result.outcome === "compacted") {
        expect(result.after).toBeLessThan(result.before);
    }
    // The summarizer was actually called, through the real completion service.
    expect(seen.length).toBe(1);

    const context = store.modelContext();
    expect(context.length).toBeLessThan(before);
    expect(firstText(context)).toContain("first");
    assertToolCallsPaired(context, "The compacted context");

    // The durable half: what a resumed session would send.
    const reopened = await SessionStore.open(store.path);
    expect(reopened.modelContext()).toEqual(context);
    expect(reopened.messages()).toEqual(store.messages());
});

test("the file list is carried forward from the tool calls, not the prose", async () => {
    const store = await agenticSession();
    const seen: ModelRequest[] = [];

    await compactSession(
        // A summarizer that mentions no file at all: the list still has to be
        // right, because it is read off the calls rather than the note.
        realOptions(store, seen, "# Task\nSomething happened."),
        // Tight enough that the whole session goes into the span, so every
        // file the run touched is one the note has to account for.
        pressure(store, 2_000),
        new AbortController().signal,
    );

    const note = firstText(store.modelContext());
    expect(note).toContain("# Files");
    expect(note).toContain("Changed:\n- src/edited.ts");
    expect(note).toContain("src/read-1.ts");
    expect(note).toContain("src/read-3.ts");
    // A file that was written is reported as changed, never merely as read.
    expect(note.split("Read:")[1] ?? "").not.toContain("src/edited.ts");
});

test("a second compaction updates the first note instead of re-summarizing it", async () => {
    const store = await agenticSession();
    const first: ModelRequest[] = [];
    await compactSession(
        realOptions(store, first, summaryText("first")),
        pressure(store, 6_000),
        new AbortController().signal,
    );
    // The first pass is asked to write a note, so it gets no prior one.
    expect(promptOf(first[0])).not.toContain("<note>");

    await appendToolRound(store, 2, "src/later.ts");
    await appendUser(store, "and now this");

    const second: ModelRequest[] = [];
    const result = await compactSession(
        realOptions(store, second, summaryText("second")),
        pressure(store, 6_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    const prompt = promptOf(second[0]);
    // Anchored: the previous note is handed over as a note to update, and the
    // span it already stood for is not sent again.
    expect(prompt).toContain("<note>");
    expect(prompt).toContain("first");
    expect(prompt).not.toContain("src/read-1.ts");
    expect(prompt).toContain("src/later.ts");

    // The mechanical list survives the update even though the model rewrote
    // the prose around it.
    const note = firstText(store.modelContext());
    expect(note).toContain("src/edited.ts");
    expect(note).toContain("src/later.ts");
});

test("the summarizer never sees the strategy's own file block as prose", async () => {
    const store = await agenticSession();
    await compactSession(
        realOptions(store, [], summaryText("first")),
        pressure(store, 6_000),
        new AbortController().signal,
    );
    await appendToolRound(store, 2, "src/later.ts");
    await appendUser(store, "next");

    const second: ModelRequest[] = [];
    await compactSession(
        realOptions(store, second, summaryText("second")),
        pressure(store, 6_000),
        new AbortController().signal,
    );

    const note = between(promptOf(second[0]), "<note>", "</note>");
    // The block is rebuilt by code each time, so handing it to the model would
    // invite it to edit a list it does not own.
    expect(note).not.toContain("# Files");
    expect(note).toContain("first");
});

test("retained_user_turns reaches the ladder from a resolved config profile", async () => {
    const store = await agenticSession();
    const profile: ResolvedCompactionProfile = {
        strategy: fullSummaryStrategy.id,
        slots: { [FULL_SUMMARY_MODEL_SLOT]: [catalogModel()] },
        routes: { [FULL_SUMMARY_MODEL_SLOT]: "summarizer" },
        retained_user_turns: 1,
    };
    const bound = bindCompaction(
        profile,
        summarizerAdapter([], summaryText("configured")),
        { provider: "faux", model: "test" },
        BUNDLED_COMPACTION_STRATEGIES,
    );

    expect(bound?.retainedUserTurns).toBe(1);

    const result = await compactSession(
        {
            store,
            strategy: bound!.strategy,
            models: bound!.models,
            retainedUserTurns: bound!.retainedUserTurns!,
        },
        // Roomy: two turns would fit, so keeping one proves the key applied.
        pressure(store, 20_000),
        new AbortController().signal,
    );

    expect(result.outcome).toBe("compacted");
    const users = store.modelContext()
        .filter((message) => message.role === "user");
    // The note plus exactly one retained turn.
    expect(users.length).toBe(2);
});

test("compaction still refuses rather than break a session it cannot shrink", async () => {
    const store = await agenticSession();
    const result = await compactSession(
        realOptions(store, [], summaryText("no room")),
        // The fixed overhead alone swallows the target.
        { tokens: 400_000, capacity: 10_000, estimated: true },
        new AbortController().signal,
    );

    expect(result.outcome).toBe("no_boundary");
    // Refusing leaves the session exactly as it was, uncompacted but intact.
    expect(store.latestCompaction()).toBeUndefined();
});

/** A session shaped like a real agentic one: prompts wrapped around tool loops. */
async function agenticSession(): Promise<SessionStore> {
    const directory = mkdtempSync(join(tmpdir(), "vera-ladder-e2e-"));
    temporaryDirectories.push(directory);
    const store = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "session-1",
        cwd: directory,
    });
    await appendUser(store, "set the project up");
    await appendAssistant(store, `plenty of early reasoning ${filler(400)}`);
    await appendUser(store, "now do the long piece of work");
    for (let round = 1; round <= 3; round += 1) {
        await appendToolRound(store, round, `src/read-${round}.ts`);
    }
    await appendEditRound(store, "src/edited.ts");
    await appendAssistant(store, `finished the work ${filler(200)}`);
    return store;
}

async function appendUser(store: SessionStore, text: string): Promise<void> {
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
    });
}

async function appendAssistant(
    store: SessionStore,
    text: string,
): Promise<void> {
    await store.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    });
}

async function appendToolRound(
    store: SessionStore,
    round: number,
    path: string,
): Promise<void> {
    const id = `call-read-${round}-${path}`;
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "text", text: `reading ${path} ${filler(150)}` },
            { type: "tool_call", id, name: "read", input: { path } },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    });
    await store.appendMessage({
        role: "tool_result",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: `contents of ${path} ${filler(150)}` }],
        isError: false,
    });
}

async function appendEditRound(
    store: SessionStore,
    path: string,
): Promise<void> {
    const id = `call-edit-${path}`;
    await store.appendMessage({
        role: "assistant",
        content: [
            { type: "text", text: `editing ${path} ${filler(150)}` },
            {
                type: "tool_call",
                id,
                name: "edit",
                input: { path, old: "a", new: "b" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    });
    await store.appendMessage({
        role: "tool_result",
        toolCallId: id,
        toolName: "edit",
        content: [{ type: "text", text: `wrote ${path}` }],
        isError: false,
    });
}

function filler(words: number): string {
    return "detail ".repeat(words);
}

/** The shipped strategy, bound to a summarizer that answers through faux. */
function realOptions(
    store: SessionStore,
    seen: ModelRequest[],
    answer: string,
): CompactionSchedulerOptions {
    const adapter = summarizerAdapter(seen, answer);
    return {
        store,
        strategy: fullSummaryStrategy,
        models: {
            [FULL_SUMMARY_MODEL_SLOT]: createRoutedCompletionService(adapter, {
                models: [{ provider: "faux", model: "test" }],
            }),
        },
    };
}

/**
 * Records what the summarizer was asked, then answers it. The recording is the
 * only way to prove the anchored prompt is the one that went out.
 */
function summarizerAdapter(
    seen: ModelRequest[],
    answer: string,
): ModelAdapter {
    return {
        stream(request) {
            seen.push(request);
            return new FauxAdapter([summaryResponse(answer)]).stream(request);
        },
    };
}

function summaryResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function summaryText(marker: string): string {
    return `# Task\nThe ${marker} note.\n\n# State\nWork is under way.`;
}

function catalogModel() {
    return {
        name: "summarizer_faux",
        provider: "faux" as const,
        model: "test",
    };
}

const FIXED_OVERHEAD = 200;

function pressure(store: SessionStore, capacity: number) {
    return {
        tokens: measureMessages(store.modelContext()) + FIXED_OVERHEAD,
        capacity,
        estimated: true,
    };
}

function firstText(context: readonly ModelMessage[]): string {
    const block = context[0]?.content[0];
    return block !== undefined && block.type === "text" ? block.text : "";
}

function promptOf(request: ModelRequest | undefined): string {
    const block = request?.messages[0]?.content[0];
    return block !== undefined && block.type === "text" ? block.text : "";
}

function between(text: string, open: string, close: string): string {
    const start = text.indexOf(open);
    const end = text.indexOf(close);
    return start === -1 || end === -1 ? "" : text.slice(start + open.length, end);
}

test("a summarizer's own Files heading does not truncate the note it anchors on", async () => {
    const store = await agenticSession();
    // A span with no path-carrying tool call, so the mechanical block is empty
    // and the only `# Files` in the note is the model's own.
    await appendUser(store, "just think about it");
    await appendAssistant(
        store,
        "# Task\nThink.\n\n# Files\nNone yet.\n\n# Open\nWhich approach?",
    );

    await compactSession(
        realOptions(
            store,
            [],
            "# Task\nThink.\n\n# Files\nNone yet.\n\n# Open\nWhich approach?",
        ),
        pressure(store, 2_000),
        new AbortController().signal,
    );
    await appendToolRound(store, 9, "src/after.ts");
    await appendUser(store, "carry on");

    const second: ModelRequest[] = [];
    await compactSession(
        realOptions(store, second, summaryText("second")),
        pressure(store, 6_000),
        new AbortController().signal,
    );

    // Everything below the model's heading survived into the anchor.
    const note = between(promptOf(second[0]), "<note>", "</note>");
    expect(note).toContain("# Open");
    expect(note).toContain("Which approach?");
});

test("a path holding a comma survives the round trip whole", async () => {
    const store = await agenticSession();
    await appendToolRound(store, 8, "src/data/a,b.csv");
    await appendUser(store, "keep going");

    await compactSession(
        realOptions(store, [], summaryText("first")),
        pressure(store, 6_000),
        new AbortController().signal,
    );
    await appendToolRound(store, 9, "src/other.ts");
    await appendUser(store, "and again");
    await compactSession(
        realOptions(store, [], summaryText("second")),
        pressure(store, 6_000),
        new AbortController().signal,
    );

    const note = firstText(store.modelContext());
    expect(note).toContain("- src/data/a,b.csv");
    // The halves of a split path would show up as files of their own.
    expect(note).not.toContain("- src/data/a\n");
    expect(note).not.toContain("- b.csv");
});

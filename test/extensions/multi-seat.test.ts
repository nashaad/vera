import { expect, test } from "bun:test";
import { join } from "node:path";

import {
    startClientExtensionRegistry,
    type ClientExtensionRegistry,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraClientConsultRequest,
    VeraClientTranscriptBlock,
} from "../../src/sdk/extensions.ts";

const EXTENSION = join(
    import.meta.dir,
    "../../examples/extensions/multi-seat",
);
const WORKSPACE = "/tmp/workspace";

interface Harness {
    readonly registry: ClientExtensionRegistry;
    readonly consults: VeraClientConsultRequest[];
    readonly blocks: VeraClientTranscriptBlock[];
    readonly notices: string[];
    readonly sidebar: { open: boolean; readonly blocks: VeraClientTranscriptBlock[] };
    /** The last list of names the extension offered the composer. */
    readonly mentions: string[];
    /** Resolves once every consult fired so far has posted its block. */
    settle(): Promise<void>;
}

async function start(): Promise<Harness> {
    const consults: VeraClientConsultRequest[] = [];
    const blocks: VeraClientTranscriptBlock[] = [];
    const notices: string[] = [];
    const answers: Promise<unknown>[] = [];
    let mentions: string[] = [];
    const sidebar: {
        open: boolean;
        readonly blocks: VeraClientTranscriptBlock[];
    } = { open: false, blocks: [] };
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: EXTENSION, enabled: true, config: null }],
        preferences: {
            async get() {
                return undefined;
            },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            current: () => undefined,
            async update() {
                return { status: "rejected" as const, reason: "unavailable" as const };
            },
            subscribe: () => () => {},
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
        notice: { post: (_id, text) => notices.push(text) },
        mentions: {
            set(_id, names) {
                mentions = [...names];
            },
        },
        transcript: { append: (_id, block) => blocks.push(block) },
        sidebar: {
            open() {
                sidebar.open = true;
            },
            append: (_id, block) => sidebar.blocks.push(block),
            clear() {
                sidebar.blocks.length = 0;
            },
            close() {
                sidebar.open = false;
            },
        },
        consult: {
            request(_id, request) {
                consults.push(request);
                const answer = Promise.resolve({
                    text: `${request.model} says so`,
                    model: request.model,
                });
                answers.push(answer);
                return answer;
            },
        },
        onFailure(failure) {
            throw new Error(`${failure.extensionId}: ${failure.message}`);
        },
    });
    return {
        registry,
        consults,
        get mentions() {
            return mentions;
        },
        blocks,
        notices,
        sidebar,
        async settle() {
            await Promise.all(answers);
            // One more turn of the loop, so the block posted after the await
            // has landed.
            await Bun.sleep(0);
        },
    };
}

test("with no seats added every message goes straight to the agent", async () => {
    const harness = await start();
    expect(await harness.registry.interceptMessage({
        text: "hello",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.consults).toEqual([]);
    await harness.registry.close();
});

test("an addressed message goes to that seat alone, and only that one", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("add", "gpt-5.5 as m1", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@m1 what do you think",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    await harness.settle();
    expect(harness.consults.map((request) => request.model)).toEqual(["gpt-5.5"]);
    expect(harness.sidebar.open).toBe(true);
    expect(harness.sidebar.blocks).toEqual([
        // Seating the model fills the column before it has said anything.
        { label: "m1 (gpt-5.5)", text: "Seated. Ask with @m1, or @all." },
        // What was asked is filed beside what came back.
        { label: "you \u2192 @m1", text: "what do you think" },
        { label: "m1 (gpt-5.5)", text: "gpt-5.5 says so" },
    ]);
    // The transcript stays the agent's: the seats talk beside it.
    expect(harness.blocks).toEqual([]);

    // Addressing a seat is per message: the next one goes to the agent.
    expect(await harness.registry.interceptMessage({
        text: "say more",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({
        kind: "replace",
        text: "[m1 (gpt-5.5) replied:]\ngpt-5.5 says so\n\nsay more",
    });
    await harness.settle();
    expect(harness.consults).toHaveLength(1);
    await harness.registry.close();
});

test("seats are offered to the composer as mentions", async () => {
    const harness = await start();
    expect(harness.mentions).toEqual([]);

    await harness.registry.invokeCommand("add", "gpt-5.5 as m1", WORKSPACE);
    expect(harness.mentions).toEqual(["m1", "all"]);

    await harness.registry.invokeCommand("add", "glm-5.2 as m2", WORKSPACE);
    expect(harness.mentions).toEqual(["m1", "m2", "all"]);

    await harness.registry.invokeCommand("drop", "m1", WORKSPACE);
    expect(harness.mentions).toEqual(["m2", "all"]);
    await harness.registry.close();
});

test("@all asks every seat at once and hands the agent the same message", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("add", "gpt-5.5 as m1", WORKSPACE);
    await harness.registry.invokeCommand("add", "glm-5.2 as m2", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@all which way",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "replace", text: "which way" });
    await harness.settle();
    expect(harness.consults.map((request) => request.model))
        .toEqual(["gpt-5.5", "glm-5.2"]);
    expect(harness.sidebar.blocks.map((block) => block.text))
        .toEqual([
            "Seated. Ask with @m1, or @all.",
            "Seated. Ask with @m2, or @all.",
            "which way",
            "which way",
            "gpt-5.5 says so",
            "glm-5.2 says so",
        ]);
    await harness.registry.close();
});

test("the agent's next message carries the replies it has not seen", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("add", "gpt-5.5 as m1", WORKSPACE);
    await harness.registry.interceptMessage({
        text: "@m1 what do you think",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();

    const decision = await harness.registry.interceptMessage({
        text: "@agent go with that",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    expect(decision).toEqual({
        kind: "replace",
        text: "[m1 (gpt-5.5) replied:]\ngpt-5.5 says so\n\ngo with that",
    });

    // Quoted once: the agent has read it now.
    expect(await harness.registry.interceptMessage({
        text: "and then",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "replace", text: "and then" });
    await harness.registry.close();
});

test("a seat sees what the other seat said before answering again", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("add", "gpt-5.5 as m1", WORKSPACE);
    await harness.registry.invokeCommand("add", "glm-5.2 as m2", WORKSPACE);

    await harness.registry.interceptMessage({
        text: "@m1 open",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    await harness.registry.interceptMessage({
        text: "@m2 respond",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();

    expect(harness.consults[1]?.messages).toEqual([{
        role: "user",
        content: "[m1 (gpt-5.5) replied:]\ngpt-5.5 says so\n\nrespond",
    }]);
    await harness.registry.close();
});

test("a message for an unknown seat is held rather than sent to the agent", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("add", "gpt-5.5 as m1", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@m9 hello",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    expect(harness.consults).toEqual([]);
    expect(harness.notices).toContain("No seat named @m9");
    await harness.registry.close();
});

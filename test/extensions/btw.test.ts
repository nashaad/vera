import { expect, test } from "bun:test";
import { join } from "node:path";

import {
    startClientExtensionRegistry,
    type ClientExtensionRegistry,
} from "../../src/extensions/client-registry.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import type {
    VeraClientConsultRequest,
    VeraClientTranscriptBlock,
} from "../../src/sdk/extensions.ts";

const EXTENSION = join(
    import.meta.dir,
    "../../examples/extensions/btw",
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
    /** The name the composer is showing, or undefined for the agent. */
    readonly addressee: string | undefined;
    /** What the thread adapter hands the extension; tests mutate it. */
    readonly thread: { role: "user" | "assistant"; text: string }[];
    /** Resolves once every consult fired so far has posted its block. */
    settle(): Promise<void>;
}

async function start(config: JsonValue = null): Promise<Harness> {
    const consults: VeraClientConsultRequest[] = [];
    const blocks: VeraClientTranscriptBlock[] = [];
    const notices: string[] = [];
    const answers: Promise<unknown>[] = [];
    let mentions: string[] = [];
    let addressee: string | undefined;
    const thread: { role: "user" | "assistant"; text: string }[] = [];
    const sidebar: {
        open: boolean;
        readonly blocks: VeraClientTranscriptBlock[];
    } = { open: false, blocks: [] };
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: EXTENSION, enabled: true, config }],
        preferences: {
            async get() {
                return undefined;
            },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            // A pool with the models the tests seat, so `/add` can resolve
            // them: an unpooled name is refused.
            current: () => ({
                provider: "openai",
                model: "gpt-5.5",
                pooled: [
                    { provider: "openai", model: "gpt-5.5", label: "gpt-5.5", available: true, verified: true, levels: [] },
                    { provider: "zai", model: "glm-5.2", label: "glm-5.2", available: true, verified: true, levels: [] },
                    { provider: "ollama", model: "down-model", label: "down-model", available: true, verified: true, levels: [] },
                ],
            }),
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
        addressing: {
            set(_id, name) {
                addressee = name;
            },
        },
        thread: { read: () => thread.map((turn) => ({ ...turn })) },
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
                const answer = request.model === "down-model"
                    ? Promise.reject(new Error("provider is down"))
                    : Promise.resolve({
                        text: `${request.model} says so`,
                        model: request.model,
                    });
                answers.push(answer.catch(() => undefined));
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
        get addressee() {
            return addressee;
        },
        thread,
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

test("with no sidekick every message goes straight to the agent", async () => {
    const harness = await start();
    expect(await harness.registry.interceptMessage({
        text: "hello",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.consults).toEqual([]);
    await harness.registry.close();
});

test("an addressed message goes to the sidekick alone", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@sidekick what do you think",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    await harness.settle();
    expect(harness.consults.map((request) => request.model)).toEqual(["gpt-5.5"]);
    expect(harness.sidebar.open).toBe(true);
    expect(harness.sidebar.blocks).toEqual([
        // Seating the model fills the column before it has said anything.
        {
            label: "sidekick (gpt-5.5)",
            text: "Seated. Ask with @sidekick, or @all.",
        },
        // What was asked is filed beside what came back.
        {
            label: "you \u2192 @sidekick",
            text: "what do you think",
            speaker: "you",
        },
        {
            label: "sidekick (gpt-5.5)",
            text: "gpt-5.5 says so",
            speaker: "sidekick",
        },
    ]);
    // The transcript stays the agent's: the sidekick talks beside it.
    expect(harness.blocks).toEqual([]);

    // Addressing it is per message: the next one goes to the agent.
    expect(await harness.registry.interceptMessage({
        text: "say more",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    await harness.settle();
    expect(harness.consults).toHaveLength(1);
    await harness.registry.close();
});

test("the brief carries the tail of the thread, unchanged when the thread is", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);

    // An empty thread: the brief is just the standing instructions.
    await harness.registry.interceptMessage({
        text: "@sidekick hello",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    const bare = harness.consults[0]?.systemPrompt;
    // The seat is told who it is: reading the thread without that, a
    // small model answers as the agent whose conversation it is.
    expect(bare).toContain("You are the sidekick, an advisor");
    expect(bare).not.toContain("main thread so far");

    // Fourteen turns in the thread: the brief quotes the last twelve.
    for (let index = 0; index < 7; index += 1) {
        harness.thread.push({ role: "user", text: `question ${index}` });
        harness.thread.push({ role: "assistant", text: `answer ${index}` });
    }
    await harness.registry.interceptMessage({
        text: "@sidekick and now",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    const brief = harness.consults[1]?.systemPrompt;
    expect(brief).toContain("User: question 1\n\nAgent: answer 1");
    expect(brief).toContain("Agent: answer 6");
    expect(brief).not.toContain("question 0");

    // The thread did not move: the brief is the same string, so the
    // provider's prompt cache stays warm.
    await harness.registry.interceptMessage({
        text: "@sidekick once more",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    expect(harness.consults[2]?.systemPrompt).toBe(brief as string);
    await harness.registry.close();
});

test("a failed consult files into the column, and the lane keeps the ask", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "down-model", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@sidekick you there",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    await harness.settle();
    expect(harness.sidebar.blocks).toEqual([
        {
            label: "sidekick (down-model)",
            text: "Seated. Ask with @sidekick, or @all.",
        },
        { label: "you \u2192 @sidekick", text: "you there", speaker: "you" },
        // The failure reads in place, where the answer would have been.
        {
            label: "sidekick (down-model)",
            text: "Could not answer: provider is down",
            speaker: "sidekick",
        },
    ]);
    // The agent hears nothing, failure or answer alike.
    expect(await harness.registry.interceptMessage({
        text: "moving on",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    await harness.registry.close();
});

test("no model named seats the one already answering", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "", WORKSPACE);
    await harness.registry.interceptMessage({
        text: "@sidekick hello",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    expect(harness.consults[0]?.model).toBe("gpt-5.5");
    await harness.registry.close();
});

test("the seat is taken until it is freed", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    // One seat is the whole design, so a second `/consult` is a mistake worth
    // naming rather than a silent swap that drops the lane.
    expect(harness.registry.invokeCommand("btw", "glm-5.2", WORKSPACE))
        .rejects.toThrow("/remove frees the seat");
    await harness.registry.invokeCommand("remove", "", WORKSPACE);
    await harness.registry.invokeCommand("btw", "glm-5.2", WORKSPACE);
    await harness.registry.interceptMessage({
        text: "@sidekick hello",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    expect(harness.consults[0]?.model).toBe("glm-5.2");
    await harness.registry.close();
});

test("a model that is not in the pool cannot be seated", async () => {
    const harness = await start();
    // The pool is what a seat can be: an id typed from memory has no provider
    // behind it, so it would be sent to the default one and rejected there.
    expect(harness.registry.invokeCommand("btw", "gpt-9", WORKSPACE))
        .rejects.toThrow("not in the model pool");
    await harness.registry.close();
});

test("the sidekick is consulted at the provider its pool entry names", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "glm-5.2", WORKSPACE);
    await harness.registry.interceptMessage({
        text: "@sidekick hello",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();
    expect(harness.consults[0]?.provider).toBe("zai");
    await harness.registry.close();
});

test("removing the sidekick takes its column with it", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    await harness.registry.invokeCommand("remove", "", WORKSPACE);
    expect(harness.mentions).toEqual([]);
    expect(harness.sidebar.open).toBe(false);
    expect(harness.notices.at(-1)).toBe("@sidekick left");
    await harness.registry.close();
});

test("removing nobody says so rather than passing quietly", async () => {
    const harness = await start();
    expect(harness.registry.invokeCommand("remove", "", WORKSPACE))
        .rejects.toThrow("No sidekick");
    await harness.registry.close();
});

test("the agent is never told the sidekick joined or left", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    await harness.registry.invokeCommand("remove", "", WORKSPACE);
    // One way means the roster is the user's business. The agent hears about
    // the sidekick when the user sends it something the sidekick said, and
    // never from its coming and going.
    expect(await harness.registry.interceptMessage({
        text: "is it just us",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    await harness.registry.close();
});

test("a resumed conversation says nothing to the agent either", async () => {
    const harness = await start();
    harness.thread.push({ role: "user", text: "hello" });
    // Nothing is owed on resume: the agent was never told a seat was there,
    // so it has nothing to unlearn.
    expect(await harness.registry.interceptMessage({
        text: "still there?",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    await harness.registry.close();
});

test("a new conversation seats nobody", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    harness.registry.conversationChanged();
    expect(harness.mentions).toEqual([]);
    expect(await harness.registry.interceptMessage({
        text: "@sidekick still there?",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.consults).toEqual([]);
    await harness.registry.close();
});

test("the sidekick is offered to the composer as a mention", async () => {
    const harness = await start();
    expect(harness.mentions).toEqual([]);

    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    expect(harness.mentions).toEqual(["sidekick", "all", "vera"]);

    await harness.registry.invokeCommand("remove", "", WORKSPACE);
    expect(harness.mentions).toEqual([]);
    await harness.registry.close();
});

test("@all asks the sidekick and hands the agent the same message", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@all which way",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "replace", text: "which way" });
    await harness.settle();
    expect(harness.consults.map((request) => request.model)).toEqual(["gpt-5.5"]);
    expect(harness.sidebar.blocks.map((block) => block.text))
        .toEqual([
            "Seated. Ask with @sidekick, or @all.",
            "which way",
            "gpt-5.5 says so",
        ]);
    await harness.registry.close();
});

test("nothing the sidekick said reaches the agent on its own", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    await harness.registry.interceptMessage({
        text: "@sidekick what do you think",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    await harness.settle();

    // The reply is in the column and nowhere else. Carrying it across is the
    // user's act, not the extension's.
    expect(await harness.registry.interceptMessage({
        text: "@agent go with that",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "replace", text: "go with that" });
    await harness.registry.close();
});

test("a bare address holds every message after it", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@sidekick",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    expect(harness.addressee).toBe("@sidekick");
    // Nothing was asked: the address was where, not what.
    expect(harness.consults).toHaveLength(0);

    expect(await harness.registry.interceptMessage({
        text: "what do you think",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    await harness.settle();
    expect(harness.consults).toHaveLength(1);
    expect(harness.consults[0]?.messages.at(-1)?.content)
        .toBe("what do you think");

    // Let go, and the agent has the messages again.
    expect(await harness.registry.interceptMessage({
        text: "@vera",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    expect(harness.addressee).toBeUndefined();
    expect(await harness.registry.interceptMessage({
        text: "carry on",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    await harness.registry.close();
});

test("a held sidekick that leaves lets go of the composer", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);
    await harness.registry.interceptMessage({
        text: "@sidekick",
        workspace: WORKSPACE,
        imageCount: 0,
    });
    expect(harness.addressee).toBe("@sidekick");

    await harness.registry.invokeCommand("remove", "", WORKSPACE);
    expect(harness.addressee).toBeUndefined();
    expect(await harness.registry.interceptMessage({
        text: "still here?",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    await harness.registry.close();
});

test("@all is asked once rather than held", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@all",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    expect(harness.addressee).toBeUndefined();
    expect(harness.consults).toHaveLength(0);
    await harness.registry.close();
});

test("a message for an unknown name is held rather than sent to the agent", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "gpt-5.5", WORKSPACE);

    expect(await harness.registry.interceptMessage({
        text: "@m9 hello",
        workspace: WORKSPACE,
        imageCount: 0,
    })).toEqual({ kind: "handled" });
    expect(harness.consults).toEqual([]);
    expect(harness.notices).toContain("No seat named @m9");
    await harness.registry.close();
});

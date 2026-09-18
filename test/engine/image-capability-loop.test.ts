/**
 * The image-capability loop through the real pool file on disk.
 *
 * A provider refusal recorded here has to survive as JSON and change what the
 * next turn sends, so every assertion reads the file back rather than an
 * in-memory pool object.
 */

import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import {
    createInProcessChannel,
    type InProcessChannel,
} from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { createPoolEffortPool } from "../../src/model/effort-pool.ts";
import { poolImageSupport } from "../../src/model/image-support.ts";
import type { LearnedFact, PoolFile } from "../../src/model/pool-file.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import type { ProviderFailure } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { OMITTED_IMAGE_TEXT } from "../../src/attachments/service.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const PROVIDER = "faux";
const MODEL = "vision-1";
const POOL_ID = `${PROVIDER}/${MODEL}`;

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

interface Harness {
    readonly poolPath: string;
    readonly cacheDir: string;
    readonly pool: ReturnType<typeof createPoolEffortPool>;
}

function harness(seed?: string): Harness {
    const directory = mkdtempSync(join(tmpdir(), "vera-image-loop-"));
    directories.push(directory);
    const poolPath = join(directory, "pool.json");
    if (seed !== undefined) {
        writeFileSync(poolPath, seed);
    }
    const options = {
        userPath: poolPath,
        // No project scope: the file the loop writes is the user one.
        projectPath: join(directory, "absent-project-pool.json"),
        path: poolPath,
        cacheDir: join(directory, "catalog-cache"),
        curated: [],
    };
    return {
        poolPath,
        cacheDir: options.cacheDir,
        pool: createPoolEffortPool(options),
    };
}

/** An absent file is an absent record, which is what "nothing was learned" is. */
function readLearned(poolPath: string): Record<string, LearnedFact> {
    if (!existsSync(poolPath)) {
        return {};
    }
    const file = JSON.parse(readFileSync(poolPath, "utf8")) as PoolFile;
    return (file.models[POOL_ID]?.learned ?? {}) as Record<string, LearnedFact>;
}

function reply(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: PROVIDER, api: "scripted", model: MODEL },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function failingStream(failure: ProviderFailure): ModelEventStream {
    const stream = new ModelEventStream();
    const error = new ProviderFailureError(failure, new Error(failure.message));
    stream.push({ type: "start" });
    stream.push({
        type: "error",
        error,
        message: {
            ...reply(""),
            content: [],
            stopReason: "error",
            errorMessage: error.message,
        },
    });
    return stream;
}

const IMAGE_REFUSAL: ProviderFailure = {
    kind: "invalid_request",
    resolution: "none",
    statusCode: 400,
    message: "This model does not support image input",
    providerName: "Faux",
    providerMessage: "This model does not support image input",
};

interface Recorded {
    readonly requests: ModelRequest[];
    readonly adapter: ModelAdapter;
}

/**
 * Mirrors how the OpenRouter adapter is wired in `src/providers/configured.ts`:
 * image support is a callback into the pool, never a flag on the adapter.
 */
function poolBackedAdapter(
    theHarness: Harness,
    respond: (attempt: number, request: ModelRequest) => ModelEventStream,
): Recorded {
    const requests: ModelRequest[] = [];
    const imageSupport = poolImageSupport({
        provider: PROVIDER,
        pool: theHarness.pool,
        cacheDir: theHarness.cacheDir,
        curated: [],
    });
    return {
        requests,
        adapter: {
            imageInputSupport: (model) => imageSupport(model),
            stream(request) {
                requests.push(request);
                return respond(requests.length, request);
            },
        },
    };
}

function turnState(
    theHarness: Harness,
    channel: InProcessChannel,
    settings: ModelTurnSettings,
): { readonly state: RunTurnState; readonly events: EngineEventBus } {
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    return {
        events,
        state: {
            messages: [],
            store: new InMemorySessionStore(),
            toolRuntime: new ToolRuntime(process.cwd()),
            inbound: new InboundCommandRouter(channel.engine, events),
            events,
            hooks: new ToolHooks(),
            approvalMode: "auto",
            effortPool: theHarness.pool,
            readModelSettings: () => settings,
            readImageContent: async () => ({
                type: "image",
                mediaType: "image/png",
                data: Uint8Array.from([137, 80, 78, 71]),
            }),
        },
    };
}

function imageParts(request: ModelRequest | undefined): unknown[] {
    return (request?.messages ?? []).flatMap((message) =>
        typeof message.content === "string"
            ? []
            : (message.content as readonly { type: string }[])
                .filter((block) => block.type === "image")
    );
}

const WITH_EFFORT: ModelTurnSettings = {
    provider: PROVIDER,
    model: MODEL,
    reasoningEffort: "high",
};

const WITHOUT_EFFORT: ModelTurnSettings = {
    provider: PROVIDER,
    model: MODEL,
};

test("a provider image refusal lands in the pool file on disk", async () => {
    const context = harness();
    const recorded = poolBackedAdapter(
        context,
        () => failingStream(IMAGE_REFUSAL),
    );
    const channel = createInProcessChannel();
    const { state } = turnState(context, channel, WITH_EFFORT);

    channel.client.send({
        type: "prompt",
        content: "what is in this",
        attachmentIds: ["shot.png"],
    });
    await runTurn(recorded.adapter, MODEL, state);

    expect(imageParts(recorded.requests[0])).toHaveLength(1);
    const learned = readLearned(context.poolPath);
    expect(learned.images).toEqual({
        ok: false,
        seen: new Date().toISOString().slice(0, 10),
        error: "This model does not support image input",
    });
});

test("the recorded refusal stops the next turn from sending the image", async () => {
    const context = harness();
    const recorded = poolBackedAdapter(context, (attempt, request) =>
        attempt === 1
            ? failingStream(IMAGE_REFUSAL)
            : new FauxAdapter([reply("no image, then")]).stream(request));
    const first = createInProcessChannel();
    const one = turnState(context, first, WITH_EFFORT);
    first.client.send({
        type: "prompt",
        content: "what is in this",
        attachmentIds: ["shot.png"],
    });
    await runTurn(recorded.adapter, MODEL, one.state);
    expect(readLearned(context.poolPath).images?.ok).toBe(false);

    const second = createInProcessChannel();
    const two = turnState(context, second, WITH_EFFORT);
    second.client.send({
        type: "prompt",
        content: "and this one",
        attachmentIds: ["shot.png"],
    });
    const result = await runTurn(recorded.adapter, MODEL, two.state);

    // The engine refuses the provider request but retains the prompt so a
    // model switch can retry it without making the user retype everything.
    expect(recorded.requests).toHaveLength(1);
    expect(result.errorMessage)
        .toContain("does not support image input");
    expect(two.state.messages[0]).toEqual({
        role: "user",
        content: [
            { type: "text", text: "and this one" },
            { type: "image_attachment", attachmentId: "shot.png" },
        ],
    });
    // The refusal itself is committed, so a resume still shows why the turn
    // ended instead of a user message with no reply.
    expect(two.state.messages[1]).toMatchObject({
        role: "assistant",
        stopReason: "error",
    });
});

test("a model nothing knows about still gets its image sent", async () => {
    const context = harness();
    expect(context.pool.resolveImageSupport({
        provider: PROVIDER,
        model: MODEL,
    })).toBeUndefined();
    const recorded = poolBackedAdapter(context, (_attempt, request) =>
        new FauxAdapter([reply("I see it")]).stream(request));
    const channel = createInProcessChannel();
    const { state } = turnState(context, channel, WITH_EFFORT);

    channel.client.send({
        type: "prompt",
        content: "look",
        attachmentIds: ["shot.png"],
    });
    await runTurn(recorded.adapter, MODEL, state);

    expect(imageParts(recorded.requests[0])).toEqual([{
        type: "image",
        mediaType: "image/png",
        data: Uint8Array.from([137, 80, 78, 71]),
    }]);
    expect(readLearned(context.poolPath).images).toEqual({
        ok: true,
        seen: new Date().toISOString().slice(0, 10),
        checked: "user_key",
    });
});

const SEEDED_FALSE = JSON.stringify({
    models: {
        [POOL_ID]: {
            added: true,
            learned: {
                images: { ok: false, seen: "2026-01-01", error: "no images" },
            },
        },
    },
});

test("an image already in the history becomes a placeholder", async () => {
    const context = harness(SEEDED_FALSE);
    const recorded = poolBackedAdapter(context, (_attempt, request) =>
        new FauxAdapter([reply("read as text")]).stream(request));
    const channel = createInProcessChannel();
    const { state } = turnState(context, channel, WITH_EFFORT);
    state.messages.push({
        role: "user",
        content: [
            { type: "text", text: "what is in this" },
            { type: "image_attachment", attachmentId: "shot.png" },
        ],
    });

    channel.client.send({ type: "prompt", content: "describe it again" });
    await runTurn(recorded.adapter, MODEL, state);

    // The turn runs: a switch to a model without vision leaves the session
    // usable rather than failing every turn that follows it.
    expect(recorded.requests).toHaveLength(1);
    expect(imageParts(recorded.requests[0])).toHaveLength(0);
    expect(recorded.requests[0]?.messages[0]).toEqual({
        role: "user",
        content: [
            { type: "text", text: "what is in this" },
            { type: "text", text: OMITTED_IMAGE_TEXT },
        ],
    });
});

const SEEDED_TRUE = JSON.stringify({
    models: {
        [POOL_ID]: {
            added: true,
            learned: {
                images: { ok: true, seen: "2026-01-01", checked: "user_key" },
            },
        },
    },
});

const OUTAGES: readonly ProviderFailure[] = [
    {
        kind: "server",
        resolution: "retry",
        statusCode: 500,
        message: "upstream error",
        providerMessage: "internal server error",
    },
    {
        kind: "timeout",
        resolution: "retry",
        message: "request timed out",
    },
];

for (const outage of OUTAGES) {
    test(`a ${outage.kind} failure on an image turn records nothing`, async () => {
        const context = harness(SEEDED_TRUE);
        const recorded = poolBackedAdapter(context, (attempt, request) =>
            attempt === 1
                ? failingStream(outage)
                : new FauxAdapter([reply("recovered")]).stream(request));
        const channel = createInProcessChannel();
        const { state } = turnState(context, channel, WITH_EFFORT);

        channel.client.send({
            type: "prompt",
            content: "look",
            attachmentIds: ["shot.png"],
        });
        await runTurn(recorded.adapter, MODEL, state);

        expect(readLearned(context.poolPath).images).toEqual({
            ok: true,
            seen: "2026-01-01",
            checked: "user_key",
        });
        expect(context.pool.resolveImageSupport({
            provider: PROVIDER,
            model: MODEL,
        })).toBe(true);
        // The retry still carries the image, because the outage said nothing
        // about the model.
        expect(imageParts(recorded.requests.at(-1))).toHaveLength(1);
    });
}

test("an image refusal is recorded on a turn that asks for no effort", async () => {
    const context = harness();
    const recorded = poolBackedAdapter(
        context,
        () => failingStream(IMAGE_REFUSAL),
    );
    const channel = createInProcessChannel();
    const { state } = turnState(context, channel, WITHOUT_EFFORT);

    channel.client.send({
        type: "prompt",
        content: "what is in this",
        attachmentIds: ["shot.png"],
    });
    await runTurn(recorded.adapter, MODEL, state);

    expect(recorded.requests[0]?.reasoningEffort).toBeUndefined();
    expect(readLearned(context.poolPath).images).toEqual({
        ok: false,
        seen: new Date().toISOString().slice(0, 10),
        error: "This model does not support image input",
    });
});

interface EffortFreeRefusal {
    readonly key: string;
    readonly failure: ProviderFailure;
}

/**
 * The capabilities a provider refuses on requests that carry no effort. Their
 * learned keys are the capability name, not a level, so each is recordable
 * whether or not the request asked for an effort.
 */
const EFFORT_FREE_REFUSALS: readonly EffortFreeRefusal[] = [
    {
        key: "tools",
        failure: {
            kind: "invalid_request",
            resolution: "none",
            statusCode: 400,
            message: "tool use is not supported by this model",
            providerMessage: "tool use is not supported by this model",
        },
    },
    {
        key: "thinking",
        failure: {
            kind: "invalid_request",
            resolution: "none",
            statusCode: 400,
            message: "unsupported parameter: thinking",
            providerMessage: "unsupported parameter: thinking",
        },
    },
];

for (const refusal of EFFORT_FREE_REFUSALS) {
    test(`a ${refusal.key} refusal is recorded on a turn that asks for no effort`, async () => {
        const context = harness();
        const recorded = poolBackedAdapter(
            context,
            () => failingStream(refusal.failure),
        );
        const channel = createInProcessChannel();
        const { state } = turnState(context, channel, WITHOUT_EFFORT);

        channel.client.send({ type: "prompt", content: "use a tool" });
        await runTurn(recorded.adapter, MODEL, state);

        expect(readLearned(context.poolPath)[refusal.key]).toEqual({
            ok: false,
            seen: new Date().toISOString().slice(0, 10),
            error: refusal.failure.providerMessage as string,
        });
    });
}

test("an effort refusal with no level requested records nothing", async () => {
    const context = harness();
    const recorded = poolBackedAdapter(context, () => failingStream({
        kind: "invalid_request",
        resolution: "none",
        statusCode: 400,
        message: "unsupported value: reasoning_effort",
        providerMessage: "unsupported value: reasoning_effort",
    }));
    const channel = createInProcessChannel();
    const { state } = turnState(context, channel, WITHOUT_EFFORT);

    channel.client.send({ type: "prompt", content: "think hard" });
    await runTurn(recorded.adapter, MODEL, state);

    // There is no level to blame, so no `efforts.*` key is invented.
    expect(readLearned(context.poolPath)).toEqual({});
});

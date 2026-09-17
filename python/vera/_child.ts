import { Vera, type Agent } from "../../src/sdk/agent.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";

// Protocol lines own stdout. Anything else the engine prints goes to stderr.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.error;
console.info = console.error;
console.debug = console.error;

interface InitRequest {
    readonly type: "init";
    readonly workspace: string;
    readonly posture?: string;
    readonly replay: boolean;
    readonly replayDelayMs: number;
}

interface ChildAgentInput {
    readonly name: string;
    readonly instructions: string;
    readonly tools?: string[];
    readonly posture?: string;
    readonly provider?: string;
    readonly model?: string;
}

interface RunRequest {
    readonly id: number;
    readonly type: "run";
    readonly agent: ChildAgentInput;
    readonly prompt: string;
    readonly session?: string;
}

interface ToolRequest {
    readonly id: number;
    readonly type: "tool";
    readonly name: string;
    readonly input: Record<string, unknown>;
}

interface AbortRequest {
    readonly type: "abort";
    readonly id: number;
}

type ChildRequest = RunRequest | ToolRequest | AbortRequest;

// Replay answers with the latest user prompt and never reads the Vera home.
class RecordedAdapter implements ModelAdapter {
    constructor(private readonly delayMs: number) {}

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        void this.produce(request, stream);
        return stream;
    }

    private async produce(request: ModelRequest, stream: ModelEventStream): Promise<void> {
        const reply = latestUserText(request);
        const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: reply }],
            source: {
                provider: "faux",
                api: "python-child",
                model: request.model,
            },
            usage: emptyUsage(),
            stopReason: "stop",
        };
        stream.push({ type: "start" });
        if (this.delayMs > 0) {
            await waitOrAbort(this.delayMs, request.signal);
            if (request.signal?.aborted === true) {
                stream.push({
                    type: "error",
                    error: new Error("aborted"),
                    message: { ...message, content: [], stopReason: "aborted" },
                });
                return;
            }
        }
        stream.push({ type: "text_start", contentIndex: 0 });
        stream.push({ type: "text_delta", contentIndex: 0, text: reply });
        stream.push({ type: "text_end", contentIndex: 0 });
        stream.push({ type: "done", message });
    }
}

function latestUserText(request: ModelRequest): string {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index];
        if (message?.role !== "user") continue;
        return message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
    }
    return "";
}

function waitOrAbort(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

function send(message: Record<string, unknown>): void {
    protocolWrite(`${JSON.stringify(message)}\n`);
}

async function createVera(init: InitRequest): Promise<Vera> {
    if (!init.replay) {
        return await Vera.create({
            workspace: init.workspace,
            ...(init.posture === undefined ? {} : { posture: init.posture }),
        });
    }
    const runtimePosture = init.posture ?? "readonly";
    return await Vera.create({
        workspace: init.workspace,
        posture: runtimePosture,
        config: {
            schema_version: 1,
            provider: "faux",
            model: "python-child",
            reasoning_effort: "high",
            approval_mode: runtimePosture,
        },
        createAdapter: () => new RecordedAdapter(init.replayDelayMs),
    });
}

async function runAgent(
    vera: Vera,
    request: RunRequest,
    signal: AbortSignal,
): Promise<void> {
    const definition = {
        name: request.agent.name,
        instructions: request.agent.instructions,
        tools: request.agent.tools ?? [],
        ...(request.agent.posture === undefined
            ? {}
            : { posture: request.agent.posture }),
    };
    const agent: Agent = vera.agent(definition, {
        ...(request.agent.provider === undefined
            ? {}
            : { provider: request.agent.provider }),
        ...(request.agent.model === undefined ? {} : { model: request.agent.model }),
    });
    const result = await agent.run(request.prompt, {
        signal,
        ...(request.session === undefined ? {} : { session: request.session }),
    });
    if (result.outcome === "completed") {
        send({ id: request.id, type: "result", text: result.text });
        return;
    }
    send({
        id: request.id,
        type: "error",
        kind: result.error?.kind ?? "runtime",
        message: result.error?.message ?? "Vera agent run failed",
    });
}

async function runTool(vera: Vera, request: ToolRequest): Promise<void> {
    const result = await vera.tool(request.name, request.input);
    send({
        id: request.id,
        type: "tool_result",
        outcome: result.outcome,
        output: result.output,
    });
}

async function main(): Promise<void> {
    const lines = console[Symbol.asyncIterator]();
    const first = await lines.next();
    if (first.done === true) return;
    let vera: Vera;
    try {
        vera = await createVera(initRequest(JSON.parse(first.value)));
    } catch (caught) {
        send({ type: "error", kind: "runtime", message: errorMessage(caught) });
        return;
    }
    send({ type: "ready" });

    const inFlight = new Map<number, AbortController>();
    const pending = new Set<Promise<void>>();
    for (;;) {
        const next = await lines.next();
        if (next.done === true) break;
        if (next.value.trim().length === 0) continue;
        let request: ChildRequest;
        try {
            request = childRequest(JSON.parse(next.value));
        } catch (caught) {
            send({ type: "error", kind: "protocol", message: errorMessage(caught) });
            continue;
        }
        if (request.type === "abort") {
            inFlight.get(request.id)?.abort();
            continue;
        }
        const controller = new AbortController();
        const id = request.id;
        inFlight.set(id, controller);
        const work = (request.type === "run"
            ? runAgent(vera, request, controller.signal)
            : runTool(vera, request))
            .catch((caught: unknown) => {
                send({ id, type: "error", kind: "runtime", message: errorMessage(caught) });
            })
            .finally(() => {
                inFlight.delete(id);
                pending.delete(work);
            });
        pending.add(work);
    }
    for (const controller of inFlight.values()) controller.abort();
    await Promise.allSettled(pending);
    await vera.close();
}

function initRequest(value: unknown): InitRequest {
    if (!isRecord(value) || value.type !== "init") {
        throw new Error("The first line must be an init request");
    }
    const posture = optionalString(value.posture, "posture");
    if (value.replay !== undefined && typeof value.replay !== "boolean") {
        throw new Error("replay must be a boolean");
    }
    const delay = value.replay_delay_ms ?? 0;
    if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
        throw new Error("replay_delay_ms must be a non-negative number");
    }
    return {
        type: "init",
        workspace: requiredString(value.workspace, "workspace"),
        replay: value.replay === true,
        replayDelayMs: delay,
        ...(posture === undefined ? {} : { posture }),
    };
}

function childRequest(value: unknown): ChildRequest {
    if (!isRecord(value)) {
        throw new Error("A request must be an object");
    }
    if (typeof value.id !== "number" || !Number.isInteger(value.id)) {
        throw new Error("A request needs an integer id");
    }
    if (value.type === "abort") {
        return { type: "abort", id: value.id };
    }
    if (value.type === "tool") {
        if (value.input !== undefined && !isRecord(value.input)) {
            throw new Error("tool input must be an object");
        }
        return {
            id: value.id,
            type: "tool",
            name: requiredString(value.name, "name"),
            input: value.input ?? {},
        };
    }
    if (value.type !== "run") {
        throw new Error(`Unknown request type ${String(value.type)}`);
    }
    if (!isRecord(value.agent)) {
        throw new Error("run needs an agent object");
    }
    const agent = value.agent;
    const tools = optionalStrings(agent.tools, "agent.tools");
    const agentPosture = optionalString(agent.posture, "agent.posture");
    const provider = optionalString(agent.provider, "agent.provider");
    const model = optionalString(agent.model, "agent.model");
    const session = optionalString(value.session, "session");
    return {
        id: value.id,
        type: "run",
        prompt: requiredString(value.prompt, "prompt"),
        ...(session === undefined ? {} : { session }),
        agent: {
            name: requiredString(agent.name, "agent.name"),
            instructions: requiredString(agent.instructions, "agent.instructions"),
            ...(tools === undefined ? {} : { tools }),
            ...(agentPosture === undefined ? {} : { posture: agentPosture }),
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
        },
    };
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    return requiredString(value, field);
}

function optionalStrings(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`${field} must be an array`);
    }
    return value.map((item) => requiredString(item, field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(caught: unknown): string {
    const message = caught instanceof Error ? caught.message : String(caught);
    return message || "Vera bun child failed";
}

try {
    await main();
} catch (caught) {
    process.stderr.write(`${errorMessage(caught)}\n`);
    process.exitCode = 1;
}

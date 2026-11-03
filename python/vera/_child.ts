import { Vera, type Agent, type FunctionTool } from "../../src/sdk/agent.ts";
import type {
    PreTurnHook,
    PreTurnHookPayload,
    PreTurnHookResult,
    TurnEndingHook,
    TurnEndingHookPayload,
    TurnEndingHookResult,
} from "../../src/sdk/hooks.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ToolCallContent,
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

interface ChildFunction {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
}

interface ChildAgentInput {
    readonly name: string;
    readonly instructions: string;
    readonly tools?: string[];
    readonly functions: ChildFunction[];
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
    readonly prepareTurn: boolean;
    readonly beforeTurnEnds: boolean;
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

interface HookResultRequest {
    readonly type: "hook_result";
    readonly id: number;
    readonly hookId: number;
    readonly result?: unknown;
    readonly error?: string;
}

interface FunctionResultRequest {
    readonly type: "function_result";
    readonly id: number;
    readonly callId: number;
    readonly output?: string;
    readonly error?: string;
}

type ChildRequest =
    | RunRequest
    | ToolRequest
    | AbortRequest
    | HookResultRequest
    | FunctionResultRequest;

interface WaitingAnswer {
    readonly runId: number;
    readonly resolve: (result: unknown) => void;
    readonly reject: (error: Error) => void;
}

// Hooks and function calls waiting on Python, by hook_id or call_id. A late answer is dropped.
const waitingAnswers = new Map<number, WaitingAnswer>();
let nextAnswerId = 0;

function waitForPython(
    runId: number,
    message: (answerId: number) => Record<string, unknown>,
    signal?: AbortSignal,
): Promise<unknown> {
    nextAnswerId += 1;
    const answerId = nextAnswerId;
    return new Promise((resolve, reject) => {
        waitingAnswers.set(answerId, { runId, resolve, reject });
        signal?.addEventListener("abort", () => {
            answerPython(answerId, undefined, "the run was cancelled");
        }, { once: true });
        send(message(answerId));
    });
}

function answerPython(answerId: number, result: unknown, error: string | undefined): void {
    const waiting = waitingAnswers.get(answerId);
    if (waiting === undefined) return;
    waitingAnswers.delete(answerId);
    if (error !== undefined) {
        waiting.reject(new Error(error));
        return;
    }
    waiting.resolve(result);
}

function askPython(runId: number, phase: string, payload: Record<string, unknown>): Promise<unknown> {
    return waitForPython(runId, (hookId) => ({ id: runId, type: "hook", hook_id: hookId, phase, payload }));
}

function pythonFunction(runId: number, declared: ChildFunction): FunctionTool {
    return {
        ...declared,
        async run(args, signal) {
            const output = await waitForPython(runId, (callId) => ({
                id: runId,
                type: "function_call",
                call_id: callId,
                name: declared.name,
                arguments: args,
            }), signal);
            if (typeof output !== "string") {
                throw new Error(`Python function ${declared.name} sent no output`);
            }
            return output;
        },
    };
}

// An aborted run leaves questions Python never answers; drop them when the run ends.
function dropAnswers(runId: number): void {
    for (const [answerId, waiting] of waitingAnswers) {
        if (waiting.runId !== runId) continue;
        waitingAnswers.delete(answerId);
        waiting.reject(new Error("the run ended"));
    }
}

function preTurnForPython(payload: PreTurnHookPayload): Record<string, unknown> {
    return {
        type: payload.type,
        workspace: payload.workspace,
        prompt: payload.prompt,
        model: payload.model,
        tools: payload.tools,
        arrived_during_turn: payload.arrivedDuringTurn,
        spawned: payload.spawned,
        ...(payload.reasoningEffort === undefined ? {} : { reasoning_effort: payload.reasoningEffort }),
        ...(payload.sessionId === undefined ? {} : { session_id: payload.sessionId }),
    };
}

function turnEndingForPython(payload: TurnEndingHookPayload): Record<string, unknown> {
    return {
        type: payload.type,
        workspace: payload.workspace,
        prompt: payload.prompt,
        reply: payload.reply,
        spawned: payload.spawned,
        continuations: payload.continuations,
        ...(payload.sessionId === undefined ? {} : { session_id: payload.sessionId }),
    };
}

const PRE_TURN_RESULT_KEYS: Readonly<Record<string, string>> = {
    power: "power",
    tools: "tools",
    model: "model",
    reasoning_effort: "reasoningEffort",
    context: "context",
    display: "display",
    reason: "reason",
};

const TURN_ENDING_RESULT_KEYS: Readonly<Record<string, string>> = {
    power: "power",
    context: "context",
    display: "display",
};

// None from Python means observe. The engine validates the values; this only renames keys.
function resultFromPython(value: unknown, keys: Readonly<Record<string, string>>): Record<string, unknown> {
    if (value === null || value === undefined) return { power: "observe" };
    if (!isRecord(value)) throw new Error("a hook must return a dict or None");
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
        const name = keys[key];
        if (name === undefined) throw new Error(`a hook result has no key ${key}`);
        result[name] = field;
    }
    return result;
}

function pythonPreTurn(runId: number): PreTurnHook {
    return async (payload) => {
        const answer = await askPython(runId, "pre_turn", preTurnForPython(payload));
        return resultFromPython(answer, PRE_TURN_RESULT_KEYS) as unknown as PreTurnHookResult;
    };
}

function pythonTurnEnding(runId: number): TurnEndingHook {
    return async (payload) => {
        const answer = await askPython(runId, "turn_ending", turnEndingForPython(payload));
        return resultFromPython(answer, TURN_ENDING_RESULT_KEYS) as unknown as TurnEndingHookResult;
    };
}

// Replay echoes the latest user prompt and never reads the Vera home. A prompt
// "call <name> <json>" calls that tool once, then replies with its result.
class RecordedAdapter implements ModelAdapter {
    constructor(private readonly delayMs: number) {}

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        void this.produce(request, stream);
        return stream;
    }

    private async produce(request: ModelRequest, stream: ModelEventStream): Promise<void> {
        const toolCall = replayToolCall(request);
        const reply = replayText(request);
        const message: AssistantMessage = {
            role: "assistant",
            content: toolCall === undefined
                ? [{ type: "text", text: reply }]
                : [toolCall],
            source: {
                provider: "faux",
                api: "python-child",
                model: request.model,
            },
            usage: emptyUsage(),
            stopReason: toolCall === undefined ? "stop" : "tool_use",
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
        if (toolCall === undefined) {
            stream.push({ type: "text_start", contentIndex: 0 });
            stream.push({ type: "text_delta", contentIndex: 0, text: reply });
            stream.push({ type: "text_end", contentIndex: 0 });
        } else {
            stream.push({ type: "tool_call_start", contentIndex: 0 });
            stream.push({
                type: "tool_call_delta",
                contentIndex: 0,
                argumentsDelta: JSON.stringify(toolCall.input),
            });
            stream.push({ type: "tool_call_end", contentIndex: 0, toolCall });
        }
        stream.push({ type: "done", message });
    }
}

function replayToolCall(request: ModelRequest): ToolCallContent | undefined {
    if (request.messages.at(-1)?.role !== "user") return undefined;
    const directive = /^call ([a-z][a-z0-9_]*) (\{.*\})$/s.exec(latestUserText(request).trim());
    if (directive === null) return undefined;
    const input: unknown = JSON.parse(directive[2]!);
    if (!isRecord(input)) return undefined;
    return { type: "tool_call", id: "replay-call", name: directive[1]!, input };
}

function replayText(request: ModelRequest): string {
    const last = request.messages.at(-1);
    if (last?.role !== "tool_result") return latestUserText(request);
    const text = last.content.map((part) => part.text).join("");
    return last.isError ? `error: ${text}` : text;
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
        ...(request.agent.functions.length === 0
            ? {}
            : {
                functions: request.agent.functions.map((declared) =>
                    pythonFunction(request.id, declared)
                ),
            }),
    });
    const result = await agent.run(request.prompt, {
        signal,
        ...(request.session === undefined ? {} : { session: request.session }),
        ...(request.prepareTurn ? { prepareTurn: pythonPreTurn(request.id) } : {}),
        ...(request.beforeTurnEnds ? { beforeTurnEnds: pythonTurnEnding(request.id) } : {}),
    });
    if (result.outcome === "completed") {
        send({
            id: request.id,
            type: "result",
            text: result.text,
            transcript: result.transcript,
        });
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
        if (request.type === "hook_result") {
            answerPython(request.hookId, request.result, request.error);
            continue;
        }
        if (request.type === "function_result") {
            answerPython(request.callId, request.output, request.error);
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
                dropAnswers(id);
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
    if (value.type === "hook_result") {
        if (typeof value.hook_id !== "number" || !Number.isInteger(value.hook_id)) {
            throw new Error("hook_result needs an integer hook_id");
        }
        if (value.error !== undefined && typeof value.error !== "string") {
            throw new Error("hook_result error must be a string");
        }
        return {
            id: value.id,
            type: "hook_result",
            hookId: value.hook_id,
            result: value.result,
            ...(value.error === undefined ? {} : { error: value.error }),
        };
    }
    if (value.type === "function_result") {
        if (typeof value.call_id !== "number" || !Number.isInteger(value.call_id)) {
            throw new Error("function_result needs an integer call_id");
        }
        if (value.output !== undefined && typeof value.output !== "string") {
            throw new Error("function_result output must be a string");
        }
        if (value.error !== undefined && typeof value.error !== "string") {
            throw new Error("function_result error must be a string");
        }
        return {
            id: value.id,
            type: "function_result",
            callId: value.call_id,
            ...(value.output === undefined ? {} : { output: value.output }),
            ...(value.error === undefined ? {} : { error: value.error }),
        };
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
    const functions = childFunctions(agent.functions);
    const agentPosture = optionalString(agent.posture, "agent.posture");
    const provider = optionalString(agent.provider, "agent.provider");
    const model = optionalString(agent.model, "agent.model");
    const session = optionalString(value.session, "session");
    return {
        id: value.id,
        type: "run",
        prepareTurn: optionalFlag(value.prepare_turn, "prepare_turn"),
        beforeTurnEnds: optionalFlag(value.before_turn_ends, "before_turn_ends"),
        prompt: requiredString(value.prompt, "prompt"),
        ...(session === undefined ? {} : { session }),
        agent: {
            name: requiredString(agent.name, "agent.name"),
            instructions: requiredString(agent.instructions, "agent.instructions"),
            ...(tools === undefined ? {} : { tools }),
            functions,
            ...(agentPosture === undefined ? {} : { posture: agentPosture }),
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
        },
    };
}

function childFunctions(value: unknown): ChildFunction[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new Error("agent.functions must be an array");
    }
    return value.map((item) => {
        if (!isRecord(item) || typeof item.description !== "string" || !isRecord(item.parameters)) {
            throw new Error("each agent function needs a name, description and parameters object");
        }
        return {
            name: requiredString(item.name, "agent.functions.name"),
            description: item.description,
            parameters: item.parameters,
        };
    });
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

function optionalFlag(value: unknown, field: string): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
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

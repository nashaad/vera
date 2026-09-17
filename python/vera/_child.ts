import { readFileSync } from "node:fs";

import { Vera, type Agent } from "../../src/sdk/agent.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";

interface ChildAgentInput {
    readonly name: string;
    readonly instructions: string;
    readonly tools?: string[];
    readonly posture?: string;
    readonly provider?: string;
    readonly model?: string;
}

interface ChildInput {
    readonly workspace: string;
    readonly posture?: string;
    readonly replay: boolean;
    readonly agent: ChildAgentInput;
    readonly prompt: string;
}

class RecordedAdapter implements ModelAdapter {
    constructor(private readonly reply: string) {}

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: this.reply }],
            source: {
                provider: "faux",
                api: "python-child",
                model: request.model,
            },
            usage: emptyUsage(),
            stopReason: "stop",
        };
        stream.push({ type: "start" });
        stream.push({ type: "text_start", contentIndex: 0 });
        stream.push({ type: "text_delta", contentIndex: 0, text: this.reply });
        stream.push({ type: "text_end", contentIndex: 0 });
        stream.push({ type: "done", message });
        return stream;
    }
}

async function main(): Promise<void> {
    const input = childInput(readFileSync(0, "utf8"));
    const vera = input.replay ? await replayVera(input) : await Vera.create({
        workspace: input.workspace,
        ...(input.posture === undefined ? {} : { posture: input.posture }),
    });
    const definition = {
        name: input.agent.name,
        instructions: input.agent.instructions,
        tools: input.agent.tools ?? [],
        ...(input.agent.posture === undefined
            ? {}
            : { posture: input.agent.posture }),
    };
    const agent: Agent = vera.agent(definition, {
        ...(input.agent.provider === undefined
            ? {}
            : { provider: input.agent.provider }),
        ...(input.agent.model === undefined ? {} : { model: input.agent.model }),
    });
    const result = await agent.run(input.prompt);
    if (result.outcome !== "completed") {
        throw new Error(result.error?.message ?? "Vera agent run failed");
    }
    process.stdout.write(result.text);
}

// Replay answers with the prompt and never reads the Vera home.
async function replayVera(input: ChildInput): Promise<Vera> {
    const runtimePosture = input.posture ?? "readonly";
    return await Vera.create({
        workspace: input.workspace,
        posture: runtimePosture,
        config: {
            schema_version: 1,
            provider: "faux",
            model: "python-child",
            reasoning_effort: "high",
            approval_mode: runtimePosture,
        },
        createAdapter: () => new RecordedAdapter(input.prompt),
    });
}

function childInput(text: string): ChildInput {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.agent)) {
        throw new Error("Python child input must be an object with an agent");
    }
    const workspace = requiredString(parsed.workspace, "workspace");
    const prompt = requiredString(parsed.prompt, "prompt");
    const posture = optionalString(parsed.posture, "posture");
    const name = requiredString(parsed.agent.name, "agent.name");
    const instructions = requiredString(
        parsed.agent.instructions,
        "agent.instructions",
    );
    const tools = optionalStrings(parsed.agent.tools, "agent.tools");
    const agentPosture = optionalString(parsed.agent.posture, "agent.posture");
    const provider = optionalString(parsed.agent.provider, "agent.provider");
    const model = optionalString(parsed.agent.model, "agent.model");
    if (parsed.replay !== undefined && typeof parsed.replay !== "boolean") {
        throw new Error("replay must be a boolean");
    }
    return {
        workspace,
        prompt,
        replay: parsed.replay === true,
        ...(posture === undefined ? {} : { posture }),
        agent: {
            name,
            instructions,
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

try {
    await main();
} catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`${message || "Vera bun child failed"}\n`);
    process.exitCode = 1;
}

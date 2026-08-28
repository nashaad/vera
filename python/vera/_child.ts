import { readFileSync, statSync } from "node:fs";

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
}

interface ChildInput {
    readonly workspace: string;
    readonly posture?: string;
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
    const runtimeDir = process.env.VERA_RUNTIME_DIR;
    if (runtimeDir === undefined || runtimeDir.length === 0) {
        throw new Error("VERA_RUNTIME_DIR is required for the Python child");
    }
    if (!statSync(runtimeDir).isDirectory()) {
        throw new Error("VERA_RUNTIME_DIR must name a directory");
    }

    const input = childInput(readFileSync(0, "utf8"));
    const runtimePosture = input.posture ?? "readonly";
    const vera = await Vera.create({
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
    const definition = {
        name: input.agent.name,
        instructions: input.agent.instructions,
        tools: input.agent.tools ?? [],
        ...(input.agent.posture === undefined
            ? {}
            : { posture: input.agent.posture }),
    };
    const agent: Agent = vera.agent(definition);
    const result = await agent.run(input.prompt);
    if (result.outcome !== "completed") {
        throw new Error(result.error?.message ?? "Vera agent run failed");
    }
    process.stdout.write(result.text);
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
    return {
        workspace,
        prompt,
        ...(posture === undefined ? {} : { posture }),
        agent: {
            name,
            instructions,
            ...(tools === undefined ? {} : { tools }),
            ...(agentPosture === undefined ? {} : { posture: agentPosture }),
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

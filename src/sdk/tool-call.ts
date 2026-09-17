import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelEventStream } from "../model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../model/types.ts";

export const TOOL_CALL_ROUTE = { provider: "vera", model: "tool-call" } as const;

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ClaimedSession {
    readonly path: string;
    readonly exists: boolean;
    release(): void;
}

// Owns one Vera instance's runtime directory. Created on first use.
export class SdkRuntime {
    private directory: string | undefined;
    private creating: Promise<string> | undefined;
    private readonly busy = new Set<string>();
    private closed = false;

    async claimSession(name: string): Promise<ClaimedSession> {
        if (!SESSION_NAME.test(name)) {
            throw new Error(
                `Session name ${JSON.stringify(name)} must be letters, digits, - or _, up to 64 characters`,
            );
        }
        if (this.busy.has(name)) {
            throw new Error(`Session ${name} is already running a turn`);
        }
        this.busy.add(name);
        try {
            const sessions = join(await this.root(), "sessions");
            await mkdir(sessions, { recursive: true, mode: 0o700 });
            const path = join(sessions, `${name}.jsonl`);
            return {
                path,
                exists: existsSync(path),
                release: () => {
                    this.busy.delete(name);
                },
            };
        } catch (caught) {
            this.busy.delete(name);
            throw caught;
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        const directory = this.directory ?? await this.creating?.catch(() => undefined);
        this.directory = undefined;
        this.creating = undefined;
        if (directory !== undefined) {
            await rm(directory, { recursive: true, force: true });
        }
    }

    private async root(): Promise<string> {
        if (this.closed) {
            throw new Error("This Vera instance is closed");
        }
        if (this.directory !== undefined) return this.directory;
        this.creating ??= mkdtemp(join(tmpdir(), "vera-sdk-instance-"));
        this.directory = await this.creating;
        return this.directory;
    }
}

export type ToolRunOutcome = "completed" | "failed" | "denied";

export interface ToolRunResult {
    readonly outcome: ToolRunOutcome;
    readonly output: string;
}

// Answers the first request with one call to the named tool, then ends the turn.
export class ToolCallAdapter implements ModelAdapter {
    private calls = 0;

    constructor(
        private readonly name: string,
        private readonly input: Readonly<Record<string, unknown>>,
    ) {}

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        const first = this.calls === 0;
        this.calls += 1;
        const source = {
            provider: TOOL_CALL_ROUTE.provider,
            api: "tool-call",
            model: request.model,
        };
        stream.push({ type: "start" });
        if (first) {
            const toolCall = {
                type: "tool_call" as const,
                id: `call_${randomUUID()}`,
                name: this.name,
                input: this.input,
            };
            const message: AssistantMessage = {
                role: "assistant",
                content: [toolCall],
                source,
                usage: emptyUsage(),
                stopReason: "tool_use",
            };
            stream.push({ type: "tool_call_start", contentIndex: 0 });
            stream.push({
                type: "tool_call_delta",
                contentIndex: 0,
                argumentsDelta: JSON.stringify(this.input),
            });
            stream.push({ type: "tool_call_end", contentIndex: 0, toolCall });
            stream.push({ type: "done", message });
            return stream;
        }
        const message: AssistantMessage = {
            role: "assistant",
            content: [],
            source,
            usage: emptyUsage(),
            stopReason: "stop",
        };
        stream.push({ type: "done", message });
        return stream;
    }
}

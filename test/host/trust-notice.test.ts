import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineEvent } from "../../src/engine/events.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    TrustNoticeStore,
    trustNoticeSubscriber,
    trustNoticeText,
} from "../../src/host/trust-notice.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const NOTICE = trustNoticeText("crow.tools", "shanty_write");

function shantyWriteTool(runs: string[]): RegisteredTool {
    return {
        definition: {
            name: "shanty_write",
            description: "Write a shanty to the crow's log.",
            inputSchema: { type: "object" },
        },
        permissionOperation: "extension.storage.write",
        async execute() {
            runs.push("shanty_write");
            return { kind: "output", output: "yo ho", isError: false };
        },
    };
}

function callShantyWrite(id: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "shanty_write", input: {} }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function runPrompt(attachment: AgentAttachment, content: string): Promise<void> {
    attachment.send({ type: "prompt", content });
    while ((await attachment.receive()).type !== "turn_finished") {
        // Drain to the turn boundary.
    }
}

async function runTwoShantyTurns(approvalMode: string): Promise<{
    readonly runs: readonly string[];
    readonly notices: readonly { readonly text: string; readonly tone: string }[];
    readonly noticePath: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "vera-trust-notice-"));
    const sessionPath = join(root, "crow.jsonl");
    const noticePath = join(root, "trust-notices.json");
    const runs: string[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            callShantyWrite("first"),
            textResponse("sung"),
            callShantyWrite("second"),
            textResponse("sung again"),
        ]),
        model: "faux/test",
        approvalMode,
        extensionTools: [shantyWriteTool(runs)],
        trustNotices: {
            tools: new Map([["shanty_write", "crow.tools"]]),
            store: new TrustNoticeStore(noticePath),
        },
    });
    try {
        const agent = await registry.create({ id: "crow", workspace: root, sessionPath });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        await runPrompt(attachment, "sing");
        await runPrompt(attachment, "sing again");
    } finally {
        await registry.close();
    }
    const notices = (await SessionStore.open(sessionPath)).projectedHarnessMessages()
        .map((message) => ({ text: message.text, tone: message.tone }));
    return { runs, notices, noticePath };
}

test("auto mode shows one soft notice the first time an installed tool runs without review", async () => {
    const result = await runTwoShantyTurns("auto");
    try {
        expect(result.runs).toEqual(["shanty_write", "shanty_write"]);
        expect(result.notices).toEqual([{ text: NOTICE, tone: "soft" }]);
        expect(JSON.parse(await readFile(result.noticePath, "utf8"))).toEqual({
            shown: ["crow.tools"],
        });
    } finally {
        await rm(join(result.noticePath, ".."), { recursive: true, force: true });
    }
});

test("ask mode runs the same tool without the auto-mode notice", async () => {
    const result = await runTwoShantyTurns("ask");
    try {
        expect(result.runs).toEqual(["shanty_write", "shanty_write"]);
        expect(result.notices).toEqual([]);
    } finally {
        await rm(join(result.noticePath, ".."), { recursive: true, force: true });
    }
});

test("the notice is remembered per home and skips reviewed calls and other tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-trust-notice-store-"));
    const path = join(root, "trust-notices.json");
    const appended: string[] = [];
    const subscriber = (store: TrustNoticeStore) => trustNoticeSubscriber({
        tools: new Map([["shanty_write", "crow.tools"]]),
        store,
        approvalMode: () => "auto",
        append: (text) => appended.push(text),
    });
    const started = (id: string, name: string): EngineEvent => ({
        type: "tool_execution_started",
        toolCall: { type: "tool_call", id, name, input: {} },
    });
    try {
        const first = subscriber(new TrustNoticeStore(path));
        first({
            type: "tool_review_decided",
            toolCall: { id: "reviewed", name: "shanty_write", input: {} },
            decision: "allow",
            reason: "fine",
            riskLevel: "low",
            userAuthorization: "unknown",
        });
        first(started("reviewed", "shanty_write"));
        first(started("other", "bash"));
        expect(appended).toEqual([]);

        first(started("unreviewed", "shanty_write"));
        expect(appended).toEqual([NOTICE]);

        const afterRestart = subscriber(new TrustNoticeStore(path));
        afterRestart(started("later", "shanty_write"));
        expect(appended).toEqual([NOTICE]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

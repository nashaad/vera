import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubagent } from "../../src/engine/subagent.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
} from "../../src/model/types.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { skillScriptTool } from "../../src/skills/script.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import {
    ResidentAgent,
    ResidentAgentClosedError,
} from "../../src/host/resident-agent.ts";

const adversarialReviewTool: RegisteredTool = {
    invocation: "top_level",
    permissionOperation: "adversarial.review",
    definition: {
        name: "adversarial_review",
        description: "Review a target",
        inputSchema: { type: "object", properties: {} },
    },
    async execute() {
        return { kind: "output", output: "review", isError: false };
    },
};

const topLevelTools = [skillScriptTool, adversarialReviewTool];

test("synchronous subagents persist their parent and receive neither top-level tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-top-tools-sync-"));
    const requests: ModelRequest[] = [];
    const adapter = capturingAdapter(requests);
    const sessionPath = join(root, "child.jsonl");
    try {
        await runSubagent({
            adapter,
            model: "test",
            description: "inspect",
            workspace: root,
            approvalMode: "auto",
            parentSessionId: "parent-session",
            sessionPath,
            extensionTools: topLevelTools,
        });

        expect((await SessionStore.open(sessionPath)).header.parentId)
            .toBe("parent-session");
        expect(offeredNames(requests[0])).not.toContain("skill_script");
        expect(offeredNames(requests[0])).not.toContain("adversarial_review");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a resumed resident child derives the same exclusion from its session header", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-top-tools-resident-"));
    const store = await SessionStore.create(join(root, "child.jsonl"), {
        sessionId: "child-session",
        cwd: root,
        parentId: "parent-session",
    });
    const requests: ModelRequest[] = [];
    const resident = new ResidentAgent("child-session", root);
    const attachment = resident.attach();
    const loop = runHeadlessLoop(
        resident.engine,
        capturingAdapter(requests),
        "test",
        undefined,
        {},
        { sessionStore: store, extensionTools: topLevelTools },
    );
    try {
        resident.sendPrompt("inspect");
        while ((await attachment.receive()).type !== "turn_finished") {
            // Drain one bounded turn.
        }
        expect(offeredNames(requests[0])).not.toContain("skill_script");
        expect(offeredNames(requests[0])).not.toContain("adversarial_review");
    } finally {
        attachment.detach();
        resident.close();
        await expect(loop).rejects.toBeInstanceOf(ResidentAgentClosedError);
        await rm(root, { recursive: true, force: true });
    }
});

function capturingAdapter(requests: ModelRequest[]): ModelAdapter {
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "test", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const scripted = new FauxAdapter([response]);
    return {
        stream(request) {
            requests.push(request);
            return scripted.stream(request);
        },
    };
}

function offeredNames(request: ModelRequest | undefined): readonly string[] {
    return request?.tools?.map((tool) => tool.name) ?? [];
}

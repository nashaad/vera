import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type TuiAgentClient,
    type TuiDependencies,
} from "../../../clients/tui/main.ts";
import { createInProcessChannel } from "../../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../../src/engine/run-turn.ts";
import { HOST_CAPABILITY_SKILL_COMMANDS } from
    "../../../src/host/capabilities.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../../src/model/types.ts";
import { FauxAdapter } from "../../support/faux-adapter.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("skill slash commands discover, dispatch, and stay visible", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-skill-"));
    const session = await startTuiTestSession({
        home,
        dependencies: skillDependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("/dep");
        await session.waitForVisiblePane("/deploy  Deploy the current service");
        session.sendKey("Tab");
        session.sendText(" staging");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("DEPLOYED");
        expect(pane).toContain("/deploy staging");
        await session.waitForVisiblePane("ready · ctrl+p commands");
    } finally {
        await session.close();
    }
}, 15_000);

function skillDependencies(): TuiDependencies {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([response("DEPLOYED")]),
        "test",
        "high",
        { approvalMode: "auto" },
        {
            readModelSettings: () => ({
                model: "test",
                reasoningEffort: "high",
            }),
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
            router: {
                updateModelSettings: async () => undefined,
                listSkills: async () => ({
                    skills: [{
                        name: "deploy",
                        description: "Deploy the current service",
                        disableModelInvocation: true,
                    }],
                    warnings: [],
                }),
                invokeSkill: async (name) => name === "deploy"
                    ? { allowed: true }
                    : { allowed: false, reason: `/${name} is unavailable.` },
            },
        },
    );

    const client: TuiAgentClient = {
        capabilities: [HOST_CAPABILITY_SKILL_COMMANDS],
        supportsHostCapability: (capability) =>
            capability === HOST_CAPABILITY_SKILL_COMMANDS,
        async send(command): Promise<void> {
            channel.client.send(command);
        },
        receive(signal) {
            return channel.client.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
    return { client };
}

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

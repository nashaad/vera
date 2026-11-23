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

// Stands in for the config edit a skill's disabled_skills entry comes from: the
// host reads the file again on every list_skills request, so only the TUI's
// decision to ask again is under test.
let skillEnabled = true;

test("closing /plugins or /customize leaves a skill turned off out of the / menu", async () => {
    skillEnabled = true;
    const home = mkdtempSync(join(tmpdir(), "vera-tui-skill-menu-"));
    const session = await startTuiTestSession({
        home,
        dependencies: skillDependencies,
    });

    try {
        await session.waitForVisiblePane("Start a conversation");

        // Offered while it is on, so the check below can tell "gone" from "never there".
        session.sendText("/dep");
        await session.waitForVisiblePane("/deploy");
        session.sendKey("Escape");
        await session.settle(100);

        // Turned off while /plugins is open, then /plugins closes.
        session.sendText("/plugins");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Plugins");
        skillEnabled = false;
        session.sendKey("Escape");
        await session.settle(500);

        // Gone from the / menu, with no message sent and no restart.
        session.sendText("/dep");
        await session.settle(500);
        const gone = session.captureVisiblePane();
        expect(gone).toContain("/dep");
        expect(gone).not.toContain("/deploy");
        session.sendKey("Escape");
        await session.settle(100);

        // Turned back on, it returns the same way.
        session.sendText("/customize");
        session.sendKey("Enter");
        await session.waitForVisiblePane("Plugins");
        skillEnabled = true;
        session.sendKey("Escape");
        await session.settle(500);

        session.sendText("/dep");
        const back = await session.waitForVisiblePane("/deploy");
        expect(back).toContain("Deploy the current service");
    } finally {
        await session.close();
    }
}, 30_000);

function skillDependencies(): TuiDependencies {
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([response("ok")]),
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
                    skills: skillEnabled
                        ? [{
                            name: "deploy",
                            description: "Deploy the current service",
                            disableModelInvocation: false,
                        }]
                        : [],
                    warnings: [],
                }),
                invokeSkill: async (name: string) => skillEnabled
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

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveTuiPersistedAgentPane } from "../../../clients/tui/theme-preference.ts";
import type { RegisteredAgentSummary } from "../../../src/host/agent-registry.ts";
import { HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE } from "../../../src/host/capabilities.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";
import { createTuiResumeScenario } from "../../support/tui-resume-child.ts";

async function startQuitScenario(count: number) {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-quit-background-"));
    const scenario = createTuiResumeScenario({ home });
    const released: string[] = [];
    const client = createSettingsAnsweringClient({
        agentId: "current-session-id",
        model: "current-model",
        mode: "review",
        supportsHostCapability: (capability) => capability === HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
        release: async (policy) => {
            released.push(policy);
            return { outcome: "detached", remainingInteractiveClients: 0 };
        },
    });
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            ...scenario.dependencies,
            client,
            listSessionPage: async () => ({
                agents: [{ id: client.agentId, background_commands: count } as RegisteredAgentSummary],
            }),
        }),
    });
    await session.waitForVisiblePane("Start a conversation");
    return { session, released };
}

async function pressQuit(session: Awaited<ReturnType<typeof startTuiTestSession>>) {
    session.sendKey("C-c");
    await session.waitForVisiblePane("Press Ctrl+C again to quit");
    session.sendKey("C-c");
}

for (const [choice, policy] of [["1", "stop_if_last"], ["2", "keep_running"]] as const) {
    test(`@core quit choice ${choice} releases the attachment with ${policy}`, async () => {
        const { session, released } = await startQuitScenario(1);
        try {
            await pressQuit(session);
            const pane = await session.waitForVisiblePane("Stop them and quit");
            expect(pane.replace(/\s+/g, " ")).toContain("1 background command is running in this conversation.");
            session.sendText(choice);
            await session.waitForSessionExit();
            expect(released).toEqual([policy]);
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("@core Escape cancels the quit confirmation without releasing the attachment", async () => {
    const { session, released } = await startQuitScenario(1);
    try {
        await pressQuit(session);
        await session.waitForVisiblePane("Stop them and quit");
        session.sendKey("Escape");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("Stop them and quit") && pane.includes("Message Vera"),
            "the quit confirmation to close",
        );
        expect(released).toEqual([]);
        await pressQuit(session);
        await session.waitForVisiblePane("Stop them and quit");
        session.sendText("2");
        await session.waitForSessionExit();
        expect(released).toEqual(["keep_running"]);
    } finally {
        await session.close();
    }
}, 15_000);

for (const example of [
    { current: 0, other: 2, message: "2 background commands are running in another conversation.", choice: "2", policy: "keep_running" },
    { current: 1, other: 2, message: "3 background commands are running in 2 conversations.", choice: "1", policy: "stop_if_last" },
] as const) {
    test(`@core quit counts the attached sidebar with ${example.current} current commands`, async () => {
        const home = mkdtempSync(join(tmpdir(), "vera-tui-quit-sidebar-"));
        const scenario = createTuiResumeScenario({ home });
        saveTuiPersistedAgentPane("current-session-id", {
            mainAgentId: "current-session-id",
            sidebarAgentId: "sidebar-session-id",
            owner: "vera.btw",
        }, join(home, ".vera", "tui.json"));
        const released: string[] = [];
        const makeClient = (id: string) => createSettingsAnsweringClient({
            agentId: id,
            model: "current-model",
            mode: "review",
            initialUpdates: id === "sidebar-session-id" ? [{
                type: "history", entries: [{ kind: "assistant", text: "SIDEBAR READY" }], seq: 0,
            }] : [],
            supportsHostCapability: (capability) => capability === HOST_CAPABILITY_AGENT_ATTACHMENT_RELEASE,
            release: async (policy) => {
                released.push(`${id}:${policy}`);
                return { outcome: "detached", remainingInteractiveClients: 0 };
            },
        });
        const session = await startTuiTestSession({
            home,
            dependencies: () => ({
                ...scenario.dependencies,
                client: makeClient("current-session-id"),
                attachAgent: async () => makeClient("sidebar-session-id"),
                listSessionPage: async () => ({ agents: [
                    { id: "current-session-id", background_commands: example.current },
                    { id: "sidebar-session-id", background_commands: example.other },
                ] as RegisteredAgentSummary[] }),
            }),
        });
        try {
            await session.waitForVisiblePane("SIDEBAR READY");
            session.sendKey("C-g");
            await session.waitForVisiblePane("Message Vera");
            await pressQuit(session);
            const pane = await session.waitForVisiblePane("Stop them and quit");
            expect(pane.replace(/\s+/g, " ")).toContain(example.message);
            session.sendText(example.choice);
            await session.waitForSessionExit();
            expect(released).toEqual([
                `current-session-id:${example.policy}`,
                `sidebar-session-id:${example.policy}`,
            ]);
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("@core quitting with zero background commands skips the confirmation", async () => {
    const { session, released } = await startQuitScenario(0);
    try {
        await pressQuit(session);
        await session.waitForSessionExit();
        expect(released).toEqual(["stop_if_last"]);
    } finally {
        await session.close();
    }
}, 15_000);

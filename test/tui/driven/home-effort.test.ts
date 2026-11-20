import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentUpdate, ClientCommand } from "../../../src/engine/protocol.ts";
import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const levels = [
    { id: "low", label: "Low", description: "A little reasoning." },
    { id: "high", label: "High", description: "Deep reasoning." },
] as const;

const availableModels = [
    {
        provider: "dpsk",
        model: "pro",
        label: "DeepSeek Pro",
        description: "",
        levels,
        defaultLevel: "low",
    },
] as const;

function homeSettings(reasoningEffort?: string) {
    return {
        provider: "dpsk",
        model: "pro",
        availableModels,
        pooled: [],
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
}

function homeDependencies(sent: ClientCommand[]): TuiDependencies {
    return {
        client: createHomeClient("/work/vera", {
            readModelSettings: async () => homeSettings("low"),
        }),
        homeHasSessions: false,
        createSession: async () =>
            createSettingsAnsweringClient({
                agentId: "new-session-id",
                model: "pro",
                mode: "review",
                modelSettings: {
                    provider: "dpsk",
                    availableModels,
                },
                onCommand: (command, push) => {
                    sent.push(command);
                    if (command.type === "update_model_settings") {
                        push({
                            type: "model_settings",
                            requestId: command.requestId,
                            settings: homeSettings(
                                command.patch.reasoningEffort ?? undefined,
                            ),
                            pending: false,
                            seq: 99,
                        });
                    }
                },
            }),
    };
}

test("an effort set on the start screen applies to the conversation the next message starts", async () => {
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-effort-")),
        dependencies: () => homeDependencies(sent),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await session.settle(300);
        session.sendText("/effort high");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("reasoning effort set");
        expect(pane).not.toContain("There is no conversation open yet");
        expect(pane).not.toContain("/effort high");
        expect(pane).toContain("high");
        expect(sent).toEqual([]);

        session.sendText("write hello");
        session.sendKey("Enter");
        await session.waitForVisiblePane("write hello");
        const started = await session.waitForVisiblePane("dpsk/DeepSeek Pro · high");
        expect(started).not.toContain("There is no conversation open yet");
        const settings = sent.filter((command) =>
            command.type === "update_model_settings"
        );
        expect(settings).toHaveLength(1);
        expect(settings[0]).toMatchObject({
            patch: { reasoningEffort: "high" },
        });
        const prompt = sent.find((command) => command.type === "prompt");
        expect(prompt).toMatchObject({ content: "write hello" });
        expect(sent.indexOf(settings[0]!)).toBeLessThan(sent.indexOf(prompt!));
    } finally {
        await session.close();
    }
}, 20_000);

test("an effort level is refused when the model has no effort setting", async () => {
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-effort-none-")),
        dependencies: () => ({
            client: createSettingsAnsweringClient({
                agentId: "plain-session",
                model: "openai/gpt-5.6-luna",
                mode: "review",
                modelSettings: {
                    provider: "openrouter",
                    availableModels: [{
                        provider: "openrouter",
                        model: "openai/gpt-5.6-luna",
                        label: "Luna",
                        description: "",
                        levels: [],
                    }],
                },
                onCommand: (command: ClientCommand, push: (update: AgentUpdate) => void) => {
                    sent.push(command);
                    if (command.type === "update_model_settings") {
                        push({
                            type: "model_settings",
                            requestId: command.requestId,
                            settings: {
                                provider: "openrouter",
                                model: "openai/gpt-5.6-luna",
                            },
                            pending: false,
                            seq: 99,
                        });
                    }
                },
            }),
            homeHasSessions: false,
        }),
    });

    try {
        await session.waitForVisiblePane("Start a conversation with Vera");
        session.sendText("/effort high");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane(
            "has no reasoning effort setting",
        );
        expect(pane).toContain("openrouter/openai/gpt-5.6-luna");
        expect(
            sent.some((command) => command.type === "update_model_settings"),
        ).toBe(false);
    } finally {
        await session.close();
    }
}, 20_000);

test("a level picked from Settings on the start screen is held for the first conversation", async () => {
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-effort-settings-")),
        dependencies: () => homeDependencies(sent),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        await session.settle(300);
        session.sendText("/effort");
        session.sendKey("Enter");
        await session.waitForVisiblePane("High");
        session.sendKey("Down");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("reasoning effort set");
        expect(pane).not.toContain("There is no conversation open yet");
        expect(pane).toContain("high");
        expect(sent).toEqual([]);

        session.sendText("write hello");
        session.sendKey("Enter");
        await session.waitForVisiblePane("dpsk/DeepSeek Pro · high");
        const settings = sent.filter((command) =>
            command.type === "update_model_settings"
        );
        expect(settings).toHaveLength(1);
        expect(settings[0]).toMatchObject({
            patch: { reasoningEffort: "high" },
        });
    } finally {
        await session.close();
    }
}, 20_000);

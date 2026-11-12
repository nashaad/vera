import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientCommand } from "../../../src/engine/protocol.ts";
import type { TuiDependencies } from "../../../clients/tui/main.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { createSettingsAnsweringClient } from "../../support/settings-answering-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function homeDependencies(sent: ClientCommand[]): TuiDependencies {
    return {
        client: createHomeClient("/work/vera"),
        homeHasSessions: false,
        createSession: async () =>
            createSettingsAnsweringClient({
                agentId: "new-session-id",
                model: "new-model",
                mode: "review",
                onCommand: (command, push) => {
                    sent.push(command);
                    if (command.type === "update_session_name") {
                        push({
                            type: "session_name",
                            requestId: command.requestId,
                            name: command.name,
                        });
                    }
                },
            }),
    };
}

test("a name set on the start screen goes to the conversation the next message starts", async () => {
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-rename-")),
        dependencies: () => homeDependencies(sent),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/rename telemetry");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("session name set");
        expect(pane).not.toContain("There is no conversation open yet");
        expect(pane).not.toContain("/rename telemetry");
        expect(sent).toEqual([]);

        session.sendText("write hello");
        session.sendKey("Enter");
        await session.waitForVisiblePane("session renamed: telemetry");
        const names = sent.filter((command) =>
            command.type === "update_session_name"
        );
        expect(names).toHaveLength(1);
        expect(names[0]).toMatchObject({ name: "telemetry" });
        const prompt = sent.find((command) => command.type === "prompt");
        expect(prompt).toMatchObject({ content: "write hello" });
        expect(sent.indexOf(names[0]!)).toBeLessThan(sent.indexOf(prompt!));
    } finally {
        await session.close();
    }
}, 20_000);

test("a rejected name still clears the composer and keeps nothing", async () => {
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-rename-bad-")),
        dependencies: () => homeDependencies(sent),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText(`/rename ${"x".repeat(201)}`);
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane(
            "Session name must be 1 to 200 UTF-8 bytes",
        );
        expect(pane).not.toContain("xxxxxxxxxx");

        session.sendText("write hello");
        session.sendKey("Enter");
        await session.settle(500);
        expect(sent.some((command) => command.type === "update_session_name"))
            .toBe(false);
        expect(sent.some((command) => command.type === "prompt")).toBe(true);
    } finally {
        await session.close();
    }
}, 20_000);

test("a bare /rename on the start screen drops the held name", async () => {
    const sent: ClientCommand[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-rename-clear-")),
        dependencies: () => homeDependencies(sent),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/rename first");
        session.sendKey("Enter");
        await session.waitForVisiblePane("session name set");
        session.sendText("/rename");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("session name cleared");
        expect(pane).not.toContain("There is no conversation open yet");

        session.sendText("write hello");
        session.sendKey("Enter");
        await session.settle(500);
        expect(sent.some((command) => command.type === "update_session_name"))
            .toBe(false);
    } finally {
        await session.close();
    }
}, 20_000);

test("Ctrl+U clears the composer line on the start screen", async () => {
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-tui-home-ctrl-u-")),
        dependencies: () => homeDependencies([]),
    });

    try {
        await session.waitForVisiblePane("V  E  R  A");
        session.sendText("/rename keepme");
        await session.waitForVisiblePane("/rename keepme");
        session.sendKey("C-u");
        await session.waitForVisiblePaneWhere(
            (pane) => !pane.includes("keepme"),
            "the composer line to clear",
        );
    } finally {
        await session.close();
    }
}, 20_000);

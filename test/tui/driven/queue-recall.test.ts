import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../../src/engine/protocol.ts";
import { createTuiChildDependencies } from "../../support/tui-child.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("Up on an empty composer takes the newest queued prompt back for editing", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-queue-recall-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("start streaming");
        session.sendKey("Enter");
        await session.waitForVisiblePane("PARTIAL xxxxx");
        session.sendText("first follow-up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("queued · first follow-up");
        session.sendText("second follow-up");
        session.sendKey("Enter");
        await session.waitForVisiblePane("+1");

        session.sendKey("Up");
        const recalled = await session.waitForVisiblePaneWhere(
            (pane) =>
                pane.includes("queued · first follow-up")
                && !pane.includes("+1")
                && pane.includes("second follow-up"),
            "newest prompt back in the composer",
        );
        expect(recalled).not.toContain("queued · second follow-up");

        session.sendText(" edited");
        session.sendKey("Enter");
        const requeued = await session.waitForVisiblePane("+1");
        expect(requeued).toContain("queued · first follow-up");
    } finally {
        await session.close();
    }
}, 20_000);

test("Up with nothing queued still recalls the last submission", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-queue-recall-history-"));
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => createTuiChildDependencies(),
    });

    try {
        await session.waitForVisiblePane("Start a conversation");
        session.sendText("start streaming");
        session.sendKey("Enter");
        const before = await session.waitForVisiblePane("PARTIAL xxxxx");
        const shown = (pane: string): number => pane.split("start streaming").length - 1;
        session.sendKey("Up");
        const after = await session.waitForVisiblePaneWhere(
            (pane) => shown(pane) === shown(before) + 1,
            "last submission back in the composer",
        );
        expect(after).not.toContain("Nothing to recall");
    } finally {
        await session.close();
    }
}, 20_000);

test("a recalled prompt brings its image back and resubmits it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-tui-queue-recall-image-"));
    const updates = new AsyncQueue<AgentUpdate>();
    const sent: ClientCommand[] = [];
    updates.push({
        type: "history",
        entries: [{ kind: "assistant", text: "One prompt is waiting." }],
        promptQueue: {
            draining: false,
            prompts: [{
                content: "describe this",
                attachmentIds: ["image-1"],
                state: "held",
            }],
        },
        seq: 0,
    });
    const client: TuiAgentClient = {
        async send(command: ClientCommand): Promise<void> {
            sent.push(command);
            if (command.type !== "withdraw_queued_prompt") return;
            updates.push({
                type: "prompt_queue",
                queue: { draining: false, prompts: [] },
                seq: 1,
            });
            updates.push({
                type: "prompt_withdrawn",
                requestId: command.requestId,
                content: "describe this",
                attachmentIds: ["image-1"],
                seq: 2,
            });
        },
        receive(signal) {
            return updates.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
    const session = await startTuiTestSession({
        home,
        width: 100,
        height: 31,
        dependencies: () => ({ client }),
    });

    try {
        await session.waitForVisiblePane("queued · [Image] describe this");
        session.sendKey("Up");
        const recalled = await session.waitForVisiblePaneWhere(
            (pane) => pane.includes("[Image 1]") && !pane.includes("queued ·"),
            "image chip back in the composer",
        );
        expect(recalled).toContain("describe this");

        session.sendText(" again");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(
            () => sent.some((command) => command.type === "prompt"),
            "edited prompt submitted",
        );
        const prompt = sent.find((command) => command.type === "prompt");
        expect(prompt).toMatchObject({
            type: "prompt",
            attachmentIds: ["image-1"],
        });
        expect(prompt?.type === "prompt" ? prompt.content : "").toContain("describe this again");
        expect(sent.filter((command) => command.type === "withdraw_queued_prompt")).toHaveLength(1);
    } finally {
        await session.close();
    }
}, 20_000);

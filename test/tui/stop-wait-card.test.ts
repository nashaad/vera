import { describe, expect, test } from "bun:test";

import type { UiResponseCommand } from "../../src/engine/protocol.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { answerStopWaitCard, stopWaitNow } from "../../clients/tui/main/agents-dials.ts";
import { STOP_WAIT_KEEP_CHOICE, STOP_WAIT_STOP_CHOICE } from "../../clients/tui/stop-wait.ts";

const waitingOn = [
    { session_id: "a1", name: "Fix parser", status: "working" as const },
    { session_id: "b2", name: null, status: "queued" as const },
];

function answer(choiceId: string): UiResponseCommand {
    return {
        type: "ui_response",
        requestId: "stop-wait",
        response: { type: "user_question", outcome: "selected", choiceId },
    } as unknown as UiResponseCommand;
}

function fakeRuntime(aborted: string[]): TuiRuntime {
    const composer = {
        plainText: "half typed prompt",
        focused: false,
        blur() {
            composer.focused = false;
        },
        focus() {
            composer.focused = true;
        },
    };
    return {
        client: { agentId: "agent-1" },
        composer,
        pendingImages: [{ id: "img-1" }],
        sidebar: { isFocused: () => false },
        experimentalTuiHost: { hasModal: () => false },
        stopWait: { kind: "stop", waitingOn },
        stopWaitCard: { key: "stop:a1,b2", open: true },
        dependencies: {
            abortAgent: async (agentId: string) => {
                aborted.push(agentId);
            },
        },
    } as unknown as TuiRuntime;
}

describe("stop-wait card answers", () => {
    test("Stop it now ends every session the wait is on", async () => {
        const aborted: string[] = [];
        const rt = fakeRuntime(aborted);
        answerStopWaitCard(rt, answer(STOP_WAIT_STOP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(aborted).toEqual(["a1", "b2"]);
        expect(rt.stopWaitCard?.open).toBe(false);
    });

    test("Keep waiting ends nothing and closes the card", () => {
        const aborted: string[] = [];
        const rt = fakeRuntime(aborted);
        answerStopWaitCard(rt, answer(STOP_WAIT_KEEP_CHOICE));
        expect(aborted).toEqual([]);
        expect(rt.stopWaitCard?.open).toBe(false);
        expect(rt.stopWait).toBeDefined();
    });

    test("both answers leave the composer draft and attachments untouched", async () => {
        for (const choice of [STOP_WAIT_STOP_CHOICE, STOP_WAIT_KEEP_CHOICE]) {
            const rt = fakeRuntime([]);
            answerStopWaitCard(rt, answer(choice));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(rt.composer.plainText).toBe("half typed prompt");
            expect(rt.pendingImages.map((image) => image.id)).toEqual(["img-1"]);
        }
    });

    test("stopWaitNow does nothing without an open wait or an abort seam", async () => {
        const aborted: string[] = [];
        const rt = fakeRuntime(aborted);
        rt.stopWait = undefined;
        await stopWaitNow(rt);
        expect(aborted).toEqual([]);
    });
});

describe("stopWaitNow", () => {
    test("aborts each waiting session by id", async () => {
        const aborted: string[] = [];
        await stopWaitNow(fakeRuntime(aborted));
        expect(aborted).toEqual(["a1", "b2"]);
    });
});

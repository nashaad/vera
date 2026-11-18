import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import type { UiResponseCommand } from "../../src/engine/protocol.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { answerStopWaitCard, stopWaitNow } from "../../clients/tui/main/agents-dials.ts";
import { createTuiQuestionView } from "../../clients/tui/question.ts";
import {
    nextStopWaitCard,
    STOP_WAIT_KEEP_CHOICE,
    STOP_WAIT_STOP_CHOICE,
    stopWaitCardUpdate,
    type TuiStopWait,
} from "../../clients/tui/stop-wait.ts";

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

function fakeRuntime(cuts: string[]): TuiRuntime {
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
            cutStopWait: async () => {
                cuts.push("cut");
                return { type: "cut_stop_wait_done", cut: ["a1", "b2"], failed: [] };
            },
        },
    } as unknown as TuiRuntime;
}

describe("stop-wait card", () => {
    test("names the stop or update and summarizes the waited sessions", () => {
        const cases: { wait: TuiStopWait; title: string }[] = [
            {
                wait: { kind: "stop", waitingOn: [waitingOn[0]!] },
                title: "Vera stops when running turns finish. Waiting for Fix parser.",
            },
            {
                wait: { kind: "stop", waitingOn },
                title: "Vera stops when running turns finish. Waiting for Fix parser and 1 more.",
            },
            {
                wait: { kind: "update", targetBuildId: "build-42", waitingOn: [waitingOn[1]!] },
                title: "Vera updates to build-42 when running turns finish. Waiting for b2.",
            },
            {
                wait: { kind: "update", targetBuildId: "build-42", waitingOn },
                title: "Vera updates to build-42 when running turns finish. Waiting for Fix parser and 1 more.",
            },
            {
                wait: { kind: "stop", waitingOn: [...waitingOn, { session_id: "c3", name: null, status: "working" }] },
                title: "Vera stops when running turns finish. Waiting for Fix parser and 2 more.",
            },
            {
                wait: { kind: "stop", waitingOn: [] },
                title: "Vera stops when running turns finish.",
            },
        ];

        for (const { wait, title } of cases) {
            const update = stopWaitCardUpdate(wait, nextStopWaitCard(undefined, wait));
            expect(update?.request.question).toBe(title);
            expect(update?.request.allowCustom).toBe(false);
            expect(update?.request.allowNotes).toBe(false);
            expect(update?.request.choices).toEqual([
                { id: STOP_WAIT_KEEP_CHOICE, label: "Keep waiting" },
                { id: STOP_WAIT_STOP_CHOICE, label: "Stop it now" },
            ]);
        }
    });

    test("an open card updates its title as the wait changes", () => {
        const initial: TuiStopWait = { kind: "stop", waitingOn };
        const card = nextStopWaitCard(undefined, initial)!;
        const next: TuiStopWait = { kind: "stop", waitingOn: [waitingOn[1]!] };
        const updatedCard = nextStopWaitCard(card, next)!;
        const update = stopWaitCardUpdate(next, updatedCard);

        expect(updatedCard.requestId).toBe(card.requestId);
        expect(update?.request.question).toBe("Vera stops when running turns finish. Waiting for b2.");
    });

    for (const [width, height] of [[80, 24], [120, 36]] as const) {
        test(`the update card retains spacing at ${width}x${height}`, async () => {
            const wait: TuiStopWait = { kind: "update", targetBuildId: "build-42", waitingOn };
            const update = stopWaitCardUpdate(wait, nextStopWaitCard(undefined, wait))!;
            const setup = await createTestRenderer({ width, height });
            const view = createTuiQuestionView(setup.renderer);
            setup.renderer.root.add(view.box);
            view.box.visible = true;
            view.update(update);

            try {
                await setup.flush();
                const lines = setup.captureCharFrame().split("\n");
                const text = lines.map((line) => line.replaceAll("┃", "")).join(" ").replace(/\s+/g, " ");
                expect(text).toContain("Vera updates to build-42 when running turns finish. Waiting for Fix parser and 1 more.");
                const title = lines.findIndex((line) => line.includes("Vera updates to build-42"));
                const rule = lines.findIndex((line) => line.includes("───"));
                const keep = lines.findIndex((line) => line.includes("1. Keep waiting"));
                const stop = lines.findIndex((line) => line.includes("2. Stop it now"));
                const footer = lines.findIndex((line) => line.includes("esc dismiss"));
                expect(title).toBeGreaterThan(1);
                expect(rule).toBeGreaterThan(title);
                expect(keep - rule).toBe(2);
                expect(lines[rule + 1]!.replaceAll("┃", "").trim()).toBe("");
                expect(stop).toBe(keep + 1);
                expect(footer - stop).toBe(2);
                expect(lines[stop + 1]!.replaceAll("┃", "").trim()).toBe("");
                expect(footer).toBeLessThan(height - 1);
                for (const index of [title, keep, stop, footer]) {
                    expect(lines[index]!.trimEnd().length).toBeLessThan(width);
                }
                expect(text).not.toContain("recommended");
                expect(text).not.toContain("Other");
                expect(text).not.toContain("notes");
            } finally {
                setup.renderer.destroy();
            }
        });
    }

    test("an opened card renders only the two choices and Enter keeps waiting", async () => {
        const wait: TuiStopWait = { kind: "stop", waitingOn };
        const update = stopWaitCardUpdate(wait, nextStopWaitCard(undefined, wait))!;
        const setup = await createTestRenderer({ width: 100, height: 24 });
        const view = createTuiQuestionView(setup.renderer);
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update(update);

        try {
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Vera stops when running turns finish. Waiting for Fix parser and 1 more.");
            expect(frame).toContain("1. Keep waiting");
            expect(frame).toContain("2. Stop it now");
            expect(frame).not.toContain("recommended");
            expect(frame).not.toContain("Other");
            expect(frame).not.toContain("notes");
            expect(view.handleKey(update, { name: "3", sequence: "3" }).response).toBeUndefined();
            expect(view.handleKey(update, { name: "tab" }).response).toBeUndefined();

            const response = view.handleKey(update, { name: "enter" }).response;
            expect(response?.response).toEqual({
                type: "user_question",
                outcome: "selected",
                choiceId: STOP_WAIT_KEEP_CHOICE,
            });
            const cuts: string[] = [];
            const rt = fakeRuntime(cuts);
            answerStopWaitCard(rt, response);
            expect(cuts).toEqual([]);
            expect(rt.stopWaitCard?.open).toBe(false);
            expect(rt.stopWait).toBeDefined();

            view.handleKey(update, { name: "down" });
            const stopResponse = view.handleKey(update, { name: "enter" }).response;
            expect(stopResponse?.response).toEqual({
                type: "user_question",
                outcome: "selected",
                choiceId: STOP_WAIT_STOP_CHOICE,
            });
            await answerStopWaitCard(fakeRuntime(cuts), stopResponse);
            expect(cuts).toEqual(["cut"]);
        } finally {
            setup.renderer.destroy();
        }
    });
});

describe("stop-wait card answers", () => {
    test("Stop it now asks the host to cut the wait once", async () => {
        const cuts: string[] = [];
        const rt = fakeRuntime(cuts);
        answerStopWaitCard(rt, answer(STOP_WAIT_STOP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cuts).toEqual(["cut"]);
        expect(rt.stopWaitCard?.open).toBe(false);
    });

    test("Keep waiting ends nothing and closes the card", () => {
        const cuts: string[] = [];
        const rt = fakeRuntime(cuts);
        answerStopWaitCard(rt, answer(STOP_WAIT_KEEP_CHOICE));
        expect(cuts).toEqual([]);
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

    test("stopWaitNow does nothing without an open wait", async () => {
        const cuts: string[] = [];
        const rt = fakeRuntime(cuts);
        rt.stopWait = undefined;
        await stopWaitNow(rt);
        expect(cuts).toEqual([]);
    });
});

describe("stopWaitNow", () => {
    test("sends one cut for the open wait", async () => {
        const cuts: string[] = [];
        await stopWaitNow(fakeRuntime(cuts));
        expect(cuts).toEqual(["cut"]);
    });
});

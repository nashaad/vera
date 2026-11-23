import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import type { UiResponseCommand } from "../../src/engine/protocol.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import type { RequestStopWaitWrapUpOutcome } from "../../src/host/stop-wait-wrap-up-client.ts";
import { answerStopWaitCard, stopWaitNow } from "../../clients/tui/main/agents-dials.ts";
import { createTuiQuestionView } from "../../clients/tui/question.ts";
import {
    nextStopWaitCard,
    STOP_WAIT_KEEP_CHOICE,
    STOP_WAIT_WRAP_UP_CHOICE,
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

function fakeRuntime(
    cuts: string[],
    wrapUps: (string | undefined)[] = [],
    askWrapUp?: (notes?: string) => Promise<RequestStopWaitWrapUpOutcome>,
): TuiRuntime {
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
        shuttingDown: true,
        questionView: { focus() {} },
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
            askStopWaitWrapUp: async (notes?: string) => {
                wrapUps.push(notes);
                return askWrapUp === undefined
                    ? { type: "ask_stop_wait_wrap_up_done", offered: ["a1"] }
                    : await askWrapUp(notes);
            },
        },
    } as unknown as TuiRuntime;
}

describe("stop-wait card", () => {
    test("names the stop or update and summarizes the waited sessions", () => {
        const cases: { wait: TuiStopWait; title: string }[] = [
            {
                wait: { kind: "stop", waitingOn: [waitingOn[0]!] },
                title: "Vera is shutting down (an update, install or vera host stop asked it to), but 1 conversation is still working: Fix parser. Nothing new can start until it stops.",
            },
            {
                wait: { kind: "stop", waitingOn },
                title: "Vera is shutting down (an update, install or vera host stop asked it to), but 2 conversations are still working: Fix parser and 1 more. Nothing new can start until it stops.",
            },
            {
                wait: { kind: "update", targetBuildId: "build-42", waitingOn: [waitingOn[1]!] },
                title: "Vera is updating to build-42, but 1 conversation is still working: b2. Nothing new can start until it stops.",
            },
            {
                wait: { kind: "update", targetBuildId: "build-42", waitingOn },
                title: "Vera is updating to build-42, but 2 conversations are still working: Fix parser and 1 more. Nothing new can start until it stops.",
            },
            {
                wait: { kind: "stop", waitingOn: [...waitingOn, { session_id: "c3", name: null, status: "working" }] },
                title: "Vera is shutting down (an update, install or vera host stop asked it to), but 3 conversations are still working: Fix parser and 2 more. Nothing new can start until it stops.",
            },
            {
                wait: { kind: "stop", waitingOn: [] },
                title: "Vera is shutting down (an update, install or vera host stop asked it to). Nothing new can start until it stops.",
            },
        ];

        for (const { wait, title } of cases) {
            const update = stopWaitCardUpdate(wait, nextStopWaitCard(undefined, wait));
            expect(update?.request.question).toBe(title);
            expect(update?.request.allowCustom).toBe(false);
            expect(update?.request.allowNotes).toBe(true);
            expect(update?.request.choices).toEqual([
                {
                    id: STOP_WAIT_KEEP_CHOICE,
                    label: "Keep waiting",
                    description: "It stops when they finish.",
                },
                {
                    id: STOP_WAIT_WRAP_UP_CHOICE,
                    label: "Ask them to wrap up",
                    description: "Each one finishes its current step, says what is left, and ends its turn.",
                },
                {
                    id: STOP_WAIT_STOP_CHOICE,
                    label: "Stop them now",
                    description: "Cancels their running turns and drops queued prompts.",
                },
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
        expect(update?.request.question).toBe("Vera is shutting down (an update, install or vera host stop asked it to), but 1 conversation is still working: b2. Nothing new can start until it stops.");
    });

    for (const [width, height] of [[80, 24], [120, 40]] as const) {
        for (const wait of [
            { kind: "stop", waitingOn },
            { kind: "update", targetBuildId: "vera-d4b17481a+cc9e86c75a86", waitingOn },
        ] satisfies TuiStopWait[]) {
            test(`the ${wait.kind} card retains spacing at ${width}x${height}`, async () => {
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
                    expect(text).toContain(update.request.question);
                    expect(text).toContain("It stops when they finish.");
                    expect(text).toContain("Each one finishes its current step, says what is left, and ends its turn.");
                    expect(text).toContain("Cancels their running turns and drops queued prompts.");
                    const title = lines.findIndex((line) => line.includes(wait.kind === "update" ? "Vera is updating" : "Vera is shutting down"));
                    const rule = lines.findIndex((line) => line.includes("───"));
                    const keep = lines.findIndex((line) => line.includes("1. Keep waiting"));
                    const wrapUp = lines.findIndex((line) => line.includes("2. Ask them to wrap up"));
                    const stop = lines.findIndex((line) => line.includes("3. Stop them now"));
                    const footer = lines.findIndex((line) => line.includes("esc dismiss"));
                    const visibleText = (line: string) => line.replaceAll("┃", "").replaceAll("█", "").replaceAll("▀", "").trim();
                    expect(title).toBeGreaterThan(1);
                    expect(rule).toBeGreaterThan(title);
                    expect(keep - rule).toBe(2);
                    expect(visibleText(lines[rule + 1]!)).toBe("");
                    expect(wrapUp).toBe(keep + 2);
                    expect(stop).toBe(wrapUp + 3);
                    const lastDescription = lines.slice(stop + 1, footer).findLastIndex((line) => visibleText(line) !== "") + stop + 1;
                    expect(lastDescription).toBeGreaterThan(stop);
                    expect(footer - lastDescription).toBeGreaterThan(1);
                    expect(footer).toBeLessThan(height - 1);
                    for (const index of [title, keep, wrapUp, stop, footer]) {
                        expect(lines[index]!.trimEnd().length).toBeLessThan(width);
                    }
                    expect(text).not.toContain("recommended");
                    expect(text).not.toContain("Other");
                    expect(text).toContain("notes");
                } finally {
                    setup.renderer.destroy();
                }
            });
        }
    }

    test("an opened card renders all three choices, notes, and Enter keeps waiting", async () => {
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
            const text = frame.replaceAll("┃", "").replace(/\s+/g, " ");
            expect(text).toContain(update.request.question);
            expect(frame).toContain("1. Keep waiting");
            expect(frame).toContain("It stops when they finish.");
            expect(frame).toContain("2. Ask them to wrap up");
            expect(text).toContain("Each one finishes its current step, says what is left, and ends its turn.");
            expect(frame).toContain("3. Stop them now");
            expect(text).toContain("Cancels their running turns and drops queued prompts.");
            expect(frame).not.toContain("recommended");
            expect(frame).not.toContain("Other");
            expect(frame).toContain("notes");
            expect(view.handleKey(update, { name: "2", sequence: "2" }).response?.response).toEqual({
                type: "user_question",
                outcome: "selected",
                choiceId: STOP_WAIT_WRAP_UP_CHOICE,
            });
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

            const escapeResponse = view.handleKey(update, { name: "escape" }).response;
            const escapeRuntime = fakeRuntime([]);
            answerStopWaitCard(escapeRuntime, escapeResponse);
            expect(escapeRuntime.stopWaitCard?.open).toBe(false);
            const stopResponse = view.handleKey(update, { name: "3", sequence: "3" }).response;
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
    test("Stop them now asks the host to cut the wait once", async () => {
        const cuts: string[] = [];
        const rt = fakeRuntime(cuts);
        answerStopWaitCard(rt, answer(STOP_WAIT_STOP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(cuts).toEqual(["cut"]);
        expect(rt.stopWaitCard?.open).toBe(false);
    });

    test("a note entered in the card reaches the wrap-up request", async () => {
        const wait: TuiStopWait = { kind: "stop", waitingOn };
        const update = stopWaitCardUpdate(wait, nextStopWaitCard(undefined, wait))!;
        const setup = await createTestRenderer({ width: 100, height: 24 });
        const view = createTuiQuestionView(setup.renderer);
        setup.renderer.root.add(view.box);
        view.box.visible = true;
        view.update(update);
        const cuts: string[] = [];
        const wrapUps: (string | undefined)[] = [];
        const rt = fakeRuntime(cuts, wrapUps);

        try {
            view.handleKey(update, { name: "down" });
            view.handleKey(update, { name: "tab" });
            for (const name of "Finish the migration summary") {
                view.handleKey(update, { name, sequence: name });
            }
            const response = view.handleKey(update, { name: "enter" }).response;
            expect(response?.response).toEqual({
                type: "user_question",
                outcome: "selected",
                choiceId: STOP_WAIT_WRAP_UP_CHOICE,
                notes: "Finish the migration summary",
            });
            answerStopWaitCard(rt, response);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(wrapUps).toEqual(["Finish the migration summary"]);
            expect(cuts).toEqual([]);
            expect(rt.stopWait).toBeDefined();
        } finally {
            setup.renderer.destroy();
        }
    });

    test("Ask them to wrap up sends only the selected notes and leaves the wait open", async () => {
        const cuts: string[] = [];
        const wrapUps: (string | undefined)[] = [];
        const rt = fakeRuntime(cuts, wrapUps);
        answerStopWaitCard(rt, {
            ...answer(STOP_WAIT_WRAP_UP_CHOICE),
            response: {
                type: "user_question",
                outcome: "selected",
                choiceId: STOP_WAIT_WRAP_UP_CHOICE,
                notes: "Finish the migration summary",
            },
        });
        expect(wrapUps).toEqual(["Finish the migration summary"]);
        answerStopWaitCard(rt, answer(STOP_WAIT_WRAP_UP_CHOICE));
        expect(wrapUps).toEqual(["Finish the migration summary"]);
        expect(cuts).toEqual([]);
        expect(rt.stopWaitCard?.open).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rt.stopWaitCard?.wrapUpPending).toBe(false);
        expect(rt.stopWaitCard?.wrapUpSent).toBe(true);
        const sentUpdate = stopWaitCardUpdate(rt.stopWait, rt.stopWaitCard)!;
        expect(sentUpdate.requestId).toContain(":wrap-up-sent");
        expect(sentUpdate.request.choices[1]?.label).toBe("Asked them to wrap up");
        expect(sentUpdate.request.choices[1]?.description).toBe("Sent. Each one finishes its current step, says what is left, and ends its turn.");
        const sentCard = rt.stopWaitCard;
        const stateBeforeRepeat = rt.state;
        answerStopWaitCard(rt, answer(STOP_WAIT_WRAP_UP_CHOICE));
        expect(rt.stopWaitCard).toBe(sentCard);
        expect(rt.state).toBe(stateBeforeRepeat);
        expect(wrapUps).toEqual(["Finish the migration summary"]);
        expect(rt.stopWaitCard?.open).toBe(true);
        await stopWaitNow(rt);
        expect(cuts).toEqual(["cut"]);
        expect(rt.stopWaitCard?.open).toBe(true);
    });

    test("an empty wrap-up offer is reported and can be retried", async () => {
        const wrapUps: (string | undefined)[] = [];
        let attempts = 0;
        const rt = fakeRuntime([], wrapUps, async () => {
            attempts += 1;
            return attempts === 1
                ? { type: "ask_stop_wait_wrap_up_done", offered: [] }
                : { type: "ask_stop_wait_wrap_up_done", offered: ["a1"] };
        });
        answerStopWaitCard(rt, answer(STOP_WAIT_WRAP_UP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rt.stopWaitCard?.wrapUpSent).not.toBe(true);
        expect(rt.stopWaitCard?.wrapUpPending).toBe(false);
        expect(stopWaitCardUpdate(rt.stopWait, rt.stopWaitCard)?.request.choices[1]?.description)
            .toContain("No running turn took the wrap-up request");
        answerStopWaitCard(rt, answer(STOP_WAIT_WRAP_UP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(attempts).toBe(2);
        expect(rt.stopWaitCard?.wrapUpSent).toBe(true);
    });

    test("a refused wrap-up request is reported and can be retried", async () => {
        const wrapUps: (string | undefined)[] = [];
        let attempts = 0;
        const rt = fakeRuntime([], wrapUps, async () => {
            attempts += 1;
            return attempts === 1
                ? { type: "ask_stop_wait_wrap_up_refused", reason: "no_wait", message: "There is no stop wait" }
                : { type: "ask_stop_wait_wrap_up_done", offered: ["a1"] };
        });
        answerStopWaitCard(rt, answer(STOP_WAIT_WRAP_UP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rt.stopWaitCard?.wrapUpSent).not.toBe(true);
        answerStopWaitCard(rt, answer(STOP_WAIT_WRAP_UP_CHOICE));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(attempts).toBe(2);
        expect(rt.stopWaitCard?.wrapUpSent).toBe(true);
    });

    test("Keep waiting ends nothing and closes the card", () => {
        const cuts: string[] = [];
        const wrapUps: (string | undefined)[] = [];
        const rt = fakeRuntime(cuts, wrapUps);
        answerStopWaitCard(rt, {
            ...answer(STOP_WAIT_KEEP_CHOICE),
            response: {
                type: "user_question",
                outcome: "selected",
                choiceId: STOP_WAIT_KEEP_CHOICE,
                notes: "Do not send this note",
            },
        });
        expect(cuts).toEqual([]);
        expect(wrapUps).toEqual([]);
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

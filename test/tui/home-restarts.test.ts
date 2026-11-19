import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { RestartRecordWire } from "../../src/host/protocol.ts";
import { homeRestartsFor, listHomeRestarts } from "../../clients/tui/main/home-restarts.ts";
import {
    createHomeState,
    createTuiHomeView,
    handleHomeKey,
    homeCardLines,
    homeStateWithRestarts,
    HOME_CARD_COLUMNS,
    HOME_CONTENT_INDENT,
    type HomeAction,
    type HomeRestart,
    type HomeState,
} from "../../clients/tui/home-screen.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";

const restart = (
    sessionId: string,
    title: string,
    cause: HomeRestart["cause"] = "crash",
): HomeRestart => ({
    sessionId,
    sessionPath: `/sessions/${sessionId}.jsonl`,
    title,
    cause,
});

const withRestarts = (
    restarts: readonly HomeRestart[],
    base: HomeState = createHomeState(true),
): HomeState => homeStateWithRestarts(base, restarts);

const down = { name: "down" } as const;
const up = { name: "up" } as const;
const enter = { name: "return" } as const;
const del = { name: "delete" } as const;

const textOf = (state: HomeState): string[] =>
    homeCardLines(state).map((line) => line.text);

describe("the restart block on the home card", () => {
    test("is absent when no session was cut short", () => {
        expect(textOf(withRestarts([]))).toEqual(textOf(createHomeState(true)));
    });

    test("lists the cut sessions above the rows with a count", () => {
        const lines = textOf(withRestarts([
            restart("a", "Fix parser"),
            restart("b", "Release notes", "stop"),
        ]));
        expect(lines[3]).toBe("  Cut short (2)");
        expect(lines[4]).toBe(`  Fix parser${" ".repeat(15)}crashed`);
        expect(lines[5]).toBe(`  Release notes${" ".repeat(12)}stopped`);
        expect(lines[4]?.length).toBe(HOME_CARD_COLUMNS);
        expect(lines[6]).toBe("  enter opens  del dismisses");
        expect(lines[7]).toBe("");
        expect(lines[8]).toContain("New conversation");
    });

    test("names the cause of each entry", () => {
        const lines = textOf(withRestarts([
            restart("a", "One", "stop"),
            restart("b", "Two", "update"),
            restart("c", "Three", "crash"),
        ]));
        expect(lines.slice(4, 7).map((line) => line.trimEnd().slice(-7))).toEqual([
            "stopped",
            "updated",
            "crashed",
        ]);
    });

    test("truncates long titles so every line fits the card", () => {
        const state = withRestarts([
            restart("a", "A title that goes on for far longer than the card has room for"),
        ]);
        const entry = textOf(state)[4] ?? "";
        expect(entry.length).toBe(HOME_CARD_COLUMNS);
        expect(entry).toContain("…");
        for (const line of textOf(state)) {
            expect(line.length).toBeLessThanOrEqual(HOME_CARD_COLUMNS);
        }
    });

    for (const [width, height] of [[80, 24], [120, 40]] as const) {
        test(`aligns restart and menu rows on the rendered home card at ${width} columns`, async () => {
            const setup = await createTestRenderer({ width, height });
            const actions: HomeAction[] = [];
            const view = createTuiHomeView(setup.renderer, (action) => actions.push(action));
            setup.renderer.root.add(view.surface);
            view.surface.visible = true;
            const title = "Chart the crow's route to the treasure island";
            let state = withRestarts([restart("crow", title, "stop")]);
            try {
                view.update(state);
                await setup.renderOnce();
                const menuFrame = setup.captureCharFrame().split("\n");
                const headingRow = menuFrame.findIndex((line) => line.includes("Cut short (1)"));
                const restartRow = headingRow + 1;
                const menuRow = menuFrame.findIndex((line) => line.includes("New conversation"));
                const heading = menuFrame[headingRow]!;
                const unselectedRestart = menuFrame[restartRow]!;
                const selectedMenu = menuFrame[menuRow]!;
                const titleWidth = HOME_CARD_COLUMNS - HOME_CONTENT_INDENT - 1 - "stopped".length;
                const fittedTitle = `${title.slice(0, titleWidth - 1)}…`;
                const titleColumn = view.box.x + HOME_CONTENT_INDENT;
                expect(headingRow).toBeGreaterThanOrEqual(0);
                expect(menuRow).toBeGreaterThan(restartRow);
                expect(heading.indexOf("Cut short")).toBe(titleColumn);
                expect(unselectedRestart.indexOf("Chart")).toBe(titleColumn);
                expect(unselectedRestart).toContain(fittedTitle);
                expect(selectedMenu.indexOf("New conversation")).toBe(titleColumn);
                expect(unselectedRestart.indexOf("stopped") + "stopped".length)
                    .toBe(view.box.x + HOME_CARD_COLUMNS);
                expect(selectedMenu.indexOf("❯")).toBe(view.box.x);

                state = handleHomeKey(state, up).state!;
                view.update(state);
                await setup.renderOnce();
                const restartFrame = setup.captureCharFrame().split("\n");
                const selectedRestart = restartFrame[restartRow]!;
                const unselectedMenu = restartFrame[menuRow]!;
                expect(selectedRestart.indexOf(fittedTitle)).toBe(titleColumn);
                expect(selectedRestart.indexOf("❯")).toBe(selectedMenu.indexOf("❯"));
                expect(unselectedMenu.indexOf("New conversation")).toBe(titleColumn);
                expect(selectedRestart.indexOf("stopped") + "stopped".length)
                    .toBe(view.box.x + HOME_CARD_COLUMNS);
                expect(restartFrame.map((line) => line.replace("❯", " ")))
                    .toEqual(menuFrame.map((line) => line.replace("❯", " ")));

                await setup.mockMouse.click(view.box.x, restartRow);
                await setup.mockMouse.click(titleColumn, restartRow);
                await setup.mockMouse.click(view.box.x + HOME_CARD_COLUMNS - 1, restartRow);
                expect(actions).toEqual(Array.from({ length: 3 }, () => ({
                    kind: "open_restart",
                    sessionId: "crow",
                })));
            } finally {
                setup.renderer.destroy();
            }
        });
    }

    test("shows a window of three entries that keeps the cursor visible", () => {
        const many = ["a", "b", "c", "d", "e"].map((id) => restart(id, `Session ${id}`));
        const state = handleHomeKey(
            withRestarts(many, createHomeState(true)),
            up,
        ).state ?? withRestarts(many);
        const lines = homeCardLines(state).filter((line) => line.restartId !== undefined);
        expect(lines.length).toBe(3);
        expect(lines.some((line) => line.selected === true)).toBe(true);
        expect(lines.find((line) => line.selected === true)?.restartId).toBe("e");
    });
});

describe("keys across the restart block and the rows", () => {
    test("up from the first row enters the block at its last entry", () => {
        const state = withRestarts([restart("a", "One"), restart("b", "Two")]);
        const step = handleHomeKey(state, up).state;
        expect(step?.selectedRestartId).toBe("b");
    });

    test("down from the last entry returns to the first row", () => {
        const state = withRestarts([restart("a", "One")], {
            ...createHomeState(true),
            selectedId: "new",
        });
        const onEntry = handleHomeKey(state, up).state ?? state;
        const back = handleHomeKey(onEntry, down).state;
        expect(back?.selectedRestartId).toBeUndefined();
        expect(back?.selectedId).toBe("new");
    });

    test("the rows show no cursor while an entry holds it", () => {
        const state = withRestarts([restart("a", "One")]);
        const onEntry = handleHomeKey(state, up).state ?? state;
        const lines = homeCardLines(onEntry);
        expect(lines.filter((line) => line.tone === "row" && line.selected === true)).toEqual([]);
    });

    test("enter on an entry opens that session", () => {
        const state = withRestarts([restart("a", "One")]);
        const onEntry = handleHomeKey(state, up).state ?? state;
        expect(handleHomeKey(onEntry, enter).action).toEqual({
            kind: "open_restart",
            sessionId: "a",
        });
    });

    test("delete on an entry dismisses it", () => {
        const state = withRestarts([restart("a", "One")]);
        const onEntry = handleHomeKey(state, up).state ?? state;
        expect(handleHomeKey(onEntry, del).action).toEqual({
            kind: "dismiss_restart",
            sessionId: "a",
        });
    });

    test("delete on a row does nothing", () => {
        const state = withRestarts([restart("a", "One")]);
        expect(handleHomeKey(state, del)).toEqual({ handled: false });
    });

    test("enter on a row still starts the row's action", () => {
        const state = withRestarts([restart("a", "One")]);
        expect(handleHomeKey(state, enter).action).toEqual({ kind: "new_session" });
    });

    test("a cursor on a session that is no longer listed moves to the rows", () => {
        const state = withRestarts([restart("a", "One")]);
        const onEntry = handleHomeKey(state, up).state ?? state;
        const cleared = homeStateWithRestarts(onEntry, []);
        expect(cleared.selectedRestartId).toBeUndefined();
    });
});

describe("building the block from host records", () => {
    const agent = (id: string, title?: string): RegisteredAgentSummary => ({
        id,
        ...(title === undefined ? {} : { title }),
        workspace: "/work",
        session_path: `/sessions/${id}.jsonl`,
        kind: "session",
        status: "idle",
        live: false,
    }) as unknown as RegisteredAgentSummary;

    test("keeps the newest record per session and drops sessions the host does not list", () => {
        const records: RestartRecordWire[] = [
            { session_id: "a", cause: "stop", at: "2026-11-01T10:00:00.000Z" },
            { session_id: "a", cause: "crash", at: "2026-11-02T10:00:00.000Z" },
            { session_id: "gone", cause: "crash", at: "2026-11-03T10:00:00.000Z" },
        ];
        const found = homeRestartsFor(records, [agent("a", "Fix parser")]);
        expect(found).toEqual([{
            sessionId: "a",
            sessionPath: "/sessions/a.jsonl",
            title: "Fix parser",
            cause: "crash",
        }]);
    });

    test("a host that cannot answer the request shows no block", async () => {
        const rt = {
            dependencies: {
                restartRecords: {
                    list: async () => {
                        throw new Error("Host returned an invalid restart record list");
                    },
                    dismiss: async () => ({ status: "failed" as const }),
                },
            },
        } as unknown as TuiRuntime;
        expect(await listHomeRestarts(rt, [agent("a")])).toEqual([]);
    });

    test("a runtime without the restart dependency shows no block", async () => {
        const rt = { dependencies: {} } as unknown as TuiRuntime;
        expect(await listHomeRestarts(rt, [agent("a")])).toEqual([]);
    });
});

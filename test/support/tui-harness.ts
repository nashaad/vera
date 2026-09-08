import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";

import {
    startTui,
    type TuiDependencies,
    type TuiExit,
} from "../../clients/tui/main.ts";
import { VERA_HOME_ENV } from "../../src/profile-paths.ts";

/**
 * The real TUI driven in-process against a virtual screen.
 *
 * The helpers mirror the tmux suite deliberately — sendKey takes tmux key
 * names, waitForVisiblePane polls the frame the way capture-pane polled the
 * pane — so a test moving out of tmux.test.ts keeps its body.
 */
export interface TuiTestSession {
    sendText(value: string): void;
    sendPaste(value: string): Promise<void>;
    sendKey(key: string): void;
    /** Ctrl-modified arrows and friends, the way sendEscapeSequence sent them. */
    sendKeyWithModifiers(
        key: "up" | "down" | "left" | "right" | "end" | "home",
        modifiers: { readonly ctrl?: boolean; readonly shift?: boolean },
    ): void;
    sendMouseClick(x: number, y: number): Promise<void>;
    sendMouseWheel(
        direction: "up" | "down",
        x: number,
        y: number,
        times?: number,
    ): Promise<void>;
    sendMouseDrag(
        startX: number,
        startY: number,
        endX: number,
        endY: number,
    ): Promise<void>;
    captureVisiblePane(): string;
    /**
     * Waits and renders, for asserting that a keystroke changed nothing.
     * tmux got this for free from real time passing between keys; here a
     * capture without a render would still show the frame from before the key.
     */
    settle(ms?: number): Promise<void>;
    waitForVisiblePane(expected: string): Promise<string>;
    waitForVisiblePaneWhere(
        predicate: (pane: string) => boolean,
        description: string,
    ): Promise<string>;
    /** The frame with its colors, where tmux needed capture-pane -e. */
    captureSpans(): ReturnType<
        Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]
    >;
    /** The virtual terminal's stand-in for tmux resize-window. */
    resize(width: number, height: number): void;
    /** Resolves when the TUI quits, the way tmux waited for session exit. */
    waitForSessionExit(): Promise<TuiExit>;
    /** Tears the session down whether or not the TUI already quit. */
    close(): Promise<void>;
}

export interface TuiTestSessionOptions {
    /** Stands in for the tmux test's fake `$HOME`; `VERA_HOME` points into it. */
    readonly home: string;
    readonly width?: number;
    readonly height?: number;
    readonly dependencies: (
        renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
    ) => TuiDependencies | Promise<TuiDependencies>;
}

// Twice the tmux suite's 5s: a loaded machine slows the in-process TUI and
// the poll together, and the enclosing tests budget 15s anyway.
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;

/**
 * Homes swept once the process ends rather than when their test does.
 *
 * A TUI quit mid-turn leaves its headless loop streaming for a few more
 * seconds, and that loop persists the session under the test's home when it
 * finishes. Deleting the home in the test's own finally block turned that
 * late write into an unhandled ENOENT charged to whichever test ran next.
 */
const homesToSweep = new Set<string>();
let sweepRegistered = false;

function sweepHomeAtExit(home: string): void {
    homesToSweep.add(home);
    if (sweepRegistered) return;
    sweepRegistered = true;
    process.on("exit", () => {
        for (const dir of homesToSweep) {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // The temp dir outlives the run; the OS owns it from here.
            }
        }
    });
}

// VERA_HOME is process-global, so two live sessions would read and write
// each other's homes. The suite runs sessions one at a time; hold that line.
let activeSession = false;

export async function startTuiTestSession(
    options: TuiTestSessionOptions,
): Promise<TuiTestSession> {
    if (activeSession) {
        throw new Error(
            "A TUI test session is already open; close it before starting another",
        );
    }
    activeSession = true;
    const veraHome = join(options.home, ".vera");
    mkdirSync(veraHome, { recursive: true });
    sweepHomeAtExit(options.home);
    const previousVeraHome = process.env[VERA_HOME_ENV];
    process.env[VERA_HOME_ENV] = veraHome;

    const setup = await createTestRenderer({
        width: options.width ?? 100,
        height: options.height ?? 35,
    });
    let exited = false;
    let exitError: unknown;
    const exit = (async () => startTui({
        ...await options.dependencies(setup.renderer),
        createRenderer: async () => setup.renderer,
    }))()
        .catch((error) => {
            exitError = error;
            throw error;
        })
        .finally(() => {
            exited = true;
        });
    // A rejection before the test awaits the exit must not take the run down.
    exit.catch(() => undefined);

    function restoreVeraHome(): void {
        if (previousVeraHome === undefined) {
            delete process.env[VERA_HOME_ENV];
        } else {
            process.env[VERA_HOME_ENV] = previousVeraHome;
        }
    }

    function capture(): string {
        // tmux capture-pane trims trailing blanks; assertions on line widths
        // and toEndWith() depend on the same trim here.
        return setup.captureCharFrame()
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n");
    }

    async function waitForVisiblePaneWhere(
        predicate: (pane: string) => boolean,
        description: string,
    ): Promise<string> {
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        let pane = "";
        while (Date.now() < deadline) {
            if (exitError !== undefined) {
                throw new Error(
                    `TUI failed while waiting for ${description}: ${String(
                        exitError instanceof Error
                            ? exitError.stack ?? exitError.message
                            : exitError,
                    )}`,
                );
            }
            await setup.renderOnce();
            pane = capture();
            if (predicate(pane)) {
                return pane;
            }
            await Bun.sleep(POLL_INTERVAL_MS);
        }
        throw new Error(
            `Timed out waiting for visible ${description}\n\nLast pane:\n${pane}`,
        );
    }

    return {
        sendText(value) {
            for (const char of value) {
                setup.mockInput.pressKey(char);
            }
        },
        sendPaste(value) {
            return setup.mockInput.pasteBracketedText(value);
        },
        sendKey(key) {
            pressTmuxKey(setup.mockInput, key);
        },
        sendKeyWithModifiers(key, modifiers) {
            if (key === "home" || key === "end") {
                setup.mockInput.pressKey(
                    key === "home" ? "HOME" : "END",
                    modifiers,
                );
                return;
            }
            setup.mockInput.pressArrow(key, modifiers);
        },
        async sendMouseClick(x, y) {
            await setup.mockMouse.click(x, y);
        },
        async sendMouseWheel(direction, x, y, times = 1) {
            for (let index = 0; index < times; index += 1) {
                await setup.mockMouse.scroll(x, y, direction);
            }
        },
        async sendMouseDrag(startX, startY, endX, endY) {
            await setup.mockMouse.drag(startX, startY, endX, endY);
        },
        captureVisiblePane: capture,
        captureSpans: () => setup.captureSpans(),
        resize(width, height) {
            setup.resize(width, height);
        },
        async settle(ms = 100) {
            await Bun.sleep(ms);
            await setup.renderOnce();
        },
        waitForVisiblePane(expected) {
            return waitForVisiblePaneWhere(
                (pane) => pane.includes(expected),
                JSON.stringify(expected),
            );
        },
        waitForVisiblePaneWhere,
        async waitForSessionExit() {
            const deadline = Date.now() + WAIT_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (exited) {
                    return exit;
                }
                await Bun.sleep(POLL_INTERVAL_MS);
            }
            throw new Error("Timed out waiting for TUI to exit");
        },
        async close() {
            try {
                if (!exited) {
                    setup.renderer.destroy();
                    const deadline = Date.now() + WAIT_TIMEOUT_MS;
                    while (!exited && Date.now() < deadline) {
                        await Bun.sleep(POLL_INTERVAL_MS);
                    }
                }
            } finally {
                restoreVeraHome();
                activeSession = false;
                // Yoga's WASM heap is fixed-size and shared by every renderer
                // in the process; nodes freed by finalizers stay allocated
                // until a collection actually runs. Collecting between
                // sessions keeps a long test run inside the heap.
                Bun.gc(true);
            }
            if (!exited) {
                // A loop still running past this point would write into the
                // restored home; fail loudly instead of letting it.
                throw new Error("TUI did not exit within the close deadline");
            }
        },
    };
}

type MockInput = Awaited<
    ReturnType<typeof createTestRenderer>
>["mockInput"];

/**
 * tmux send-keys names, translated to the byte sequences tmux itself sent.
 * Only the names the tmux suite actually uses are mapped; an unknown name is
 * an error rather than a silently dropped keystroke.
 */
function pressTmuxKey(input: MockInput, key: string): void {
    switch (key) {
        case "Enter":
            input.pressEnter();
            return;
        case "Escape":
            input.pressEscape();
            return;
        case "Tab":
            input.pressTab();
            return;
        case "BTab":
            input.pressKey("\u001b[Z");
            return;
        case "BSpace":
            input.pressBackspace();
            return;
        case "Up":
        case "Down":
        case "Left":
        case "Right":
            input.pressArrow(
                key.toLowerCase() as "up" | "down" | "left" | "right",
            );
            return;
        case "DC":
            input.pressKey("DELETE");
            return;
        case "NPage":
            input.pressKey("\u001b[6~");
            return;
        case "PPage":
            input.pressKey("\u001b[5~");
            return;
        default:
            break;
    }
    const ctrl = key.match(/^C-([a-z])$/);
    if (ctrl?.[1] !== undefined) {
        input.pressKey(ctrl[1], { ctrl: true });
        return;
    }
    if (key.length === 1) {
        input.pressKey(key);
        return;
    }
    throw new Error(`No mapping for tmux key ${JSON.stringify(key)}`);
}

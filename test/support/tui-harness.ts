import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "bun:test";
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
    /**
     * Stands in for the tmux test's fake `$HOME`; `VERA_HOME` points into it.
     * Never deleted by `close()`: a quit TUI's loop can still write here.
     */
    readonly home: string;
    readonly width?: number;
    readonly height?: number;
    readonly waitTimeoutMs?: number;
    /** Default true: a stand-in `OPENROUTER_API_KEY` counts as a connected provider. */
    readonly providerKey?: boolean;
    readonly dependencies: (
        renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
    ) => TuiDependencies | Promise<TuiDependencies>;
}

// Twice the tmux suite's 5s: a loaded machine slows the in-process TUI and
// the poll together, and the enclosing tests budget 15s anyway.
const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;

type TestRenderer = Awaited<ReturnType<typeof createTestRenderer>>["renderer"];
type FrameCallback = (deltaTime: number) => Promise<void>;

function cancelFrameCallbacksOnClose(renderer: TestRenderer, signal: AbortSignal): void {
    const setFrameCallback = renderer.setFrameCallback.bind(renderer);
    const removeFrameCallback = renderer.removeFrameCallback.bind(renderer);
    const clearFrameCallbacks = renderer.clearFrameCallbacks.bind(renderer);
    const callbacks = new Map<FrameCallback, FrameCallback[]>();
    renderer.setFrameCallback = (callback) => {
        const wrapped: FrameCallback = async (deltaTime) => {
            if (signal.aborted) return;
            let stop = () => {};
            const closed = new Promise<void>((resolve) => {
                stop = resolve;
                signal.addEventListener("abort", stop, { once: true });
            });
            try {
                await Promise.race([callback(deltaTime), closed]);
            } finally {
                signal.removeEventListener("abort", stop);
            }
        };
        const registered = callbacks.get(callback) ?? [];
        registered.push(wrapped);
        callbacks.set(callback, registered);
        setFrameCallback(wrapped);
    };
    renderer.removeFrameCallback = (callback) => {
        const registered = callbacks.get(callback);
        if (registered === undefined) {
            removeFrameCallback(callback);
            return;
        }
        for (const wrapped of registered) {
            removeFrameCallback(wrapped);
        }
        callbacks.delete(callback);
    };
    renderer.clearFrameCallbacks = () => {
        callbacks.clear();
        clearFrameCallbacks();
    };
}

// VERA_HOME is process-global, so two live sessions would read and write
// each other's homes. The suite runs sessions one at a time; hold that line.
let activeSession = false;
let activeSessionCleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
    await activeSessionCleanup?.();
}, WAIT_TIMEOUT_MS + 5_000);

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
    const previousVeraHome = process.env[VERA_HOME_ENV];
    const providerCredentials = Object.entries(process.env).filter(([name]) =>
        /(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN)$/.test(name),
    );
    for (const [name] of providerCredentials) delete process.env[name];
    if (options.providerKey !== false) process.env.OPENROUTER_API_KEY = "test-key";
    let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
    let exited = false;
    let started = false;
    let closed = false;
    let rendered = false;
    let exitError: unknown;
    let closing: Promise<void> | undefined;
    const frameCancellation = new AbortController();

    function restoreVeraHome(): void {
        delete process.env.OPENROUTER_API_KEY;
        for (const [name, value] of providerCredentials) {
            if (value !== undefined) process.env[name] = value;
        }
        if (previousVeraHome === undefined) {
            delete process.env[VERA_HOME_ENV];
        } else {
            process.env[VERA_HOME_ENV] = previousVeraHome;
        }
    }

    function close(): Promise<void> {
        if (closing !== undefined) return closing;
        closed = true;
        frameCancellation.abort();
        closing = (async () => {
            try {
                if (setup !== undefined) {
                    const deadline = Date.now() + WAIT_TIMEOUT_MS;
                    const startupDeadline = Math.min(deadline, Date.now() + 1_000);
                    while (
                        started
                        && !exited
                        && !rendered
                        && Date.now() < startupDeadline
                    ) {
                        void setup.renderOnce().catch(() => undefined);
                        await Bun.sleep(POLL_INTERVAL_MS);
                        rendered = setup.captureCharFrame().trim().length > 0;
                    }
                    setup.renderer.destroy();
                    while (started && !exited && Date.now() < deadline) {
                        await Bun.sleep(POLL_INTERVAL_MS);
                    }
                }
            } finally {
                if (activeSessionCleanup === close) {
                    restoreVeraHome();
                    activeSession = false;
                    activeSessionCleanup = undefined;
                }
                Bun.gc(true);
            }
            if (started && !exited) {
                throw new Error("TUI did not exit within the close deadline");
            }
        })();
        return closing;
    }

    activeSessionCleanup = close;
    let rendererSetup: Awaited<ReturnType<typeof createTestRenderer>>;
    try {
        mkdirSync(veraHome, { recursive: true });
        process.env[VERA_HOME_ENV] = veraHome;
        rendererSetup = await createTestRenderer({
            width: options.width ?? 100,
            height: options.height ?? 35,
            exitOnCtrlC: false,
        });
        setup = rendererSetup;
        cancelFrameCallbacksOnClose(rendererSetup.renderer, frameCancellation.signal);
        if (closed) {
            rendererSetup.renderer.destroy();
            throw new Error("TUI test session closed during setup");
        }
    } catch (error) {
        await close();
        throw error;
    }

    const exit = (async () => {
        const dependencies = await options.dependencies(rendererSetup.renderer);
        if (closed) throw new Error("TUI test session closed during setup");
        started = true;
        return startTui({
            ...dependencies,
            createRenderer: async () => rendererSetup.renderer,
        });
    })()
        .catch((error) => {
            exitError = error;
            throw error;
        })
        .finally(() => {
            exited = true;
        });
    exit.catch(() => undefined);

    function capture(): string {
        // tmux capture-pane trims trailing blanks; assertions on line widths
        // and toEndWith() depend on the same trim here.
        return rendererSetup.captureCharFrame()
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n");
    }

    async function renderBefore(deadline: number): Promise<boolean> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
            rendererSetup.renderOnce().then(() => true),
            new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
            }),
        ]).finally(() => clearTimeout(timeout));
    }

    async function waitForVisiblePaneWhere(
        predicate: (pane: string) => boolean,
        description: string,
    ): Promise<string> {
        const deadline = Date.now() + (options.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
        let pane = "";
        while (Date.now() < deadline) {
            if (closed) throw new Error("TUI test session is closed");
            if (exitError !== undefined) {
                throw new Error(
                    `TUI failed while waiting for ${description}: ${String(
                        exitError instanceof Error
                            ? exitError.stack ?? exitError.message
                            : exitError,
                    )}`,
                );
            }
            if (!await renderBefore(deadline)) break;
            if (closed) throw new Error("TUI test session is closed");
            pane = capture();
            if (predicate(pane)) {
                rendered = true;
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
                rendererSetup.mockInput.pressKey(char);
            }
        },
        sendPaste(value) {
            return rendererSetup.mockInput.pasteBracketedText(value);
        },
        sendKey(key) {
            pressTmuxKey(rendererSetup.mockInput, key);
        },
        sendKeyWithModifiers(key, modifiers) {
            if (key === "home" || key === "end") {
                rendererSetup.mockInput.pressKey(
                    key === "home" ? "HOME" : "END",
                    modifiers,
                );
                return;
            }
            rendererSetup.mockInput.pressArrow(key, modifiers);
        },
        async sendMouseClick(x, y) {
            await rendererSetup.mockMouse.click(x, y);
        },
        async sendMouseWheel(direction, x, y, times = 1) {
            for (let index = 0; index < times; index += 1) {
                await rendererSetup.mockMouse.scroll(x, y, direction);
            }
        },
        async sendMouseDrag(startX, startY, endX, endY) {
            await rendererSetup.mockMouse.drag(startX, startY, endX, endY);
        },
        captureVisiblePane: capture,
        captureSpans: () => rendererSetup.captureSpans(),
        resize(width, height) {
            rendererSetup.resize(width, height);
        },
        async settle(ms = 100) {
            await Bun.sleep(ms);
            const deadline = Date.now() + (options.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
            if (!await renderBefore(deadline)) {
                throw new Error("Timed out waiting for TUI render");
            }
        },
        waitForVisiblePane(expected) {
            return waitForVisiblePaneWhere(
                (pane) => pane.includes(expected),
                JSON.stringify(expected),
            );
        },
        waitForVisiblePaneWhere,
        async waitForSessionExit() {
            const deadline = Date.now() + (options.waitTimeoutMs ?? WAIT_TIMEOUT_MS);
            while (Date.now() < deadline) {
                if (exited) {
                    return exit;
                }
                await Bun.sleep(POLL_INTERVAL_MS);
            }
            throw new Error("Timed out waiting for TUI to exit");
        },
        close,
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

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { CapturedFrame, CapturedSpan } from "@opentui/core";
import { startTui, type TuiAgentClient } from "../../clients/tui/main.ts";
import { applyTuiTheme } from "../../clients/tui/state.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import { saveTuiThemePreference } from "../../clients/tui/theme-preference.ts";
import type { TuiThemeName } from "../../clients/tui/theme.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        stopReason: "stop",
        usage: emptyUsage(),
    };
}

/**
 * The whole TUI booted against the in-process test renderer, so a test reads
 * the frame the user would see: real layout, real grounds, no terminal.
 */
async function bootTui(theme: TuiThemeName) {
    saveTuiThemePreference(theme);
    const channel = createInProcessChannel();
    void runHeadlessLoop(
        channel.engine,
        new FauxAdapter([response("ok")], { chunkSize: 1, delayMs: 40 }),
        "test",
        "high",
        {
            approvalMode: "auto",
            readModelSettings: () => ({
                model: "test",
                reasoningEffort: "high",
                contextWindow: 100,
            }),
            updateModelSettings: async () => undefined,
            readApprovalMode: () => "auto",
            updateApprovalMode: async () => undefined,
        },
    );
    const client: TuiAgentClient = {
        async send(command): Promise<void> {
            channel.client.send(command);
        },
        receive(signal) {
            return channel.client.receive(signal);
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
    const setup = await createTestRenderer({ width: 100, height: 35 });
    const exit = startTui({
        client,
        copyText: async () => undefined,
        createRenderer: async () => setup.renderer,
    });
    // startTui is not awaited (it runs until quit), so give its boot real
    // time and render explicitly until the frame holds the composer.
    await until(setup, (frame) => frame.includes("Message Vera"));
    return { setup, exit };
}

async function until(
    setup: Awaited<ReturnType<typeof createTestRenderer>>,
    ready: (frame: string) => boolean,
): Promise<void> {
    for (let pass = 0; pass < 100; pass += 1) {
        await Bun.sleep(50);
        await setup.renderOnce();
        if (ready(setup.captureCharFrame())) return;
    }
    throw new Error("frame never became ready");
}

function rowText(frame: CapturedFrame, row: number): string {
    return frame.lines[row]!.spans.map((span) => span.text).join("");
}

/** The row holding the composer's top border, found by its corner glyph. */
function composerTopRow(frame: CapturedFrame): number {
    for (let row = frame.rows - 1; row >= 0; row -= 1) {
        if (rowText(frame, row).includes("╭")) return row;
    }
    throw new Error("no composer top border in frame");
}

function hex(span: CapturedSpan): string {
    const c = span.bg;
    const to = (v: number) =>
        Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

describe("composer geometry", () => {
    // Booting applies the theme to module-level palette state; put it back so
    // later files see the default palette.
    afterEach(() => applyTuiTheme(VERA_TUI_THEME));

    test("windows-31 boots with the window face painted", async () => {
        const { setup } = await bootTui("windows-31");
        const frame = setup.captureSpans();
        const top = composerTopRow(frame);
        // Every composer row, border to border, sits on the window face at
        // boot, not only after the first theme apply.
        for (let row = top; row <= top + 6; row += 1) {
            const grounds = frame.lines[row]!.spans
                .filter((span) => span.text.trim().length > 0)
                .map(hex);
            expect(grounds).not.toBeEmpty();
            for (const ground of grounds) expect(ground.toLowerCase()).toBe("#ffffff");
        }
        setup.renderer.destroy();
    });

    test("the slash strip stays off the composer top border", async () => {
        const { setup } = await bootTui("windows-31");
        await setup.mockInput.typeText("/th");
        await until(setup, (frame) => frame.includes("/themes"));
        const frame = setup.captureSpans();
        const top = composerTopRow(frame);
        expect(rowText(frame, top)).toContain("╭");
        // The suggestion row renders above the border, not on it.
        expect(rowText(frame, top - 1)).toContain("/themes");
        expect(rowText(frame, top + 1)).toContain("/th");
        setup.renderer.destroy();
    });
});

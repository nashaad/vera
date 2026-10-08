import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { startTui, type TuiAgentClient } from "../../clients/tui/main.ts";
import { saveTuiThemePreference } from "../../clients/tui/theme-preference.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { configuredProviders } from "../../src/providers/registry.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

async function until(
    setup: Awaited<ReturnType<typeof createTestRenderer>>,
    ready: (frame: string) => boolean,
): Promise<void> {
    for (let pass = 0; pass < 250; pass += 1) {
        await Bun.sleep(20);
        await setup.renderOnce();
        if (ready(setup.captureCharFrame())) return;
    }
    throw new Error(`frame did not become ready:\n${setup.captureCharFrame()}`);
}

test("limits sit on the row under the composer without moving it", async () => {
    saveTuiThemePreference("default");
    const provider = configuredProviders(undefined).find((item) => item.access === "subscription")!;
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, new FauxAdapter([{
        role: "assistant", content: [{ type: "text", text: "ok" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        stopReason: "stop", usage: emptyUsage(),
    }]), "gpt-6-luna", "low", { approvalMode: "auto" }, {
        readModelSettings: () => ({ provider: provider.id, model: "gpt-6-luna", reasoningEffort: "low", contextWindow: 200_000 }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });
    const client: TuiAgentClient = {
        async send(command) { channel.client.send(command); },
        receive(signal) { return channel.client.receive(signal); },
        async detach() {}, close() {},
    };
    const setup = await createTestRenderer({ width: 100, height: 36 });
    let reads = 0;
    const exit = startTui({
        client, copyText: async () => undefined,
        createRenderer: async () => setup.renderer,
        readSubscriptionLimits: async () => {
            reads += 1;
            return [{
                provider: provider.id, fetchedAt: Date.now(), windows: [
                    { windowMinutes: 300, usedPercent: 58, resetsAt: Date.now() + 60_000 },
                    { windowMinutes: 10_080, usedPercent: 9, resetsAt: Date.now() + 120_000 },
                ],
            }];
        },
    });
    const rowWith = (text: string) => setup.captureCharFrame().split("\n").findIndex((row) => row.includes(text));
    const border = () => setup.captureCharFrame().split("\n").findIndex((row) => row.includes("╭"));
    const model = `${provider.shortLabel}/gpt-6-luna`;
    try {
        await until(setup, (frame) => frame.includes("5h 42% left · week 91% left"));
        expect(rowWith("ctx ?%")).toBe(rowWith("default · auto"));
        expect(rowWith("Shift+Tab HUD")).toBe(-1);
        const wideTop = border();
        const wideFooter = rowWith("default · auto");
        expect(rowWith("42% left")).toBe(wideFooter + 2);
        expect(rowWith("ready · Ctrl+P commands")).toBe(rowWith("42% left") + 1);
        expect(rowWith(model)).toBe(wideFooter);
        expect(wideFooter - wideTop).toBe(5);
        const spans = setup.captureSpans().lines[rowWith("42% left")]!.spans;
        const limitSpan = spans.find((span) => span.text.includes("42%"))!;
        const hex = (value: number) => Math.round(value * 255).toString(16).padStart(2, "0");
        expect(`#${hex(limitSpan.fg.r)}${hex(limitSpan.fg.g)}${hex(limitSpan.fg.b)}`).toBe(VERA_TUI_THEME.muted.toLowerCase());
        await setup.mockInput.typeText("Keep this unsent draft");
        setup.resize(70, 36);
        await until(setup, (frame) => frame.includes(model) && rowWith("42% left") !== rowWith("default · auto"));
        const narrowTop = border();
        expect(rowWith("42% left")).toBe(rowWith("default · auto") + 2);
        expect(rowWith("ctx ?%")).toBe(rowWith("default · auto"));
        expect(rowWith("default · auto") - narrowTop).toBe(5);
        expect(narrowTop).toBe(wideTop);
        expect(rowWith(model)).toBe(rowWith("default · auto"));
        expect(setup.captureCharFrame()).toContain("Keep this unsent draft");
        await setup.mockInput.typeText("!");
        await until(setup, (frame) => frame.includes("Keep this unsent draft!"));
        expect(setup.captureCharFrame()).toContain("Keep this unsent draft!");
        setup.resize(120, 36);
        await until(setup, () => rowWith("42% left") === rowWith("default · auto") + 2);
        expect(border()).toBe(wideTop);
        expect(setup.captureCharFrame()).toContain("Keep this unsent draft!");
        setup.resize(70, 36);
        await until(setup, () => rowWith("42% left") === rowWith("default · auto") + 2);
        const apiProvider = configuredProviders(undefined).find((item) => item.access === "api_key")!;
        channel.engine.send({ type: "model_settings", requestId: "switch", seq: 10_000, pending: false,
            settings: { provider: apiProvider.id, model: "test", reasoningEffort: "low" } });
        await until(setup, (frame) => frame.includes(`${apiProvider.shortLabel}/test`) && !frame.includes("% left"));
        expect(border()).toBe(wideTop);
        expect(rowWith("default · auto") - border()).toBe(5);
        expect(rowWith("ready · Ctrl+P commands")).toBe(rowWith("default · auto") + 3);
        expect(setup.captureCharFrame()).toContain("Keep this unsent draft!");
        channel.engine.send({ type: "model_settings", requestId: "restore", seq: 10_001, pending: false,
            settings: { provider: provider.id, model: "gpt-6-luna", reasoningEffort: "low", contextWindow: 200_000 } });
        await until(setup, (frame) => frame.includes("42% left") && frame.includes(model));
        expect(reads).toBe(2);
        expect(rowWith("42% left")).toBe(rowWith("default · auto") + 2);
        setup.resize(100, 36);
        channel.engine.send({ type: "context", seq: 10_002,
            measurement: { tokens: 50_000, capacity: 200_000, estimated: false } });
        await until(setup, (frame) => frame.includes("ctx 50k/200k") && frame.includes(model));
        expect(rowWith("ctx ?%")).toBe(-1);
        expect(rowWith("ctx 50k/200k")).toBe(rowWith(model));
        expect(rowWith("25%")).toBe(rowWith(model));
        expect(setup.captureCharFrame()).toContain("▰▰▰▱▱▱▱▱▱▱  25%");
        expect(rowWith("42% left")).toBe(rowWith("default · auto") + 2);
        expect(setup.captureCharFrame()).toContain("Keep this unsent draft!");
    } finally {
        setup.renderer.destroy();
        await exit;
    }
});

interface SubscriptionTurn {
    readonly setup: Awaited<ReturnType<typeof createTestRenderer>>;
    readonly exit: Promise<unknown>;
    readonly model: string;
    readonly rowWith: (text: string) => number;
    readonly row: (index: number) => string;
    readonly border: () => number;
}

async function startSubscriptionTurn(width: number): Promise<SubscriptionTurn> {
    saveTuiThemePreference("default");
    const provider = configuredProviders(undefined).find((item) => item.access === "subscription")!;
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, new FauxAdapter([{
        role: "assistant",
        content: [
            { type: "thinking", text: "Which way to the crow's nest? ".repeat(14) },
            { type: "text", text: "Hoist the black sail." },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        stopReason: "stop", usage: emptyUsage(),
    }], { chunkSize: 4, delayMs: 20 }), "gpt-6-luna", "low", { approvalMode: "auto" }, {
        readModelSettings: () => ({ provider: provider.id, model: "gpt-6-luna", reasoningEffort: "low", contextWindow: 272_000 }),
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        router: { updateModelSettings: async () => undefined },
    });
    const client: TuiAgentClient = {
        async send(command) { channel.client.send(command); },
        receive(signal) { return channel.client.receive(signal); },
        async detach() {}, close() {},
    };
    const setup = await createTestRenderer({ width, height: 36 });
    const exit = startTui({
        client, copyText: async () => undefined,
        createRenderer: async () => setup.renderer,
        readSubscriptionLimits: async () => [{
            provider: provider.id, fetchedAt: Date.now(), windows: [
                { windowMinutes: 300, usedPercent: 28, resetsAt: Date.now() + 600_000 },
                { windowMinutes: 10_080, usedPercent: 4, resetsAt: Date.now() + 1_200_000 },
            ],
        }],
    });
    channel.engine.send({ type: "context", seq: 10_000,
        measurement: { tokens: 4_800, capacity: 272_000, estimated: true } });
    const rows = () => setup.captureCharFrame().split("\n");
    return {
        setup,
        exit,
        model: `${provider.shortLabel}/gpt-6-luna`,
        rowWith: (text) => rows().findIndex((row) => row.includes(text)),
        row: (index) => rows()[index] ?? "",
        border: () => rows().findIndex((row) => row.includes("╭")),
    };
}

test("a subscription turn keeps the composer still and its status in place of the limits", async () => {
    // The footer shows the process folder; make it long enough to shorten from any checkout.
    const previousCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "vera-footer-"));
    const longPlace = join(root, "crows-nest", "harbour", "raids", "black-sail", "plot-a-course");
    mkdirSync(longPlace, { recursive: true });
    process.chdir(longPlace);
    const { setup, exit, model, rowWith, row, border } = await startSubscriptionTurn(100);
    try {
        await until(setup, (frame) => frame.includes("5h 72% left · week 96% left")
            && frame.includes("ready · Ctrl+P commands") && frame.includes(model));
        const top = border();
        const footer = rowWith("default · auto");
        expect(row(footer)).toContain("ctx ~4.8k/272k ▰▱▱▱▱▱▱▱▱▱  2%");
        expect(rowWith("72% left")).toBe(footer + 2);
        expect(row(footer + 2).trim()).toBe("5h 72% left · week 96% left");
        expect(rowWith("ready · Ctrl+P commands")).toBe(footer + 3);
        const idlePlace = row(footer + 3).replace("ready · Ctrl+P commands", "").trimEnd();

        await setup.mockInput.typeText("Plot a course for the crow's nest");
        setup.mockInput.pressEnter();
        await until(setup, (frame) => frame.includes("esc stop"));
        expect(border()).toBe(top);
        expect(rowWith("esc stop")).toBe(footer + 2);
        expect(rowWith("72% left")).toBe(-1);
        expect(row(footer + 2).trimEnd()).toMatch(/^ {4}\S.* {2,}esc stop · \S+ stop$/);
        expect(row(footer + 3).startsWith(idlePlace)).toBe(true);
        expect(row(footer + 3)).not.toContain("ready");
        expect(row(footer + 3).trimEnd()).toMatch(/ {2,}\S+$/);
        expect(row(footer)).toContain(`${model} · low`);

        setup.resize(70, 36);
        await until(setup, (frame) => frame.includes("esc stop") && !frame.includes("% left"));
        const narrowFooter = rowWith("default · auto");
        expect(border()).toBe(top);
        expect(narrowFooter).toBe(footer);
        expect(row(footer)).toContain(`ctx ▰▱▱▱▱▱▱▱▱▱`);
        expect(row(footer)).toContain(`${model} · low`);
        expect(rowWith("esc stop")).toBe(footer + 2);
        expect(row(footer + 3)).toContain("…/");

        await until(setup, (frame) => frame.includes("Hoist the black sail.")
            && frame.includes("ready · Ctrl+P commands"));
        expect(border()).toBe(top);
        expect(rowWith("esc stop")).toBe(-1);
        expect(rowWith("72% left")).toBe(footer + 2);
        expect(rowWith("ready · Ctrl+P commands")).toBe(footer + 3);

        setup.resize(100, 36);
        await until(setup, () => row(footer + 3).startsWith(idlePlace));
        expect(border()).toBe(top);
        expect(rowWith("72% left")).toBe(footer + 2);
    } finally {
        setup.renderer.destroy();
        await exit;
        process.chdir(previousCwd);
        rmSync(root, { recursive: true, force: true });
    }
}, 30_000);

test("a long dev label keeps the live status and drops the limits for the turn", async () => {
    const previous = process.env.VERA_DEV_INSTANCE;
    process.env.VERA_DEV_INSTANCE = "limits vera-98fe639f+cce308fe4fb2";
    const { setup, exit, rowWith, row, border } = await startSubscriptionTurn(100);
    try {
        await until(setup, (frame) => frame.includes("72% left"));
        const top = border();
        const footer = rowWith("default · auto");
        await setup.mockInput.typeText("Plot a course for the crow's nest");
        setup.mockInput.pressEnter();
        await until(setup, (frame) => frame.includes("esc stop"));
        expect(border()).toBe(top);
        expect(rowWith("72% left")).toBe(-1);
        expect(rowWith("[DEV limits")).toBe(footer + 2);
        expect(row(footer + 2)).toContain("esc stop · ");
        await until(setup, (frame) => frame.includes("ready · Ctrl+P commands"));
        expect(rowWith("72% left")).toBe(footer + 2);
        expect(border()).toBe(top);
    } finally {
        if (previous === undefined) delete process.env.VERA_DEV_INSTANCE;
        else process.env.VERA_DEV_INSTANCE = previous;
        setup.renderer.destroy();
        await exit;
    }
}, 30_000);

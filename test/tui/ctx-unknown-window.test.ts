import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { startTui, type TuiAgentClient } from "../../clients/tui/main.ts";
import { saveTuiThemePreference } from "../../clients/tui/theme-preference.ts";
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

// A model Vera's catalog has no window for (like a provider's newest release
// that predates the shipped feed) must still surface what was measured.
test("the live composer shows raw tokens, not nothing, once a model with no known window is measured", async () => {
    saveTuiThemePreference("default");
    const provider = configuredProviders(undefined).find((item) => item.access === "api_key")!;
    const channel = createInProcessChannel();
    void runHeadlessLoop(channel.engine, new FauxAdapter([{
        role: "assistant", content: [{ type: "text", text: "ok" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        stopReason: "stop", usage: emptyUsage(),
    }]), "claude-haiku-5-5", "default", { approvalMode: "auto" }, {
        readModelSettings: () => ({ provider: provider.id, model: "claude-haiku-5-5" }),
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
    const exit = startTui({
        client, copyText: async () => undefined,
        createRenderer: async () => setup.renderer,
    });
    const model = `${provider.code}/claude-haiku-5-5`;
    // The composer details row, not the whole frame: the worktree path below
    // it names this very branch, "fix/ctx-unknown-window".
    const detailsRow = () => setup.captureCharFrame().split("\n")
        .find((row) => row.includes("default · auto")) ?? "";
    try {
        await until(setup, (frame) => frame.includes(model));
        expect(detailsRow()).not.toContain("ctx");

        channel.engine.send({ type: "context", seq: 10_000,
            measurement: { tokens: 42_000, estimated: true } });
        await until(setup, () => detailsRow().includes("ctx ~42k"));
        expect(detailsRow()).toContain(model);
        expect(detailsRow()).not.toContain("ctx ~42k/");
        expect(detailsRow()).not.toMatch(/ctx ~42k.*%/);

        setup.resize(60, 36);
        await until(setup, (frame) => frame.includes("default · auto"));
        expect(detailsRow()).not.toContain("ctx ~42k");
    } finally {
        setup.renderer.destroy();
        await exit;
    }
});

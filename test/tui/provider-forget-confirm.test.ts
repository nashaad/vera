import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiProviderForgetConfirmView,
    handleTuiProviderForgetConfirmKey,
    tuiProviderForgetDecision,
} from "../../clients/tui/provider-forget-confirm.ts";

const OPENROUTER = {
    label: "OpenRouter",
    credential: "api_key",
    envVar: "OPENROUTER_API_KEY",
} as const;

test("forgetting a credential requires the explicit numbered confirmation", () => {
    expect(handleTuiProviderForgetConfirmKey({ name: "1" })).toBe("confirm");
    expect(handleTuiProviderForgetConfirmKey({ name: "1", ctrl: true }))
        .toBeUndefined();
    expect(handleTuiProviderForgetConfirmKey({ name: "1", shift: true }))
        .toBeUndefined();
    // Nothing else answers the card, so no stray key deletes a secret.
    expect(handleTuiProviderForgetConfirmKey({ name: "enter" }))
        .toBeUndefined();
    expect(handleTuiProviderForgetConfirmKey({ name: "delete" }))
        .toBeUndefined();
    expect(handleTuiProviderForgetConfirmKey({ name: "escape" })).toBe("cancel");
});

test("only a credential Vera stored reaches the confirmation", () => {
    expect(tuiProviderForgetDecision(OPENROUTER, true, undefined))
        .toEqual({ kind: "confirm" });
});

test("a provider connected only through its environment variable explains itself", () => {
    const decision = tuiProviderForgetDecision(OPENROUTER, false, "sk-live");

    expect(decision.kind).toBe("explain");
    expect(decision.kind === "explain" && decision.message)
        .toContain("OPENROUTER_API_KEY");
});

test("a provider that needs no credential explains itself", () => {
    const decision = tuiProviderForgetDecision(
        { label: "Ollama", credential: "none" },
        false,
        undefined,
    );

    expect(decision.kind).toBe("explain");
    expect(decision.kind === "explain" && decision.message)
        .toContain("nothing to forget");
});

test("a provider with neither a stored key nor a variable says so", () => {
    const decision = tuiProviderForgetDecision(OPENROUTER, false, undefined);

    expect(decision.kind).toBe("explain");
    expect(decision.kind === "explain" && decision.message)
        .toContain("no stored credential");
});

test("the confirmation names the provider it is about to forget", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiProviderForgetConfirmView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update("OpenRouter");
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Forget this stored credential?");
        expect(frame).toContain("OpenRouter");
        expect(frame).toContain("[1] forget");
        expect(frame).toContain("[esc] cancel");
    } finally {
        setup.renderer.destroy();
    }
});

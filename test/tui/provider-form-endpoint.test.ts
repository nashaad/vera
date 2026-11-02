import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { endpointFormDeclaration } from "../../clients/tui/main/provider-forms.ts";
import { createTuiProviderFormView } from "../../clients/tui/settings-picker-provider-form.ts";
import { findConfiguredProvider, type ProviderDescriptor } from "../../src/providers/registry.ts";

function shipped(id: string): ProviderDescriptor {
    const descriptor = findConfiguredProvider(id, undefined);
    expect(descriptor).toBeDefined();
    return descriptor!;
}

test("editing Anthropic keeps the protocol its catalog read needs", () => {
    const declaration = endpointFormDeclaration("anthropic", shipped("anthropic"), "sk-ant-usr-key");

    // The shipped form hides the protocol row, so this value is the only one the save can send.
    expect(declaration.protocol).toBe("anthropic-messages");
    expect(declaration.shipped).toBe(true);
    expect(declaration.apiKey).toBe("sk-ant-usr-key");
    expect(declaration.baseUrl).toBe("https://api.anthropic.com/v1");
});

test("a provider whose catalog is OpenAI-shaped stays on openai-chat", () => {
    const declaration = endpointFormDeclaration("openrouter", shipped("openrouter"), undefined);

    expect(declaration.protocol).toBe("openai-chat");
    expect(declaration.apiKey).toBeUndefined();
    expect(declaration.credential).toBe("api_key");
});

test("a credentialless provider is edited without a key field", () => {
    const declaration = endpointFormDeclaration("ollama", shipped("ollama"), undefined);

    expect(declaration.credential).toBe("none");
    expect(declaration.apiKey).toBeUndefined();
});

test("the card keeps its rows when a long provider error appears", async () => {
    const setup = await createTestRenderer({ width: 120, height: 34 });
    const view = createTuiProviderFormView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    const base = {
        editorSession: 1,
        id: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        protocol: "anthropic-messages" as const,
        credential: "api_key" as const,
        apiKey: "",
        field: "api_key" as const,
    };
    const rowOf = (frame: string, text: string): number =>
        frame.split("\n").findIndex((line) => line.includes(text));
    try {
        view.update(base);
        await setup.flush();
        const clean = setup.captureCharFrame();
        view.update({
            ...base,
            error: `Catalog request returned HTTP 400: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Your input is preserved`,
        });
        await setup.flush();
        const failed = setup.captureCharFrame();

        expect(rowOf(failed, "Add provider")).toBe(rowOf(clean, "Add provider"));
        expect(rowOf(failed, "esc cancel")).toBe(rowOf(clean, "esc cancel"));
        expect(rowOf(failed, "esc cancel")).toBeGreaterThan(0);
    } finally {
        setup.renderer.destroy();
    }
});

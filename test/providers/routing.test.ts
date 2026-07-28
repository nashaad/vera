import { expect, test } from "bun:test";

import { ProviderRoutingAdapter } from "../../src/providers/routing.ts";
import type { ModelAdapter, ModelStream } from "../../src/model/types.ts";

function stubAdapter(): ModelAdapter {
    return {
        stream: (): ModelStream => {
            throw new Error("not streamed in this test");
        },
    };
}

test("a provider's client is built once while its credentials hold still", () => {
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
        () => "same-key",
    );

    routing.prepareProvider("openrouter");
    routing.prepareProvider("openrouter");

    expect(built).toBe(1);
});

test("signing in again mid-session stops the old key from being spent", () => {
    // A client captures the credential it was built with, so a re-key that left
    // the cache alone would keep billing the key the user just replaced, with
    // nothing on screen to explain it.
    let fingerprint = "first-key";
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
        () => fingerprint,
    );

    routing.prepareProvider("openrouter");
    fingerprint = "second-key";
    routing.prepareProvider("openrouter");

    expect(built).toBe(2);
});

test("nothing is built until something asks, including the default provider", () => {
    // The default provider used to be built while the agent was being created,
    // which meant a provider with no credential stopped Vera from starting at
    // all, and the connect pane that fixes it lives inside the TUI.
    let fingerprint: string | undefined = undefined;
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openrouter",
        () => fingerprint,
    );

    expect(built).toBe(0);

    routing.prepareProvider("openrouter");
    expect(built).toBe(1);

    // And it is still rebuilt on a re-key, like any other provider.
    fingerprint = "signed-in";
    routing.prepareProvider("openrouter");
    expect(built).toBe(2);
});

test("a host with no credential store keeps one client per provider", () => {
    let built = 0;
    const routing = new ProviderRoutingAdapter(
        () => {
            built += 1;
            return stubAdapter();
        },
        "openai-codex",
    );

    routing.prepareProvider("ollama");
    routing.prepareProvider("ollama");
    routing.prepareProvider("openai-codex");

    expect(built).toBe(2);
});

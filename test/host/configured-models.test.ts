import { expect, test } from "bun:test";

import type { VeraConfig } from "../../src/config.ts";
import { configuredCatalog } from "../../src/host/runtime.ts";

test("declared custom-provider models join the runnable catalog", () => {
    const config: VeraConfig = {
        schema_version: 1,
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        approval_mode: "ask",
        providers: {
            "vera-sample": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8790/v1",
                credential: "none",
            },
        },
        models: [{
            name: "vera_sample",
            provider: "vera-sample",
            model: "sample",
        }],
    };

    expect(configuredCatalog(config)).toContainEqual({
        provider: "vera-sample",
        model: "sample",
        label: "vera_sample",
        description: "configured model",
    });
});

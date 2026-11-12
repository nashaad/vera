// A trial home whose only model is served by a local chat-completions provider.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function configureFauxHome(home, port, approvalMode = "auto") {
    const model = { name: "faux-model", provider: "faux-0", model: "crow-0" };
    const assignment = { models: [model] };
    mkdirSync(join(home, "runtime", "cache"), { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "faux-0",
        model: "crow-0",
        approval_mode: approvalMode,
        providers: {
            "faux-0": { protocol: "openai-chat", credential: "none", base_url: `http://127.0.0.1:${port}/v1`, max_tokens: 2048 },
        },
        models: [model],
        model_routes: {},
        reviewer_profiles: {},
        model_assignments: { snappy: assignment, eco: assignment, extra: assignment, compaction: assignment, reviewer: assignment },
        curated_models_url: "",
    }, null, 2));
    writeFileSync(join(home, "runtime", "cache", "faux-0.json"), JSON.stringify({
        schema_version: 2,
        provider: "faux-0",
        fetched_at: new Date().toISOString(),
        models: [{ id: "crow-0", label: "Crow", context_window: 32000, tool_support: true, levels: [], pricing: { input: 1, output: 8 } }],
    }));
}

export function streamChunk(model, delta, finish = null) {
    const choice = { index: 0, delta, finish_reason: finish };
    return `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model, choices: [choice] })}\n\n`;
}

export async function until(label, check, timeout = 30_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

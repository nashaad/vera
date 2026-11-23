import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { knownReasoningEfforts } from "../../src/model/catalog-view.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import { Vera } from "../../src/sdk/agent.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const inputRoot = process.argv[2];
if (inputRoot === undefined) throw new Error("Missing test directory");
const root: string = inputRoot;

writeProviderCatalogSnapshot({
    schema_version: 2,
    provider: "openrouter",
    models: [{
        id: "not-a-verified-model",
        label: "Not verified",
        levels: [{ id: "low", label: "Low" }],
    }],
});

async function run(model: string, index: number) {
    const workspace = join(root, `workspace-${index}`);
    const target = join(root, `outside-${index}`);
    mkdirSync(workspace);
    const source = { provider: "openrouter", api: "scripted", model };
    const answer = (text: string): AssistantMessage => ({
        role: "assistant", content: [{ type: "text", text }],
        source, usage: emptyUsage(), stopReason: "stop",
    });
    const call: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call", id: `call-${index}`, name: "bash",
            input: { command: `printf crow > '${target}'` },
        }],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
    const requests: ModelRequest[] = [];
    const adapter = new FauxAdapter([
        call,
        answer(JSON.stringify({
            outcome: "deny", rationale: "Not authorized", risk_level: "high", user_authorization: "unknown",
        })),
        answer("The action was withheld."),
    ]);
    const vera = await Vera.create({
        workspace,
        posture: "auto",
        config: { schema_version: 1, provider: "openrouter", model, reasoning_effort: "max", approval_mode: "auto" },
        createAdapter: () => ({
            stream(request) {
                requests.push(request);
                return adapter.stream(request);
            },
        }),
    });
    try {
        const result = await vera.agent({
            name: "crow-review",
            instructions: "Carry out the requested task.",
            tools: ["bash"],
        }).run("Prepare the ship.");
        return {
            model,
            outcome: result.outcome,
            targetExists: existsSync(target),
            requests: requests.map((request) => ({
                model: request.model,
                effort: request.reasoningEffort ?? null,
                hasEffort: Object.hasOwn(request, "reasoningEffort"),
            })),
        };
    } finally {
        await vera.close();
    }
}

const results = [];
for (const [index, model] of [
    "not-a-verified-model",
    "moonshotai/kimi-k3",
    "z-ai/glm-5.2",
].entries()) {
    results.push(await run(model, index));
}
console.log(JSON.stringify({
    cachedLevels: knownReasoningEfforts("openrouter", "not-a-verified-model"),
    results,
}));

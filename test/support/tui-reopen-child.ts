import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { startTui } from "../../clients/tui/main.ts";
import { createHomeClient } from "../../clients/tui/home-client.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";
import { createTuiChildDependencies } from "./tui-child.ts";
import { createTuiResumeScenario } from "./tui-resume-child.ts";

installTestProcessGuard();
const home = process.env.VERA_HOME!;
if (process.argv[2] === "context") {
    const path = join(home, "saved.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: process.cwd() });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Find the crow" }] });
    await store.appendContextMeasurement({
        tokens: 8_500,
        estimated: true,
        projection: {
            estimatedTokens: 8_500,
            components: [{
                kind: "prompt_contribution", id: "instructions", owner: "core",
                source: "contextual", displayName: "Instructions", count: 1,
                estimatedTokens: 8_500,
            }],
        },
    });
    await store.appendMessage({
        role: "assistant", content: [{ type: "text", text: "The crow is aboard." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        stopReason: "stop",
    });
    await startTui(createTuiChildDependencies({
        resumeSessionPath: path,
        modelSettings: { model: "test", reasoningEffort: "high" },
    }));
} else {
    const scenario = createTuiResumeScenario({ home, targetLive: true });
    await startTui({
        ...scenario.dependencies,
        client: createHomeClient("/work/vera"),
        homeHasSessions: true,
        disabledIncludedExtensions: ["vera.diff"],
        authStorage: {
            getCredential: (provider) => provider === "openrouter" ? { type: "api_key", key: "fixture" } : undefined,
            setCredential() {}, deleteCredential() {},
        },
        createSession: async () => {
            appendFileSync(join(home, "created"), "created\n");
            const client = createSettingsAnsweringClient({
                agentId: "empty-session",
                workspace: "/work/vera",
                model: "test",
                mode: "auto",
                initialUpdates: [{
                    type: "history", entries: [],
                    status: process.argv[2] === "home-busy" ? "working" : "idle",
                    seq: 0,
                }],
                onCommand: (command, push) => {
                    if (command.type === "get_session_model_settings_history") {
                        push({ type: "status", state: "working", seq: 100 });
                    }
                },
            });
            if (process.argv[2] === "home-late-busy") {
                setTimeout(() => {
                    void client.send({ type: "get_session_model_settings_history", requestId: "start" });
                }, 1_500);
            }
            return client;
        },
    });
}
process.exit(0);

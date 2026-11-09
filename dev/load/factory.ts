import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "../../src/store/session-store.ts";
import { PreimageStash } from "../../src/store/preimage-stash.ts";
import { measureProjectedRequest } from "../../src/engine/context-measurement.ts";
import type { PromptContribution } from "../../src/engine/prompt-contributions.ts";
import { emptyUsage, type AssistantMessage, type ModelTool } from "../../src/model/types.ts";
import { includedExtensionIds } from "../../src/extensions/included.ts";
import { assertTrialHome, command, random } from "./common.ts";

export const FACTORY_VERSION = 4;

const MEASUREMENT_CAPACITY = 400_000;
const CONTEXT_MESSAGE_LIMIT = 900;
const TOOL_RESULT_LIMIT = 7_100;
// Mid-size sessions read whole files, which keeps the corpus measurement share
// near the daily home's while the giants keep the observed tool-result mix.
const MEDIUM_TOOL_RESULT_LIMIT = 30_000;

function toolResultLimit(targetBytes: number, small: boolean): number {
    if (small) return TOOL_RESULT_LIMIT;
    return targetBytes >= 1_000_000 && targetBytes < 20_000_000
        ? MEDIUM_TOOL_RESULT_LIMIT
        : TOOL_RESULT_LIMIT;
}

// Same shape the engine builds for a real request: instructions first, then one
// component per message, so a measurement grows with the context it describes.
const FACTORY_TOOLS: ModelTool[] = ["read", "edit", "grep", "bash", "glob", "write"].map((name) => ({
    name,
    description: `Use ${name} to inspect the pirate crow's charts and currents.`,
    inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path"] },
}));
const FACTORY_CONTRIBUTIONS: PromptContribution[] = [
    { id: "core.identity", owner: "core", target: "stable", title: "Identity", content: "You are Vera, a pirate crow's navigator. ".repeat(20) },
    { id: "core.narration", owner: "core", target: "stable", title: "Narration", content: "Say what you are doing as you go. ".repeat(20) },
    { id: "core.tools", owner: "core", target: "stable", title: "Tools", content: "Prefer reading before writing. ".repeat(40) },
    { id: "core.subagents", owner: "core", target: "stable", title: "Subagents", content: "Delegate independent work. ".repeat(20) },
    { id: "core.workspace", owner: "core", target: "stable", title: "Workspace", content: "/Users/nash/Projects/vera\n" },
    { id: "core.date", owner: "core", target: "contextual", title: "Date", content: "2026-11-04" },
];
const FACTORY_SYSTEM_PROMPT = FACTORY_CONTRIBUTIONS.map((contribution) => `## ${contribution.title}\n${contribution.content}`).join("\n\n");

async function measureContext(store: SessionStore, model: string): Promise<number> {
    const measurement = measureProjectedRequest({
        model,
        maxTokens: 2048,
        systemPrompt: FACTORY_SYSTEM_PROMPT,
        messages: store.modelContext(),
        tools: FACTORY_TOOLS,
        projectInstructions: { files: [], warnings: [] },
    }, MEASUREMENT_CAPACITY, {
        promptContributions: FACTORY_CONTRIBUTIONS,
        compaction: { triggerFraction: 0.82, triggerTokens: Math.floor(MEASUREMENT_CAPACITY * 0.82) },
    });
    await store.appendContextMeasurement(measurement);
    return measurement.tokens;
}
export interface FactorySession { id: string; bytes: number; targetBytes: number; }
export interface FactoryManifest {
    version: number;
    seed: number;
    bytes: number;
    sessions: FactorySession[];
    workspace: string;
}
export interface FactoryOptions { root: string; seed: number; workspace: string; small?: boolean; }

export function targetSizes(): number[] {
    const giants = [79.5, 60, 50, 40, 30, 25, 22, 20].map((mb) => mb * 1e6);
    const medium = Array.from({ length: 40 }, (_, i) => (1 + i % 7) * 1e6);
    const remaining = 545e6 - [...giants, ...medium].reduce((a, b) => a + b, 0);
    return [...giants, ...medium, ...Array(2252).fill(Math.floor(remaining / 2252))].sort((a, b) => b - a);
}

export async function buildFactory(options: FactoryOptions): Promise<FactoryManifest> {
    assertTrialHome();
    const { root, seed, workspace } = options;
    const manifestPath = join(root, "manifest.json");
    if (existsSync(manifestPath)) {
        const existing = JSON.parse(await readFile(manifestPath, "utf8")) as FactoryManifest;
        if (existing.version !== FACTORY_VERSION || existing.seed !== seed || existing.workspace !== workspace) {
            throw new Error("Factory cache key mismatch");
        }
        return existing;
    }
    if (existsSync(root)) throw new Error(`Incomplete factory: remove ${root} before retrying`);
    await mkdir(join(root, "home", "runtime", "sessions"), { recursive: true });
    await mkdir(join(root, "workspace", "sessions"), { recursive: true });
    const rng = random(seed);
    const sizes = options.small ? [350_000, 200_000, ...Array<number>(6).fill(30_000)] : targetSizes();
    const sessions: FactorySession[] = [];
    const corpus = Array.from({ length: 12000 }, (_, i) => `pirate crow chart ${i}: ${"reef current bearing ".repeat(8)}\n`).join("");
    await Bun.write(join(root, "workspace", "corpus.txt"), corpus);
    for (let index = 0; index < sizes.length; index++) {
        const id = `crow-${String(index).padStart(4, "0")}`;
        const path = join(root, "home", "runtime", "sessions", `${id}.jsonl`);
        let sequence = 0;
        const now = () => new Date(1793700000000 + index * 100000 + sequence * 1000);
        const store = await SessionStore.create(path, {
            sessionId: id, cwd: workspace, now, createId: () => `${id}-${++sequence}`,
        });
        await store.appendName(`Pirate crow voyage ${index}`);
        await store.appendModelSettings({ provider: `faux-${index % 3}`, model: `crow-${index % 20}` });
        await store.appendApprovalMode("auto");
        const source = { provider: `faux-${index % 3}`, api: "openai-chat-completions", model: `crow-${index % 20}` };
        const usage = { ...emptyUsage(), inputTokens: 24000, outputTokens: 200, totalTokens: 24200, cost: .0256 };
        let bytes = (await stat(path)).size;
        let turn = 0;
        let tokens = 0;
        while (bytes < sizes[index]! - 22000) {
            const remaining = sizes[index]! - bytes - 20000;
            const payloadSize = Math.max(1, Math.min(
                toolResultLimit(sizes[index]!, options.small === true),
                remaining - 2200,
            ));
            await store.appendMessage({ role: "user", content: [{ type: "text", text: `Inspect the pirate crow's voyage ${turn}.` }] });
            tokens = await measureContext(store, source.model);
            const callId = `read-${turn}`;
            await store.appendMessage({ role: "assistant", content: [{ type: "tool_call", id: callId, name: "read", input: { path: "corpus.txt", offset: 1, limit: 1000 } }], source, usage, stopReason: "tool_use" });
            const phrase = `pirate crow reef ${Math.floor(rng() * 100000)} chart and current\n`;
            await store.appendMessage({ role: "tool_result", toolCallId: callId, toolName: "read", isError: false, content: [{ type: "text", text: phrase.repeat(Math.ceil(payloadSize / phrase.length)).slice(0, payloadSize) }] });
            tokens = await measureContext(store, source.model);
            const final = await store.appendMessage({ role: "assistant", content: [{ type: "text", text: "The pirate crow recorded the bearings and checked the chart." }], source, usage, stopReason: "stop" });
            turn++;
            if (store.modelContext().length >= CONTEXT_MESSAGE_LIMIT || remaining < 150_000) {
                await store.appendCompaction({
                    boundaryMessageId: final.id, firstRetainedMessageId: null,
                    projection: [{ role: "user", content: [{ type: "text", text: "The pirate crow inspected the charts. Continue the voyage." }] }],
                    measured: { inputTokens: tokens, contextWindow: MEASUREMENT_CAPACITY, model: source.model, estimated: true },
                    billed: { provider: source.provider, model: source.model, usage },
                });
                await store.appendModelSettings({ provider: source.provider, model: `crow-${(index + turn) % 20}` });
            }
            bytes = (await stat(path)).size;
        }
        // A bounded retained context keeps the first turn comparable across transcript sizes.
        const boundary = store.entries().at(-1)!;
        await store.appendCompaction({ boundaryMessageId: boundary.id, firstRetainedMessageId: null,
            projection: [{ role: "user", content: [{ type: "text", text: "Prior voyage observations: " + "pirate crow chart reef bearings. ".repeat(600) }] }],
            measured: { inputTokens: tokens, contextWindow: MEASUREMENT_CAPACITY, estimated: true },
            billed: { provider: source.provider, model: source.model, usage },
        });
        await store.appendModelSettings({ provider: source.provider, model: source.model });
        if (index < 100 || options.small) {
            const editable = "pirate-crow-state:\n" + corpus.slice(0, 64000);
            await Bun.write(join(root, "workspace", "sessions", `${id}.txt`), editable);
            const stash = new PreimageStash(id, join(root, "home", "runtime", "stash"));
            await stash.capture(join(workspace, "archived", `${id}.txt`), editable);
        }
        sessions.push({ id, bytes: (await stat(path)).size, targetBytes: sizes[index]! });
        if (index % 100 === 0) process.stdout.write(`factory ${index + 1}/${sizes.length}\n`);
    }
    const manifest: FactoryManifest = { version: FACTORY_VERSION, seed, workspace, bytes: sessions.reduce((sum, session) => sum + session.bytes, 0), sessions };
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
}

export async function cloneFactory(factory: string, run: string): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Factory clones require macOS cp -c");
    await command(["/bin/cp", "-cR", join(factory, "home"), join(run, "home")]);
    await command(["/bin/cp", "-cR", join(factory, "workspace"), join(run, "workspace")]);
}

export async function configureHome(home: string, port: number, extensions: "included" | "none", workers?: number): Promise<void> {
    const models = Array.from({ length: 60 }, (_, i) => ({ name: `faux-model-${i}`, provider: `faux-${Math.floor(i / 20)}`, model: `crow-${i % 20}` }));
    const providers = Object.fromEntries([0, 1, 2].map((i) => [`faux-${i}`, { protocol: "openai-chat", credential: "none", base_url: `http://127.0.0.1:${port}/v1`, max_tokens: 2048 }]));
    const assignment = { models: [models[0]!] };
    await Bun.write(join(home, "config.json"), JSON.stringify({ schema_version: 1, provider: "faux-0", model: "crow-0", approval_mode: "auto", providers,
        models, model_routes: {}, reviewer_profiles: {},
        model_assignments: { snappy: assignment, eco: assignment, extra: assignment, compaction: assignment, reviewer: assignment },
        ...(workers === undefined ? {} : { host: { workers } }),
        curated_models_url: "", disabled_included_extensions: extensions === "none" ? includedExtensionIds() : [],
    }, null, 2));
    for (let i = 0; i < 3; i++) {
        await Bun.write(join(home, "runtime", "cache", `faux-${i}.json`), JSON.stringify({ schema_version: 2, provider: `faux-${i}`, fetched_at: new Date().toISOString(),
            models: Array.from({ length: 20 }, (_, j) => ({ id: `crow-${j}`, label: `Pirate crow ${j}`, context_window: 32000, tool_support: true, levels: [], pricing: { input: 1, output: 8 } })),
        }));
    }
}

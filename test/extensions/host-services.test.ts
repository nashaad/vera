import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    notifyObservers,
    notifyTurnFinished,
    type ExtensionHostServices,
    type ExtensionOneshotCall,
    type ExtensionSessionAskCall,
} from "../../src/extensions/host-services.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../src/extensions/registry.ts";
import type {
    PreCompactHookPayload,
    TurnFinishedHookPayload,
} from "../../src/sdk/hooks.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const payload: TurnFinishedHookPayload = {
    type: "turn_finished",
    sessionId: "session-1",
    workspace: "/deck",
    outcome: "completed",
    turns: 1,
    spawned: false,
    prompt: "plot a course for the shiny buttons",
    reply: "Course set, cap'n.",
};

test("turn-finished hooks need their capability and register only while activating", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const denied = createExtension("denied-turn.extension", `
        export function activate(vera) {
            vera.hooks.registerTurnFinished(() => {});
        }
    `);
    const deniedRegistry = await startExtensionRegistry({
        extensions: [configured(denied)],
        onFailure: (failure) => failures.push(failure),
    });
    expect(deniedRegistry.turnFinishedHooks()).toEqual([]);
    expect(failures[0]?.message).toContain("hooks.turn_finished");
    await deniedRegistry.close();

    const late = createExtension("late-turn.extension", `
        export let lateError;
        export function activate(vera) {
            vera.hooks.registerTurnFinished((payload) => {
                globalThis.__turnSeen = payload.prompt;
                try {
                    vera.hooks.registerTurnFinished(() => {});
                } catch (error) {
                    globalThis.__lateError = error.message;
                }
            });
        }
    `, ["hooks.turn_finished"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(late)],
    });
    expect(registry.turnFinishedHooks().map((hook) => hook.extensionId))
        .toEqual(["late-turn.extension"]);
    notifyTurnFinished(registry.turnFinishedHooks(), payload, () => {});
    await waitFor(() => globals().__lateError !== undefined);
    expect(globals().__turnSeen).toBe(payload.prompt);
    expect(registry.turnFinishedHooks()).toHaveLength(1);
    await registry.close();
});

test("a failing turn-finished hook is reported and does not stop the others", async () => {
    const seen: string[] = [];
    const failures: string[] = [];
    notifyTurnFinished([
        { extensionId: "broken", run: () => { throw new Error("kraken"); } },
        { extensionId: "rejects", run: async () => { throw new Error("squall"); } },
        { extensionId: "fine", run: (event) => { seen.push(event.sessionId); } },
    ], payload, (id, message) => failures.push(`${id}: ${message}`));
    await waitFor(() => failures.length === 2 && seen.length === 1);
    expect(failures.sort()).toEqual(["broken: kraken", "rejects: squall"]);
});

test("each turn-finished hook gets its own copy of the payload", async () => {
    const prompts: string[] = [];
    notifyTurnFinished([
        { extensionId: "mutator", run: (event) => { (event as { prompt: string }).prompt = "mutiny"; } },
        { extensionId: "reader", run: (event) => { prompts.push(event.prompt); } },
    ], payload, () => {});
    await waitFor(() => prompts.length === 1);
    expect(prompts).toEqual([payload.prompt]);
});

test("pre-compact hooks need their capability and get the payload", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const denied = createExtension("denied-compact.extension", `
        export function activate(vera) {
            vera.hooks.registerPreCompact(() => {});
        }
    `);
    const deniedRegistry = await startExtensionRegistry({
        extensions: [configured(denied)],
        onFailure: (failure) => failures.push(failure),
    });
    expect(deniedRegistry.preCompactHooks()).toEqual([]);
    expect(failures[0]?.message).toContain("hooks.pre_compact");
    await deniedRegistry.close();

    const ledger = createExtension("ledger.extension", `
        export function activate(vera) {
            vera.hooks.registerPreCompact((payload) => {
                globalThis.__compactSeen = payload.reason + " " + payload.tokens;
            });
        }
    `, ["hooks.pre_compact"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(ledger)],
    });
    const compacting: PreCompactHookPayload = {
        type: "pre_compact",
        sessionId: "session-1",
        workspace: "/deck",
        reason: "automatic",
        tokens: 182_000,
        capacity: 200_000,
        spawned: false,
    };
    expect(registry.preCompactHooks().map((hook) => hook.extensionId))
        .toEqual(["ledger.extension"]);
    notifyObservers(registry.preCompactHooks(), compacting, () => {});
    await waitFor(() => globals().__compactSeen !== undefined);
    expect(globals().__compactSeen).toBe("automatic 182000");
    await registry.close();
});

test("model, title and ask calls are capability-gated, wait for the host, and stop at close", async () => {
    const extension = createExtension("host.extension", `
        export function activate(vera) {
            globalThis.__hostApi = vera;
        }
    `, ["model.oneshot", "sessions.title", "sessions.ask"]);
    const bare = createExtension("bare.extension", `
        export function activate(vera) {
            globalThis.__bareApi = vera;
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension), configured(bare)],
    });
    const api = globals().__hostApi as HostApi;
    const bareApi = globals().__bareApi as HostApi;
    const request = {
        assignment: "snappy",
        messages: [{ role: "user", text: "name this voyage" }],
    };

    await expect(bareApi.model.oneshot(request)).rejects.toThrow("model.oneshot");
    await expect(bareApi.sessions.setTitle("session-1", "Loot")).rejects.toThrow("sessions.title");
    await expect(api.model.oneshot(request)).rejects.toThrow("not ready");
    await expect(api.sessions.setTitle("session-1", "Loot")).rejects.toThrow("not ready");
    const ask = { sessionId: "session-1", question: "Where did the crow bury the buttons?" };
    await expect(bareApi.sessions.ask(ask)).rejects.toThrow("sessions.ask");
    await expect(api.sessions.ask(ask)).rejects.toThrow("not ready");

    const calls: ExtensionOneshotCall[] = [];
    const titles: string[] = [];
    const asks: ExtensionSessionAskCall[] = [];
    const services: ExtensionHostServices = {
        async oneshot(call) {
            calls.push(call);
            return { text: "Raid on the button factory", model: "crow-mini", provider: "rookery" };
        },
        async setSessionTitle(sessionId, title) {
            titles.push(`${sessionId}=${title}`);
            return "set";
        },
        async askSession(call) {
            asks.push(call);
            return { text: "Under the lighthouse", model: "crow-large", provider: "rookery" };
        },
    };
    registry.bindHost(services);
    expect(() => registry.bindHost(services)).toThrow("already bound");

    expect(await api.model.oneshot(request)).toEqual({
        text: "Raid on the button factory",
        model: "crow-mini",
        provider: "rookery",
    });
    expect(calls[0]).toEqual({
        assignment: "snappy",
        systemPrompt: "",
        messages: [{ role: "user", text: "name this voyage" }],
    });
    expect(await api.sessions.setTitle("session-1", "  Raid on\nthe   factory ")).toBe("set");
    expect(titles).toEqual(["session-1=Raid on the factory"]);
    expect(await api.sessions.ask({ ...ask, maxTokens: 64 })).toEqual({
        text: "Under the lighthouse",
        model: "crow-large",
        provider: "rookery",
    });
    expect(asks).toEqual([{ ...ask, maxTokens: 64 }]);

    await registry.close();
    await expect(api.model.oneshot(request)).rejects.toThrow("closed");
    await expect(api.sessions.setTitle("session-1", "Loot")).rejects.toThrow("closed");
    await expect(api.sessions.ask(ask)).rejects.toThrow("closed");
});

test("bad oneshot, title and ask requests are refused before reaching the host", async () => {
    const extension = createExtension("strict.extension", `
        export function activate(vera) {
            globalThis.__strictApi = vera;
        }
    `, ["model.oneshot", "sessions.title", "sessions.ask"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    let reached = 0;
    registry.bindHost({
        async oneshot() {
            reached += 1;
            return { text: "", model: "crow-mini" };
        },
        async setSessionTitle() {
            reached += 1;
            return "set";
        },
        async askSession() {
            reached += 1;
            return { text: "", model: "crow-large" };
        },
    });
    const api = globals().__strictApi as HostApi;
    const user = [{ role: "user", text: "caw" }];

    await expect(api.model.oneshot({ assignment: "reviewer", messages: user })).rejects.toThrow("snappy, eco, extra");
    await expect(api.model.oneshot({ assignment: "eco", messages: [] })).rejects.toThrow("at least one message");
    await expect(api.model.oneshot({ assignment: "eco", messages: [{ role: "system", text: "x" }] })).rejects.toThrow("user or assistant");
    await expect(api.model.oneshot({ assignment: "eco", messages: user, maxTokens: 0 })).rejects.toThrow("maxTokens");
    await expect(api.model.oneshot({ assignment: "eco", messages: [{ role: "user", text: "x".repeat(256 * 1024 + 1) }] })).rejects.toThrow("exceeds");
    await expect(api.sessions.setTitle("session-1", "   ")).rejects.toThrow("1 to 200 bytes");
    await expect(api.sessions.setTitle("session-1", "x".repeat(201))).rejects.toThrow("1 to 200 bytes");
    await expect(api.sessions.setTitle("", "Loot")).rejects.toThrow("session ID");
    await expect(api.sessions.ask({ sessionId: "", question: "caw" })).rejects.toThrow("session ID");
    await expect(api.sessions.ask({ sessionId: "session-1", question: "  " })).rejects.toThrow("needs a question");
    await expect(api.sessions.ask({ sessionId: "session-1", question: "x".repeat(256 * 1024 + 1) })).rejects.toThrow("exceeds");
    await expect(api.sessions.ask({ sessionId: "session-1", question: "caw", maxTokens: 1.5 })).rejects.toThrow("maxTokens");
    await expect(api.sessions.ask({ sessionId: "session-1", question: "caw", signal: "stop" })).rejects.toThrow("AbortSignal");
    expect(reached).toBe(0);
    await registry.close();
});

test("closing the registry cancels a oneshot in flight", async () => {
    const extension = createExtension("cancel.extension", `
        export function activate(vera) {
            globalThis.__cancelApi = vera;
        }
    `, ["model.oneshot"]);
    const registry = await startExtensionRegistry({
        extensions: [configured(extension)],
    });
    let started = false;
    registry.bindHost({
        oneshot(_call, signal) {
            started = true;
            return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
            });
        },
        async setSessionTitle() {
            return "set";
        },
        askSession(_call, signal) {
            return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
            });
        },
    });
    const api = globals().__cancelApi as HostApi;
    const pending = api.model.oneshot({
        assignment: "snappy",
        messages: [{ role: "user", text: "caw" }],
    });
    await waitFor(() => started);
    await registry.close();
    await expect(pending).rejects.toThrow("closing");
});

interface HostApi {
    readonly model: { oneshot(request: unknown): Promise<unknown> };
    readonly sessions: {
        setTitle(sessionId: string, title: string): Promise<unknown>;
        ask(request: unknown): Promise<unknown>;
    };
}

function globals(): Record<string, unknown> {
    return globalThis as unknown as Record<string, unknown>;
}

function createExtension(
    id: string,
    source: string,
    capabilities: readonly string[] = ["commands.register"],
): string {
    const directory = join(tmpdir(), `vera-host-services-${crypto.randomUUID()}`);
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities,
    }));
    writeFileSync(join(directory, "extension.ts"), source);
    return directory;
}

function configured(path: string) {
    return { path, enabled: true, config: null };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return;
        }
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for the condition");
}

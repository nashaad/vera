import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { setHookDeadlinePolicy } from "../../src/engine/hook-deadline.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { SessionStore } from "../../src/store/session-store.ts";

for (const hasHostBus of [true, false]) test(`worker hook deadline failures use the event channel with host bus ${hasHostBus}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-worker-hook-failure-"));
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    try {
        const store = await SessionStore.create(join(root, "session.jsonl"), { sessionId: "crow", cwd: root });
        const hooks = new ToolHooks();
        const slow = () => new Promise<never>(() => {});
        setHookDeadlinePolicy(slow, { onFailure: "allow", blockReason: (failure) => failure });
        hooks.registerPreToolUse(slow);
        hooks.registerPreTurn(slow);
        const events = new EngineEventBus();
        const hostEvents: EngineEvent[] = [];
        events.subscribe((event) => hostEvents.push(event));
        const hostPipe = createJsonPipe({ input: toHost, output: toWorker }, {
            onRequest: (body) => server.handleRequest(body),
            onNotification: (body) => server.handleNotification(body),
        });
        const server = createWorkerBoundaryServer({
            pipe: hostPipe,
            store,
            services: { hooks, ...(hasHostBus ? { eventBus: events } : {}) },
        });
        const workerPipe = createJsonPipe({ input: toWorker, output: toHost }, {
            onNotification: (body) => remote.acceptNotification(body),
        });
        const remote = createRemoteHostBoundary({
            pipe: workerPipe,
            session: await readSessionSeed(store.path),
            offers: { approvalModeRead: false, modelSettings: false, selectedAgent: false },
            capabilities: {
                updateApprovalMode: false,
                reviewToolCall: false,
                applyHostToolEffect: false,
                requestMissingSubagentConfiguration: false,
                applyCommittedToolEffect: false,
                loadContextualContributions: false,
                checkSkillFile: false,
                hooks: true,
                reviewLog: false,
                hasPendingDeliveryTurn: false,
                selectAgent: false,
                listSkills: false,
                invokeSkill: false,
            },
            state: { policy: {} },
            onReplicaDiverged: () => {},
        });
        const workerEvents: EngineEvent[] = [];
        remote.boundary.owned.eventBus!.subscribe((event) => workerEvents.push(event));
        const call = { id: "call", name: "read", input: {} };
        expect((await remote.boundary.owned.hooks!.runPreToolUse({
            type: "pre_tool_use", workspace: root, toolCall: call,
        }, { timeoutMs: 20 })).result).toEqual({ power: "observe" });
        expect((await remote.boundary.owned.hooks!.runPreTurn({
            type: "pre_turn", workspace: root, prompt: "treasure", model: "test", tools: [],
            arrivedDuringTurn: false, spawned: false,
        }, { timeoutMs: 20 })).result).toEqual({ power: "observe" });
        const expected: EngineEvent[] = [
            { type: "tool_hook_failed", phase: "pre_tool_use", toolCall: call, error: "pre_tool_use hooks timed out after 20ms" },
            { type: "turn_hook_failed", phase: "pre_turn", error: "pre_turn hooks timed out after 20ms" },
        ];
        expect(hostEvents).toEqual(hasHostBus ? expected : []);
        expect(workerEvents).toEqual(expected);
        workerPipe.close();
        hostPipe.close();
    } finally {
        toWorker.destroy();
        toHost.destroy();
        rmSync(root, { recursive: true, force: true });
    }
});

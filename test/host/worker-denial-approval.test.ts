import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { HookToolCall } from "../../src/sdk/hooks.ts";
import type { ToolApprovalUiRequest } from "../../src/engine/events.ts";
import type { ReviewDecisionMediationRequest } from "../../src/engine/loop-services.ts";
import { denialApprovalLimitForRequest, mediateReviewDecision } from "../../src/host/review-decision-mediation.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const call: HookToolCall = { id: "call-1", name: "write", input: { path: "treasure.txt" } };

async function boundary(services: Parameters<typeof createWorkerBoundaryServer>[0]["services"] = {}) {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-denial-approval-"));
    directories.push(directory);
    const store = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "denial-approval",
        cwd: directory,
    });
    const toWorker = new PassThrough();
    const toHost = new PassThrough();
    const server = createWorkerBoundaryServer({
        pipe: createJsonPipe(
            { input: toHost, output: toWorker },
            {
                onRequest: (body) => server.handleRequest(body),
                onNotification: (body) => server.handleNotification(body),
            },
        ),
        store,
        services,
    });
    const remote = createRemoteHostBoundary({
        pipe: createJsonPipe(
            { input: toWorker, output: toHost },
            { onNotification: (body) => remote.acceptNotification(body) },
        ),
        session: await readSessionSeed(store.path),
        offers: { approvalModeRead: false, modelSettings: false, selectedAgent: false },
        capabilities: {
            updateApprovalMode: false,
            reviewToolCall: false,
            mediateReviewDecision: true,
            requestMediatedApproval: true,
            relayToolApproval: true,
            applyHostToolEffect: false,
            requestMissingSubagentConfiguration: false,
            applyCommittedToolEffect: false,
            loadContextualContributions: false,
            checkSkillFile: false,
            hooks: false,
            reviewLog: false,
            hasPendingDeliveryTurn: false,
            selectAgent: false,
            listSkills: false,
            invokeSkill: false,
        },
        state: { policy: {} },
        onReplicaDiverged: () => {},
    });
    return { store, remote, toHost, toWorker };
}

function reviewRequest(workspace: string): ReviewDecisionMediationRequest {
    return {
        approvalMode: "auto",
        review: {
            decision: "deny",
            reason: "The change would expose a secret.",
            riskLevel: "high",
            userAuthorization: "unknown",
            model: { provider: "local", model: "reviewer" },
        },
        toolCall: call,
        workspace,
        chat: true,
    };
}

test("review mediation crosses the worker boundary with review metadata and options", async () => {
    const linked = await boundary({ mediateReviewDecision });
    const request = reviewRequest(linked.store.header.cwd);

    await expect(linked.remote.boundary.mediateReviewDecision?.(request)).resolves.toEqual({
        reason: "The change would expose a secret.",
        options: {
            restrictedChoices: true,
            allowNotes: false,
            review: {
                decision: "deny",
                reason: "The change would expose a secret.",
                riskLevel: "high",
                model: "local/reviewer",
            },
            workspace: linked.store.header.cwd,
            chat: true,
            pendingLimit: { key: "classifier-denial", max: 16 },
        },
    });
});

test("mediated approvals preserve options and return either host decision", async () => {
    for (const result of [
        { behavior: "allow" as const },
        { behavior: "deny" as const, reason: "Denied", notes: "not safe" },
    ]) {
        let observed: unknown;
        const linked = await boundary({
            requestMediatedApproval: async (receivedCall, reason, options) => {
                observed = { receivedCall, reason, options: { ...options, signal: undefined } };
                return result;
            },
        });
        const options = {
            timeoutMs: 12_000,
            restrictedChoices: true as const,
            allowNotes: false as const,
            review: { decision: "deny" as const, reason: "Risk", riskLevel: "medium" as const, model: "r/m" },
            pendingLimit: { key: "classifier-denial", max: 16 },
            workspace: linked.store.header.cwd,
            chat: true,
        };

        await expect(linked.remote.boundary.requestMediatedApproval?.(call, "Risk", options)).resolves.toEqual(result);
        expect(observed).toEqual({ receivedCall: call, reason: "Risk", options: { ...options, signal: undefined } });
    }
});

test("relayed approvals return allow-once and deny decisions", async () => {
    const update = {
        type: "ui_request" as const,
        requestId: "request-1",
        seq: 1,
        request: {
            type: "tool_approval" as const,
            toolCall: call,
            reason: "Review required",
            warning: "Approval required",
        },
    };
    for (const decision of ["allow_once", "deny"] as const) {
        const linked = await boundary({ relayToolApproval: async () => decision });
        await expect(linked.remote.boundary.relayToolApproval?.(update, "child", "task", new AbortController().signal)).resolves.toBe(decision);
    }
});

test("an aborted approval signal aborts the in-flight host request", async () => {
    let hostSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const linked = await boundary({
        requestMediatedApproval: async (_call, _reason, options) => {
            hostSignal = options.signal;
            entered();
            return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ behavior: "deny", reason: "aborted" }), { once: true }));
        },
    });
    const controller = new AbortController();
    const pending = linked.remote.boundary.requestMediatedApproval?.(call, "Risk", { timeoutMs: 12_000, signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).resolves.toEqual({ behavior: "deny", reason: "aborted" });
    expect(hostSignal?.aborted).toBe(true);
});

test("closing the worker pipe aborts an in-flight host request", async () => {
    let hostSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const linked = await boundary({
        requestMediatedApproval: async (_call, _reason, options) => {
            hostSignal = options.signal;
            entered();
            return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ behavior: "deny", reason: "closed" }), { once: true }));
        },
    });
    const pending = linked.remote.boundary.requestMediatedApproval?.(call, "Risk", { timeoutMs: 12_000 });
    await started;
    linked.toHost.destroy();
    await Bun.sleep(5);
    expect(hostSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: "deny", reason: "closed" });
});

test("the denial approval policy applies only in auto mode", async () => {
    const request = reviewRequest("/workspace");
    expect(await mediateReviewDecision(request)).toBeDefined();
    expect(await mediateReviewDecision({ ...request, approvalMode: "custom-review" })).toBeUndefined();
    expect(await mediateReviewDecision({ ...request, approvalMode: "ask" })).toBeUndefined();
});

test("denial approval limits apply only to denied reviews", () => {
    const denied = {
        type: "tool_approval" as const,
        requestId: "denied",
        toolCall: call,
        reason: "Denied by review",
        warning: "Approval required",
        review: { decision: "deny" as const, reason: "Risk", riskLevel: "high" as const },
    } as ToolApprovalUiRequest;
    expect(denialApprovalLimitForRequest(denied)).toEqual({ key: "classifier-denial", max: 16 });
    expect(denialApprovalLimitForRequest({ ...denied, review: undefined })).toBeUndefined();
});

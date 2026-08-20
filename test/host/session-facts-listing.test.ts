import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentPageThroughHost } from "../../src/host/agent-list-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ModelFailureLedger } from "../../src/store/model-failures.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import type { ModelMessage } from "../../src/model/types.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "the host serves paged session facts, and they survive a restart",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-host-facts-"));
        const workspace = await realpath(root);
        const sessionDirectory = join(root, "sessions");
        const ledgerPath = join(root, "model-failures.jsonl");

        for (const [index, id] of ["first", "second", "third"].entries()) {
            const store = await SessionStore.create(
                join(sessionDirectory, `${id}.jsonl`),
                { sessionId: id, cwd: workspace },
            );
            await store.appendMessage({
                role: "user",
                content: [{ type: "text", text: "hello" }],
            });
            await store.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "ok" }],
                source: { provider: "faux", api: "scripted", model: "test" },
                usage: {
                    inputTokens: 1_000 * (index + 1),
                    outputTokens: 10,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    totalTokens: 1_000 * (index + 1) + 10,
                    cost: 0.25,
                },
                durationMs: 100,
                stopReason: "stop",
            } as ModelMessage);
        }

        new ModelFailureLedger(ledgerPath).record({
            at: "2026-08-20T12:00:00.000Z",
            provider: "faux",
            model: "test",
            kind: "provider_failure",
            detail: "credit balance is too low",
            sessionId: "second",
        });

        const socketPath = join(root, "host.sock");
        const hostOptions = {
            config: {
                schema_version: 1 as const,
                provider: "openrouter",
                model: "faux/test",
                approval_mode: "auto" as const,
            },
            createAdapter: () => new FauxAdapter([]),
            socketPath,
            lockPath: join(root, "host.json"),
            sessionDirectory,
            modelFailureLedgerPath: ledgerPath,
        };

        let host = await startResidentHost(hostOptions);
        try {
            const first = await listAgentPageThroughHost(socketPath, {
                include: ["usage", "context", "failure", "model"],
                limit: 2,
            });
            expect(first.total).toBe(3);
            expect(first.agents.map((agent) => agent.id))
                .toEqual(["first", "second"]);
            expect(first.nextCursor).toBe("second");
            expect(first.agents[0]?.facts?.usage?.rows).toEqual([{
                provider: "faux",
                model: "test",
                calls: 1,
                durationMs: 100,
                inputTokens: 1_000,
                outputTokens: 10,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 1_010,
                cost: 0.25,
                callsWithoutCost: 0,
            }]);
            expect(first.agents[0]?.facts?.context?.tokens).toBe(1_000);
            expect(first.agents[0]?.facts?.model)
                .toEqual({ provider: "faux", model: "test" });
            // The ledger is profile-wide, so only the session it names carries
            // the failure.
            expect(first.agents[0]?.facts?.failure).toBeUndefined();
            expect(first.agents[1]?.facts?.failure?.detail)
                .toBe("credit balance is too low");

            const second = await listAgentPageThroughHost(socketPath, {
                include: ["usage"],
                limit: 2,
                cursor: first.nextCursor!,
            });
            expect(second.agents.map((agent) => agent.id)).toEqual(["third"]);
            expect(second.nextCursor).toBeUndefined();
            // Only the named fact is computed.
            expect(second.agents[0]?.facts?.context).toBeUndefined();
            expect(second.agents[0]?.facts?.usage?.rows[0]?.inputTokens)
                .toBe(3_000);

            // A listing that asks for nothing stays the historic shape.
            const plain = await listAgentPageThroughHost(socketPath);
            expect(plain.agents).toHaveLength(3);
            expect(plain.agents.every((agent) => agent.facts === undefined))
                .toBeTrue();
        } finally {
            await host.close();
        }

        host = await startResidentHost(hostOptions);
        try {
            const restarted = await listAgentPageThroughHost(socketPath, {
                include: ["usage", "failure"],
            });
            expect(restarted.agents.map((agent) => agent.id))
                .toEqual(["first", "second", "third"]);
            expect(
                restarted.agents.map((agent) =>
                    agent.facts?.usage?.rows[0]?.totalTokens
                ),
            ).toEqual([1_010, 2_010, 3_010]);
            expect(restarted.agents[1]?.facts?.failure?.kind)
                .toBe("provider_failure");
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

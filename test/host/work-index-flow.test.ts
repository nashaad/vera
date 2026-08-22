import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import type { WorkIndexSnapshot } from "../../src/host/work-index.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

/**
 * The work index against a real resident host and a real session store, so the
 * projection is proved where it actually runs rather than against facts a test
 * handed it.
 */

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "ask",
} as const;

const socketTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

socketTest("a real pending approval reaches a real client's work index", async () => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-work-flow-")),
    );
    const socketPath = join(root, "host.sock");
    const host = await startResidentHost({
        config,
        createAdapter: () => new FauxAdapter([
            toolResponse(),
            textResponse("finished"),
        ]),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "events"),
    });
    await host.registry.create({ id: "agent-1", workspace: root });
    const client = await attachAgent({
        socketPath,
        agentId: "agent-1",
        requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
    });
    try {
        expect(client.supportsHostCapability(HOST_CAPABILITY_WORK_INDEX))
            .toBe(true);
        // An idle session is not work, so the host's own session is absent
        // from the first index rather than listed as something it is holding.
        //
        // About this session, not about the whole index: the inbox is
        // machine-wide on purpose, so what else is on it is not this test's
        // business and is not something a test can control.
        await settle();
        expect(rowsFor(client.workIndex, "agent-1")).toEqual([]);

        await client.send({ type: "prompt", content: "run it" });
        const waiting = await untilIndex(
            client,
            (index) => index.needs_you === 1,
        );

        const row = waiting.rows[0];
        expect(row?.section).toBe("needs_you");
        expect(row?.reason).toBe("approval");
        expect(row?.session_id).toBe("agent-1");
        expect(row?.summary).toBe("bash env APPROVAL=ran");
        expect(row?.workspace).toBe(root);

        await client.send({
            type: "ui_response",
            requestId: await requestIdOf(client),
            response: { type: "tool_approval", decision: "deny" },
        });
        const answered = await untilIndex(
            client,
            (index) => index.needs_you === 0,
        );
        expect(answered.rows.filter((entry) => entry.reason === "approval"))
            .toEqual([]);
    } finally {
        client.close();
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}, 15_000);

socketTest("the index costs the same however many clients watch", async () => {
    // Run the identical transition twice, once watched by one client and once
    // by three. The claim is that deriving the index is a property of the
    // roster changing, not of how many people happen to be looking at it, so
    // the two counts have to match.
    const alone = await derivationsForWatchers(1);
    const crowd = await derivationsForWatchers(3);
    expect(alone).toBeGreaterThan(0);
    expect(crowd).toBe(alone);
});

async function derivationsForWatchers(watchers: number): Promise<number> {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "vera-work-share-")),
    );
    const socketPath = join(root, "host.sock");
    const host = await startResidentHost({
        config,
        createAdapter: () => new FauxAdapter([textResponse("finished")]),
        socketPath,
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "events"),
    });
    await host.registry.create({ id: "agent-1", workspace: root });
    const clients: Awaited<ReturnType<typeof attachAgent>>[] = [];
    try {
        for (let index = 0; index < watchers; index += 1) {
            clients.push(await attachAgent({
                socketPath,
                agentId: "agent-1",
                requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
            }));
        }
        await settle();
        // Counted on the registry rather than on the snapshot: deriving the
        // facts stats each session and scans its stash, and that is the half
        // worth doing once.
        const registry = host.registry as unknown as {
            workFacts: () => readonly unknown[];
        };
        const real = registry.workFacts.bind(registry);
        let derivations = 0;
        registry.workFacts = (): readonly unknown[] => {
            derivations += 1;
            return real();
        };
        await clients[0]!.send({ type: "prompt", content: "run it" });
        await settle();
        registry.workFacts = real;
        return derivations;
    } finally {
        for (const client of clients) client.close();
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
}

/**
 * The request id, read off the agent's own update stream.
 *
 * The index deliberately does not carry one: answering a request is the
 * attachment's job, and a row that carried an id would invite a second way to
 * answer that never went through the approval surface.
 */
async function requestIdOf(
    client: { receive(): Promise<{ readonly type: string }> },
): Promise<string> {
    while (true) {
        const update = await client.receive() as {
            readonly type: string;
            readonly requestId?: string;
        };
        if (update.type === "ui_request" && update.requestId !== undefined) {
            return update.requestId;
        }
    }
}

function rowsFor(
    index: WorkIndexSnapshot | undefined,
    sessionId: string,
): readonly unknown[] {
    return (index?.rows ?? []).filter((row) => row.session_id === sessionId);
}

async function untilIndex(
    client: {
        readonly workIndex: WorkIndexSnapshot | undefined;
        onWorkIndex(listener: (index: WorkIndexSnapshot) => void): () => void;
    },
    matches: (index: WorkIndexSnapshot) => boolean,
): Promise<WorkIndexSnapshot> {
    if (client.workIndex !== undefined && matches(client.workIndex)) {
        return client.workIndex;
    }
    return new Promise((resolve) => {
        const stop = client.onWorkIndex((index) => {
            if (!matches(index)) return;
            stop();
            resolve(index);
        });
    });
}

function settle(): Promise<void> {
    return Bun.sleep(100);
}

function toolResponse(): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "bash-1",
            name: "bash",
            input: { command: "env APPROVAL=ran" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

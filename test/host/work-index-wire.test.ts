import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { attachAgent } from "../../src/host/attached-client.ts";
import { HOST_CAPABILITY_WORK_INDEX } from "../../src/host/capabilities.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import {
    buildWorkIndex,
    type WorkIndexSnapshot,
} from "../../src/host/work-index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-work-index-"));
    temporaryDirectories.push(directory);
    return directory;
}

// Fixed, so two readings of unchanged work are byte-identical and the
// resend comparison is testing the comparison rather than the clock.
const UPDATED_AT = "2026-08-14T12:00:00.000Z";

function workingIndex(tool?: string): WorkIndexSnapshot {
    return buildWorkIndex([{
        id: "agent-1",
        session_path: "/sessions/agent-1.jsonl",
        title: "relay-gui",
        workspace: "/work/one",
        kind: "interactive",
        status: "working",
        live: true,
        updated_at: UPDATED_AT,
        ...(tool === undefined ? {} : { active_tool: tool }),
    }]);
}

/**
 * The first index usually lands before any caller can subscribe, because the
 * host sends it directly behind the attach reply. The getter is the snapshot
 * and the listener is only for what changes after it.
 */
async function firstIndex(client: {
    readonly workIndex: WorkIndexSnapshot | undefined;
    onWorkIndex(listener: (index: WorkIndexSnapshot) => void): () => void;
}): Promise<WorkIndexSnapshot> {
    if (client.workIndex !== undefined) return client.workIndex;
    return new Promise((resolve) => {
        const stop = client.onWorkIndex((index) => {
            stop();
            resolve(index);
        });
    });
}

const networked = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

networked("a client that negotiated the capability is sent the index", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_WORK_INDEX],
        findAgent: () => agent,
        readWorkIndex: () => workingIndex("edit"),
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
    });
    try {
        const index = await firstIndex(client);
        expect(index.working).toBe(1);
        expect(index.rows[0]?.title).toBe("relay-gui");
        expect(index.rows[0]?.summary).toBe("Running edit");
        expect(client.workIndex).toEqual(index);
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

networked("a client that did not ask for the index is never sent one", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_WORK_INDEX],
        findAgent: () => agent,
        readWorkIndex: () => workingIndex(),
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [],
    });
    try {
        // Long enough for the attach reply and anything that rode behind it.
        await Bun.sleep(50);
        // Undefined and not an empty index: an attachment that cannot see the
        // inbox must not report that there is no work.
        expect(client.workIndex).toBeUndefined();
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

networked("a roster change resends the index only when it differs", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    let tool: string | undefined = "edit";
    let notifyRosterChanged = (): void => undefined;
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        capabilities: [HOST_CAPABILITY_WORK_INDEX],
        findAgent: () => agent,
        readWorkIndex: () => workingIndex(tool),
        onRosterChanged: (listener) => {
            notifyRosterChanged = listener;
            return () => undefined;
        },
    });
    const client = await attachAgent({
        socketPath,
        agentId: agent.id,
        requestedCapabilities: [HOST_CAPABILITY_WORK_INDEX],
    });
    try {
        await firstIndex(client);
        let reports = 0;
        client.onWorkIndex(() => {
            reports += 1;
        });

        notifyRosterChanged();
        await Bun.sleep(30);
        expect(reports).toBe(0);

        tool = "bash";
        notifyRosterChanged();
        await Bun.sleep(30);
        expect(reports).toBe(1);
        expect(client.workIndex?.rows[0]?.summary).toBe("Running bash");
    } finally {
        client.close();
        agent.close();
        await server.close();
    }
});

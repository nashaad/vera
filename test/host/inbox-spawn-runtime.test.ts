import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import { Inbox } from "../../src/store/inbox.ts";
import {
    SpawnConsentStore,
    type SpawnRequest,
    type SpawnedSession,
} from "../../src/host/inbox-spawn.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import type { VeraConfig } from "../../src/config.ts";

const BASE_CONFIG: VeraConfig = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "auto",
};

interface Bench {
    readonly root: string;
    readonly inboxPath: string;
    readonly consentPath: string;
    readonly requests: SpawnRequest[];
    start(options: {
        confirmed: boolean;
    }): Promise<{ close(): Promise<void> }>;
    cleanup(): Promise<void>;
}

async function bench(): Promise<Bench> {
    const root = await mkdtemp(join(tmpdir(), "vera-spawn-runtime-"));
    const inboxPath = join(root, "inbox.db");
    const consentPath = join(root, "spawn-consent.json");
    const requests: SpawnRequest[] = [];
    return {
        root,
        inboxPath,
        consentPath,
        requests,
        async start({ confirmed }) {
            if (confirmed) {
                SpawnConsentStore.open(consentPath).confirm();
            }
            const host = await startResidentHost({
                config: BASE_CONFIG,
                createAdapter: () => new FauxAdapter([]),
                socketPath: join(root, "h.sock"),
                lockPath: join(root, "host.json"),
                sessionDirectory: join(root, "sessions"),
                eventLogDirectory: join(root, "logs"),
                inboxPath,
                spawnConsentPath: consentPath,
                spawnSession: (request): Promise<SpawnedSession | null> => {
                    requests.push(request);
                    return Promise.resolve({
                        label: request.address,
                        recordProvenance: () => Promise.resolve(),
                    });
                },
            });
            return host;
        },
        async cleanup() {
            await rm(root, { recursive: true, force: true });
        },
    };
}

function appendEntry(inboxPath: string): void {
    const inbox = Inbox.open(inboxPath);
    try {
        inbox.append({
            source: "arc",
            kind: "issue.updated",
            address: "dormant",
            payload: "{}",
        });
    } finally {
        inbox.close();
    }
}

const hostTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

hostTest("a fresh install spawns nothing", async () => {
    const harness = await bench();
    const host = await harness.start({ confirmed: false });
    try {
        appendEntry(harness.inboxPath);
        await host.close();
        expect(harness.requests).toHaveLength(0);
    } finally {
        await harness.cleanup();
    }
});

hostTest("confirmed inbox arrivals cannot cold-spawn a session", async () => {
    const harness = await bench();
    const host = await harness.start({ confirmed: true });
    try {
        appendEntry(harness.inboxPath);
        await host.close();
        expect(harness.requests).toHaveLength(0);
    } finally {
        await harness.cleanup();
    }
});

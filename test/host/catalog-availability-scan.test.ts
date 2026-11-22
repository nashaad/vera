import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { refreshCatalogsThroughHost } from "../../src/host/catalog-refresh-client.ts";
import { type ModelAvailabilityEntry, type ModelAvailabilityRecord } from "../../src/model/model-availability.ts";
import { startResidentHost, type ResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type ModelAdapter } from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { modelAvailabilityRecordPathIn } from "../../src/profile-paths.ts";
import type { AuthStorage } from "../../src/providers/auth-storage.ts";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";

const adapter: ModelAdapter = {
    stream() {
        const stream = new ModelEventStream();
        stream.push({ type: "start" });
        stream.push({
            type: "done",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                source: {
                    provider: "test-gateway",
                    api: "openai-chat-completions",
                    model: "alpha",
                },
                usage: emptyUsage(),
                stopReason: "stop",
            },
        });
        return stream;
    },
};

const authStorage = {
    getCredential: () => undefined,
    setCredential: () => {},
    deleteCredential: () => {},
} satisfies AuthStorage;

interface Fixture {
    readonly root: string;
    readonly socketPath: string;
    readonly listed: { value: readonly string[] };
    readonly status: { value: number };
    readonly server: ReturnType<typeof Bun.serve>;
}

function fixture(prefix: string, extra: Record<string, unknown> = {}): Fixture {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const listed = { value: ["alpha"] as readonly string[] };
    const status = { value: 200 };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
            if (status.value !== 200) {
                return new Response("nope", { status: status.value });
            }
            return Response.json({ data: listed.value.map((id) => ({ id })) });
        },
    });
    writeFileSync(join(root, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "test-gateway",
        model: "alpha",
        approval_mode: "ask",
        curated_models_url: "",
        providers: {
            "test-gateway": {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${server.port}/v1`,
                credential: "none",
                discovery: { mode: "models", credential: "none" },
            },
        },
        ...extra,
    }));
    writeFileSync(join(root, "pool.json"), JSON.stringify({
        models: { "test-gateway/alpha": { added: true } },
    }));
    return { root, socketPath: join(root, "host.sock"), listed, status, server };
}

async function startHost(test: Fixture, catalogScan: {
    readonly minDelayMs?: number;
    readonly intervalMs?: number;
}): Promise<ResidentHost> {
    const clock = Date.now();
    const host = await startResidentHost({
        config: loadVeraConfig({ path: join(test.root, "config.json") }),
        home: test.root,
        createAdapter: () => adapter,
        authStorage,
        socketPath: test.socketPath,
        lockPath: join(test.root, "host.json"),
        sessionDirectory: join(test.root, "sessions"),
        eventLogDirectory: join(test.root, "logs"),
        catalogScan: { now: () => clock, ...catalogScan },
    });
    await host.registry.create({
        workspace: test.root,
        sessionPath: join(test.root, "sessions", "agent.jsonl"),
    });
    return host;
}

async function close(fixture: Fixture, host: ResidentHost | undefined): Promise<void> {
    try {
        await host?.close();
    } finally {
        fixture.server.stop(true);
        rmSync(fixture.root, { recursive: true, force: true });
    }
}

async function readRecord(root: string): Promise<ModelAvailabilityRecord | undefined> {
    try {
        return JSON.parse(await readFile(modelAvailabilityRecordPathIn(root), "utf8")) as ModelAvailabilityRecord;
    } catch {
        return undefined;
    }
}

async function readLog(root: string): Promise<Array<{ readonly type: string } & Record<string, unknown>>> {
    try {
        const text = await readFile(join(root, "runtime", "logs", "host.jsonl"), "utf8");
        return text.split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as { readonly type: string } & Record<string, unknown>);
    } catch {
        return [];
    }
}

async function waitFor<T>(
    read: () => Promise<T | undefined>,
    done: (value: T) => boolean,
    what: string,
): Promise<T> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
        const value = await read();
        if (value !== undefined && done(value)) return value;
        await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function alpha(record: ModelAvailabilityRecord): ModelAvailabilityEntry | undefined {
    return record.models.find((entry) => entry.provider === "test-gateway" && entry.model === "alpha");
}

function seed(root: string, entry: ModelAvailabilityEntry): void {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(modelAvailabilityRecordPathIn(root), JSON.stringify({
        schema_version: 1,
        last_scan_at: new Date(Date.now() - 90).toISOString(),
        models: [entry],
    }));
}

socketAndLoopbackTest(
    "boot schedules no scan and writes no record",
    async () => {
        const test = fixture("vera-availability-boot-");
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 60_000, intervalMs: 120_000 });
            await Bun.sleep(120);
            expect(await readRecord(test.root)).toBeUndefined();
            expect((await readLog(test.root)).some((entry) => entry.type === "model_catalog_scan")).toBe(false);
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a host scan records a sighting, then two misses and one drop notice",
    async () => {
        const test = fixture("vera-availability-cycle-");
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 10, intervalMs: 100 });
            const seen = await waitFor(
                () => readRecord(test.root),
                (record) => alpha(record)?.last_seen_at !== undefined,
                "the first daily scan",
            );
            expect(alpha(seen)!.missing_scans).toBe(0);

            test.listed.value = ["beta"];
            const dropped = await waitFor(
                () => readRecord(test.root),
                (record) => alpha(record)?.dropped_at !== undefined,
                "the dropped model",
            );
            const entry = alpha(dropped)!;
            expect(entry.first_missing_at).toBeDefined();
            expect(entry.missing_scans).toBeGreaterThanOrEqual(2);
            expect(entry.notified_at).toBeDefined();

            const log = await readLog(test.root);
            expect(log.filter((line) => line.type === "model_dropped")).toHaveLength(1);
            const scan = log.find((line) => line.type === "model_catalog_scan");
            expect(scan).toBeDefined();
            expect(scan!.source).toBe("daily");
            expect(Array.isArray(scan!.outcomes)).toBe(true);
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a restart continues a one-miss record instead of resetting it",
    async () => {
        const test = fixture("vera-availability-restart-");
        const firstMissing = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
        const lastSeen = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
        seed(test.root, {
            provider: "test-gateway",
            model: "alpha",
            roles: ["favorite", "default"],
            last_seen_at: lastSeen,
            first_missing_at: firstMissing,
            missing_scans: 1,
        });
        test.listed.value = ["beta"];
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 10, intervalMs: 100 });
            const dropped = await waitFor(
                () => readRecord(test.root),
                (record) => alpha(record)?.dropped_at !== undefined,
                "the second miss",
            );
            expect(alpha(dropped)!.first_missing_at).toBe(firstMissing);
            expect(alpha(dropped)!.last_seen_at).toBe(lastSeen);
            expect(alpha(dropped)!.missing_scans).toBeGreaterThanOrEqual(2);
            expect((await readLog(test.root)).filter((line) => line.type === "model_dropped")).toHaveLength(1);
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a failed provider answer is logged and does not advance the miss count",
    async () => {
        const test = fixture("vera-availability-failure-");
        const firstMissing = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
        seed(test.root, {
            provider: "test-gateway",
            model: "alpha",
            roles: ["favorite", "default"],
            last_seen_at: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
            first_missing_at: firstMissing,
            missing_scans: 1,
        });
        test.status.value = 500;
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 10, intervalMs: 100 });
            const log = await waitFor(
                () => readLog(test.root),
                (lines) => lines.some((line) => line.type === "model_catalog_scan"),
                "the scan summary",
            );
            const outcomes = log.find((line) => line.type === "model_catalog_scan")!.outcomes as
                readonly { readonly provider: string; readonly failure?: string }[];
            expect(outcomes).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                failure: "unavailable",
            }));

            const record = await readRecord(test.root);
            expect(alpha(record!)!.missing_scans).toBe(1);
            expect(alpha(record!)!.first_missing_at).toBe(firstMissing);
            expect(alpha(record!)!.dropped_at).toBeUndefined();
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "@core an Off provider keeps its availability record without a drop",
    async () => {
        const test = fixture("vera-availability-off-", {
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            disabled_providers: ["test-gateway"],
        });
        seed(test.root, {
            provider: "test-gateway",
            model: "alpha",
            roles: ["favorite"],
            last_seen_at: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
            missing_scans: 0,
        });
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 10, intervalMs: 100 });
            const scanned = await waitFor(
                () => readRecord(test.root),
                (record) => record.last_scan_at !== undefined,
                "the first daily scan",
            );
            const entry = alpha(scanned)!;
            expect(entry.missing_scans).toBe(0);
            expect(entry.first_missing_at).toBeUndefined();
            expect(entry.dropped_at).toBeUndefined();
            const outcomes = (await readLog(test.root))
                .filter((line) => line.type === "model_catalog_scan")
                .flatMap((line) => line.outcomes as readonly { readonly provider: string }[]);
            expect(outcomes.some((outcome) => outcome.provider === "test-gateway"))
                .toBe(false);
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a manual full refresh holds off the next daily scan",
    async () => {
        const test = fixture("vera-availability-manual-");
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 10, intervalMs: 100 });
            const scanned = await waitFor(
                () => readRecord(test.root),
                (record) => record.last_scan_at !== undefined,
                "the first daily scan",
            );
            const outcomes = await refreshCatalogsThroughHost(test.socketPath);
            expect(outcomes).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                models: 1,
            }));
            await Bun.sleep(260);
            const after = await readRecord(test.root);
            expect(after!.last_scan_at).toBe(scanned.last_scan_at);
            const skipped = (await readLog(test.root)).filter((line) =>
                line.type === "model_catalog_scan_skipped");
            expect(skipped.length).toBeGreaterThan(0);
            expect(skipped[0]!.reason).toBe("recent_manual_refresh");
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

socketAndLoopbackTest(
    "a record write failure leaves the catalog refresh working",
    async () => {
        const test = fixture("vera-availability-writefail-");
        mkdirSync(join(test.root, "runtime", "model-availability.json"), { recursive: true });
        let host: ResidentHost | undefined;
        try {
            host = await startHost(test, { minDelayMs: 10, intervalMs: 100 });
            const log = await waitFor(
                () => readLog(test.root),
                (lines) => lines.some((line) => line.type === "model_availability_record_failed"),
                "the failed record write",
            );
            expect(log.some((line) => line.type === "model_catalog_scan")).toBe(true);
            const outcomes = await refreshCatalogsThroughHost(test.socketPath);
            expect(outcomes).toContainEqual(expect.objectContaining({
                provider: "test-gateway",
                models: 1,
            }));
        } finally {
            await close(test, host);
        }
    },
    20_000,
);

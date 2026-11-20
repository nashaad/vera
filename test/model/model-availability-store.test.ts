import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    MAX_TRACKED_MODELS,
    ModelAvailabilityStore,
    type ModelAvailabilityEntry,
    type ModelAvailabilityRecord,
} from "../../src/model/model-availability.ts";
import { modelAvailabilityRecordPathIn } from "../../src/profile-paths.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        chmodSync(directory, 0o700);
        rmSync(directory, { recursive: true, force: true });
    }
});

function home(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-availability-"));
    directories.push(directory);
    return directory;
}

function entry(overrides: Partial<ModelAvailabilityEntry> = {}): ModelAvailabilityEntry {
    return {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        roles: ["favorite"],
        last_seen_at: "2026-11-18T15:00:00.000Z",
        missing_scans: 0,
        ...overrides,
    };
}

function record(models: readonly ModelAvailabilityEntry[]): ModelAvailabilityRecord {
    return { schema_version: 1, last_scan_at: "2026-11-20T15:00:00.000Z", models };
}

test("the record lives under the home runtime directory", () => {
    expect(modelAvailabilityRecordPathIn("/tmp/vera-home")).toBe(
        "/tmp/vera-home/runtime/model-availability.json",
    );
});

test("a record round trips through a real file and a new store instance", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    const store = new ModelAvailabilityStore(path, () => true);
    expect(store.write(record([entry({ roles: ["favorite", "default"] })]))).toBe(true);

    const reread = new ModelAvailabilityStore(path, () => true).read();
    expect(reread).toEqual(record([entry({ roles: ["favorite", "default"] })]));
    expect(JSON.parse(readFileSync(path, "utf8")).models[0].roles).toEqual(["favorite", "default"]);
});

test("a missing record reads as undefined", () => {
    const store = new ModelAvailabilityStore(modelAvailabilityRecordPathIn(home()), () => true);
    expect(store.read()).toBeUndefined();
});

test("corrupt and wrongly shaped records are ignored and logged", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    const entries: Array<{ readonly type: string } & Record<string, unknown>> = [];
    const store = new ModelAvailabilityStore(path, (entry) => {
        entries.push(entry);
        return true;
    });

    writeFileSync(path, "{");
    expect(store.read()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ schema_version: 2, models: [] }));
    expect(store.read()).toBeUndefined();
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        models: [entry({ last_seen_at: "yesterday" })],
    }));
    expect(store.read()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ schema_version: 1, models: [entry({ missing_scans: 1.5 })] }));
    expect(store.read()).toBeUndefined();

    expect(entries.filter((entry) => entry.type === "model_availability_record_invalid")).toHaveLength(4);
});

test("an oversized record is refused before parsing", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(path, " ".repeat(256 * 1_024 + 1));
    const logged: string[] = [];
    const store = new ModelAvailabilityStore(path, (entry) => {
        logged.push(entry.type);
        return true;
    });
    expect(store.read()).toBeUndefined();
    expect(logged).toEqual(["model_availability_record_invalid"]);
});

test("unknown roles are dropped and known ones kept in a stable order", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        models: [{
            provider: "openrouter",
            model: "a/b",
            roles: ["assignment:eco", "not-a-role", "default"],
            missing_scans: 0,
        }],
    }));
    const read = new ModelAvailabilityStore(path, () => true).read();
    expect(read?.models[0]!.roles).toEqual(["default", "assignment:eco"]);
});

test("a read-only runtime directory logs a failed write instead of throwing", () => {
    const root = home();
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o500 });
    const logged: string[] = [];
    const store = new ModelAvailabilityStore(modelAvailabilityRecordPathIn(root), (entry) => {
        logged.push(entry.type);
        return true;
    });
    expect(store.write(record([entry()]))).toBe(false);
    expect(logged).toEqual(["model_availability_record_failed"]);
});

test("a written record and its directory are private", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    expect(new ModelAvailabilityStore(path, () => true).write(record([entry()]))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "runtime")).mode & 0o777).toBe(0o700);
});

test("the write cap keeps pinned entries and logs the overflow", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    const models: ModelAvailabilityEntry[] = Array.from(
        { length: MAX_TRACKED_MODELS + 1 },
        (_, index) => entry({ model: `model-${index}`, roles: ["favorite"] }),
    );
    models[models.length - 1] = entry({ model: "assigned", roles: ["assignment:eco"] });
    const logged: Array<{ readonly type: string } & Record<string, unknown>> = [];
    expect(new ModelAvailabilityStore(path, (entry) => {
        logged.push(entry);
        return true;
    }).write(record(models))).toBe(true);

    const written = JSON.parse(readFileSync(path, "utf8")) as { models: readonly ModelAvailabilityEntry[] };
    expect(written.models).toHaveLength(MAX_TRACKED_MODELS);
    expect(written.models.some((entry) => entry.model === "assigned")).toBe(true);
    expect(logged).toEqual([{ type: "model_availability_over_cap", dropped: 1 }]);
});

test("a full scan cycle survives a process boundary", () => {
    const root = home();
    const path = modelAvailabilityRecordPathIn(root);
    const first = new ModelAvailabilityStore(path, () => true);
    first.write(record([entry({ last_seen_at: "2026-11-18T15:00:00.000Z" })]));

    const second = new ModelAvailabilityStore(path, () => true);
    const held = second.read()!;
    expect(held.models[0]!.last_seen_at).toBe("2026-11-18T15:00:00.000Z");
    second.write({
        schema_version: 1,
        last_scan_at: "2026-11-21T15:00:00.000Z",
        models: [{ ...held.models[0]!, first_missing_at: "2026-11-21T15:00:00.000Z", missing_scans: 1 }],
    });

    const third = new ModelAvailabilityStore(path, () => true).read()!;
    expect(third.last_scan_at).toBe("2026-11-21T15:00:00.000Z");
    expect(third.models[0]!.missing_scans).toBe(1);
    expect(third.models[0]!.first_missing_at).toBe("2026-11-21T15:00:00.000Z");
});

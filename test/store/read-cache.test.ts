import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createFileReadCache, createReadCache } from "../../src/store/read-cache.ts";
import { createLiveVeraConfigReader, loadVeraConfig } from "../../src/config.ts";
import { effectiveCatalog, loadDiscoveryCatalog } from "../../src/model/catalog.ts";
import { loadPoolFile } from "../../src/model/pool-file-loader.ts";

test("file caches detect same-size replacement with a preserved modification time", () => {
    const directory = mkdtempSync(join(tmpdir(), "read-cache-"));
    const path = join(directory, "file.json");
    let reads = 0;
    const read = createFileReadCache((file) => {
        reads += 1;
        try { return readFileSync(file, "utf8"); }
        catch { return undefined; }
    });
    try {
        expect(read(path)).toBeUndefined();
        expect(read(path)).toBeUndefined();
        expect(reads).toBe(1);
        writeFileSync(path, "first");
        expect(read(path)).toBe("first");
        expect(read(path)).toBe("first");
        expect(reads).toBe(2);
        const stamp = statSync(path);
        writeFileSync(`${path}.new`, "other");
        utimesSync(`${path}.new`, stamp.atime, stamp.mtime);
        renameSync(`${path}.new`, path);
        expect(read(path)).toBe("other");
        expect(reads).toBe(3);
        unlinkSync(path);
        expect(read(path)).toBeUndefined();
        expect(reads).toBe(4);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("live configuration detects same-size replacement and keeps the last valid value", () => {
    const directory = mkdtempSync(join(tmpdir(), "config-cache-"));
    const path = join(directory, "config.json");
    const config = { schema_version: 1, provider: "ollama", model: "crow-a", approval_mode: "ask" };
    try {
        writeFileSync(path, JSON.stringify(config));
        const read = createLiveVeraConfigReader(loadVeraConfig({ path }), { path });
        expect(read().model).toBe("crow-a");
        const stamp = statSync(path);
        writeFileSync(`${path}.new`, JSON.stringify({ ...config, model: "crow-b" }));
        utimesSync(`${path}.new`, stamp.atime, stamp.mtime);
        renameSync(`${path}.new`, path);
        expect(read().model).toBe("crow-b");
        writeFileSync(path, "{");
        expect(read().model).toBe("crow-b");
        unlinkSync(path);
        expect(read().model).toBe("crow-b");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("pool diagnostics change even when invalid files share an empty result", () => {
    const directory = mkdtempSync(join(tmpdir(), "pool-cache-"));
    const userPath = join(directory, "pool.json");
    try {
        expect(loadPoolFile({ userPath }).issues).toEqual([]);
        writeFileSync(userPath, "{");
        const malformed = loadPoolFile({ userPath });
        expect(malformed.issues.length).toBeGreaterThan(0);
        expect(loadPoolFile({ userPath })).toBe(malformed);
        writeFileSync(userPath, "[]");
        expect(loadPoolFile({ userPath }).issues).not.toEqual(malformed.issues);
        unlinkSync(userPath);
        expect(loadPoolFile({ userPath }).issues).toEqual([]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("read caches replace generations and evict entries at their limit", () => {
    const read = createReadCache<object>(2);
    const first = read("a", [1], () => ({}));
    expect(read("a", [1], () => ({}))).toBe(first);
    expect(read("a", [2], () => ({}))).not.toBe(first);
    const second = read("a", [2], () => ({}));
    read("b", [], () => ({}));
    read("c", [], () => ({}));
    expect(read("a", [2], () => ({}))).not.toBe(second);
});

test("catalog reads retain an empty result for unsafe provider ids", () => {
    expect(effectiveCatalog("../pirate-crow").models).toEqual([]);
    expect(loadDiscoveryCatalog("../pirate-crow")).toBeUndefined();
});

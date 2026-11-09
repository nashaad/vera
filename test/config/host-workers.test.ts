import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVeraConfig, updateVeraConfigDefaults, VeraConfigError } from "../../src/config.ts";

test("host worker settings load and survive config updates", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-host-config-"));
    const path = join(root, "config.json");
    try {
        for (const host of [undefined, {}, { workers: 0 }, { workers: 1 }, { workers: 4 }]) {
            writeFileSync(path, JSON.stringify({ schema_version: 1, model: "crow", ...(host === undefined ? {} : { host }) }));
            expect(loadVeraConfig({ path }).host).toEqual(host);
            updateVeraConfigDefaults({ context_limit: 16_000 }, { path });
            expect(JSON.parse(readFileSync(path, "utf8")).host).toEqual(host);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("invalid host worker settings use the config error format", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-host-config-"));
    const path = join(root, "config.json");
    try {
        for (const host of [null, [], "pool", 1, { workers: null }, { workers: false }, { workers: "1" },
            { workers: -1 }, { workers: 0.5 }, { workers: Number.MAX_SAFE_INTEGER + 1 }]) {
            writeFileSync(path, JSON.stringify({ schema_version: 1, model: "crow", host }));
            expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
            expect(() => loadVeraConfig({ path })).toThrow("host must be an object with workers set to a non-negative integer");
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

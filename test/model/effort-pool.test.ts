import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPoolEffortPool } from "../../src/model/effort-pool.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

const REF = { provider: "cerebras", model: "m" };

function poolPath(file: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-effort-pool-"));
    directories.push(directory);
    const path = join(directory, "pool.json");
    writeFileSync(path, JSON.stringify(file));
    return path;
}

test("a declared level resolves to its provider wire string", () => {
    const path = poolPath({
        models: { "cerebras/m": { efforts: { high: "high", xhigh: null } } },
    });

    const resolved = createPoolEffortPool({ userPath: path, path })
        .resolveEffort(REF, "high");

    expect(resolved.providerEffort).toBe("high");
    expect(resolved.efforts.xhigh).toBeNull();
});

test("a level nothing knows about carries no wire string", () => {
    const path = poolPath({ models: { "cerebras/m": {} } });

    const resolved = createPoolEffortPool({ userPath: path, path })
        .resolveEffort(REF, "xhigh");

    expect(resolved.providerEffort).toBeUndefined();
});

test("a learned rejection forbids the level it names", () => {
    const path = poolPath({
        models: {
            "cerebras/m": {
                learned: {
                    "efforts.xhigh": { ok: false, seen: "2026-08-06" },
                },
            },
        },
    });

    const resolved = createPoolEffortPool({ userPath: path, path })
        .resolveEffort(REF, "xhigh");

    expect(resolved.efforts.xhigh).toBeNull();
});

test("a recorded fact lands under learned and leaves declared fields alone", () => {
    const path = poolPath({
        models: { "cerebras/m": { efforts: { xhigh: "xhigh" } } },
    });

    createPoolEffortPool({ userPath: path, path }).recordLearned(
        REF,
        "efforts.xhigh",
        { ok: false, seen: "2026-08-06", error: "not supported" },
    );

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.models["cerebras/m"]).toEqual({
        efforts: { xhigh: "xhigh" },
        learned: {
            "efforts.xhigh": {
                ok: false,
                seen: "2026-08-06",
                error: "not supported",
            },
        },
    });
});

test("a declared level survives a learned rejection of it", () => {
    const path = poolPath({
        models: {
            "cerebras/m": {
                efforts: { xhigh: "xhigh" },
                learned: {
                    "efforts.xhigh": { ok: false, seen: "2026-08-06" },
                },
            },
        },
    });

    const resolved = createPoolEffortPool({ userPath: path, path })
        .resolveEffort(REF, "xhigh");

    expect(resolved.providerEffort).toBe("xhigh");
});

test("a project pool file overrides the user's declared level", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-effort-pool-project-"));
    directories.push(directory);
    const userPath = join(directory, "pool.json");
    writeFileSync(userPath, JSON.stringify({
        models: { "cerebras/m": { efforts: { high: "high", xhigh: "xhigh" } } },
    }));
    const projectRoot = join(directory, "checkout");
    mkdirSync(join(projectRoot, ".vera"), { recursive: true });
    writeFileSync(
        join(projectRoot, ".vera", "pool.json"),
        JSON.stringify({ models: { "cerebras/m": { efforts: { xhigh: null } } } }),
    );

    const pool = createPoolEffortPool({ userPath, path: userPath, projectRoot });

    expect(pool.resolveEffort(REF, "xhigh").providerEffort).toBeUndefined();
    expect(pool.resolveEffort(REF, "xhigh").efforts.xhigh).toBeNull();
    expect(pool.resolveEffort(REF, "high").providerEffort).toBe("high");
});

test("without a project root the project overlay is not read", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-effort-pool-scope-"));
    directories.push(directory);
    const userPath = join(directory, "pool.json");
    writeFileSync(userPath, JSON.stringify({
        models: { "cerebras/m": { efforts: { xhigh: "xhigh" } } },
    }));
    mkdirSync(join(directory, "checkout", ".vera"), { recursive: true });
    writeFileSync(
        join(directory, "checkout", ".vera", "pool.json"),
        JSON.stringify({ models: { "cerebras/m": { efforts: { xhigh: null } } } }),
    );

    const pool = createPoolEffortPool({ userPath, path: userPath });

    expect(pool.resolveEffort(REF, "xhigh").providerEffort).toBe("xhigh");
});

test("a declared level the provider rejected keeps working and says so", () => {
    const path = poolPath({
        models: {
            "cerebras/m": {
                efforts: { xhigh: "xhigh" },
                learned: {
                    "efforts.xhigh": {
                        ok: false,
                        seen: "2026-08-06",
                        error: "unsupported reasoning effort",
                    },
                },
            },
        },
    });

    const resolved = createPoolEffortPool({ userPath: path, path })
        .resolveEffort(REF, "xhigh");

    expect(resolved.providerEffort).toBe("xhigh");
    expect(resolved.reason).toContain("the pool file declares effort \"xhigh\"");
    expect(resolved.reason).toContain("unsupported reasoning effort");
});

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function config(assigned: string, extra: Record<string, unknown> = {}) {
    return {
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
        models: [
            { name: "one", provider: "openrouter", model: "faux/one" },
            { name: "two", provider: "openrouter", model: "faux/two" },
        ],
        model_routes: { one: ["one"], two: ["two"] },
        reviewer_profiles: {},
        model_assignments: { compaction: { model_route: assigned } },
        ...extra,
    };
}

// An assignment is a setting the user changes from inside a running Vera. The
// host reads it when a session starts, so the change has to reach the next
// session on its own.
test("an assignment written after the host started needs no restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-assignment-live-"));
    const configPath = join(root, "profiles", "default", "config.json");
    const poolPath = join(root, "pool.json");
    const previousHome = process.env.VERA_HOME;
    const previousPool = process.env.VERA_POOL_FILE;
    process.env.VERA_POOL_FILE = poolPath;
    await writeFile(
        poolPath,
        JSON.stringify({
            models: { "openrouter/faux/one": {}, "openrouter/faux/two": {} },
        }),
    );
    process.env.VERA_HOME = root;
    await mkdir(join(root, "profiles", "default"), { recursive: true });
    await writeFile(configPath, JSON.stringify(config("one")));
    const host = await startResidentHost({
        config: config("one") as never,
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });
    try {
        const options = (host.registry as unknown as {
            options: { compactionModels?: readonly { model: string }[] };
        }).options;
        expect(options.compactionModels?.map((entry) => entry.model))
            .toEqual(["faux/one"]);
        expect(host.registry.readReviewer()).toBeUndefined();
        await writeFile(configPath, JSON.stringify(config("two", {
            model_assignments: {
                compaction: { model_route: "two" },
                reviewer: { model_route: "two" },
            },
        })));
        expect(options.compactionModels?.map((entry) => entry.model))
            .toEqual(["faux/two"]);
        expect(host.registry.readReviewer()?.models).toEqual([{
            provider: "openrouter",
            model: "faux/two",
        }]);
    } finally {
        await host.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
        else process.env.VERA_POOL_FILE = previousPool;
        await rm(root, { recursive: true, force: true });
    }
});


// Every setting the host hands the registry, not just the assignments: the one
// accessor they all read through is what makes this a property of the file
// rather than a fix applied one setting at a time.
test("a setting changed on disk reaches the registry with no restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-settings-live-"));
    const configPath = join(root, "profiles", "default", "config.json");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = root;
    await mkdir(join(root, "profiles", "default"), { recursive: true });
    await writeFile(configPath, JSON.stringify(config("one")));
    const host = await startResidentHost({
        config: config("one") as never,
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });
    try {
        const options = (host.registry as unknown as {
            options: Record<string, unknown>;
        }).options;
        expect(options.subagentModel).toBeUndefined();
        expect(options.permissionModes).toBeUndefined();
        expect(options.disabledPromptContributions).toBeUndefined();
        expect(options.modelFallback).toBeUndefined();
        await writeFile(
            configPath,
            JSON.stringify(config("one", {
                subagent: { model: "faux/two", provider: "openrouter" },
                permission_modes: { careful: { default: "ask", rules: [] } },
                disabled_prompt_contributions: ["environment"],
                fallback: { model: "faux/two", after_failures: 1 },
            })),
        );
        expect((options.subagentModel as { model: string }).model)
            .toBe("faux/two");
        expect(Object.keys(options.permissionModes as object))
            .toEqual(["careful"]);
        expect(options.disabledPromptContributions).toEqual(["environment"]);
        expect(options.modelFallback).toBeDefined();
    } finally {
        await host.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
    }
});

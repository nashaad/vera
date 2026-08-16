import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function config(assigned: string) {
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
        await writeFile(configPath, JSON.stringify(config("two")));
        expect(options.compactionModels?.map((entry) => entry.model))
            .toEqual(["faux/two"]);
    } finally {
        await host.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
        else process.env.VERA_POOL_FILE = previousPool;
        await rm(root, { recursive: true, force: true });
    }
});

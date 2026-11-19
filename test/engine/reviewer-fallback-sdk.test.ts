import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cacheBuildId } from "../../src/release/cache-build-id.ts";

interface RecordedRequest {
    readonly model: string;
    readonly effort: string | null;
    readonly hasEffort: boolean;
}

interface RunResult {
    readonly model: string;
    readonly outcome: string;
    readonly targetExists: boolean;
    readonly requests: readonly RecordedRequest[];
}

test("@core SDK classifier effort uses only bundled verified levels", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-sdk-reviewer-fallback-"));
    const home = join(root, "home");
    const cache = join(home, "runtime", "cache");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "openrouter.json"), JSON.stringify({
        schema_version: 2,
        build_id: cacheBuildId(),
        provider: "openrouter",
        models: [{
            id: "not-a-verified-model",
            label: "Not verified",
            levels: [{ id: "low", label: "Low" }],
        }],
    }));
    const { VERA_POOL_FILE: _poolFile, ...environment } = process.env;
    const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "reviewer-fallback-sdk-run.ts"), root],
        env: { ...environment, VERA_HOME: home, NODE_ENV: "test" },
        stdout: "pipe",
        stderr: "pipe",
    });
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        const { cachedLevels, results } = JSON.parse(stdout) as {
            cachedLevels: readonly string[];
            results: readonly RunResult[];
        };
        expect(cachedLevels).toEqual(["low"]);
        expect(results.map(({ model, outcome, targetExists }) => ({ model, outcome, targetExists }))).toEqual([
            { model: "not-a-verified-model", outcome: "completed", targetExists: false },
            { model: "moonshotai/kimi-k3", outcome: "completed", targetExists: false },
            { model: "z-ai/glm-5.2", outcome: "completed", targetExists: false },
        ]);
        expect(results.map(({ requests }) => requests)).toEqual([
            [
                { model: "not-a-verified-model", effort: "max", hasEffort: true },
                { model: "not-a-verified-model", effort: null, hasEffort: false },
                { model: "not-a-verified-model", effort: "max", hasEffort: true },
            ],
            [
                { model: "moonshotai/kimi-k3", effort: "max", hasEffort: true },
                { model: "moonshotai/kimi-k3", effort: "low", hasEffort: true },
                { model: "moonshotai/kimi-k3", effort: "max", hasEffort: true },
            ],
            [
                { model: "z-ai/glm-5.2", effort: "max", hasEffort: true },
                { model: "z-ai/glm-5.2", effort: "high", hasEffort: true },
                { model: "z-ai/glm-5.2", effort: "max", hasEffort: true },
            ],
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

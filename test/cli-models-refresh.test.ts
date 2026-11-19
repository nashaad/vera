import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../clients/cli/main.ts";
import {
    readProviderCatalogSnapshot,
    writeProviderCatalogSnapshot,
} from "../src/model/catalog-cache.ts";

interface Refreshed {
    readonly output: string;
    readonly exitCode: number;
}

async function modelsRefresh(): Promise<Refreshed> {
    let output = "";
    const exitCode = await runCli(["models", "refresh"], {
        stdout: { write: (text) => output += text },
        readLiveHost: async () => undefined,
        refreshCatalogsThroughHost: async () => {
            throw new Error("must not ask a host");
        },
    });
    return { output, exitCode };
}

async function homeWithOpenRouter(
    response: () => Response,
): Promise<{
    readonly root: string;
    readonly server: ReturnType<typeof Bun.serve>;
}> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vera-models-refresh-")));
    const server = Bun.serve({
        port: 0,
        fetch: response,
    });
    await writeFile(join(root, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "vendor/model-0",
        approval_mode: "ask",
        provider_endpoints: {
            openrouter: `http://127.0.0.1:${server.port}/v1`,
            ollama: "http://127.0.0.1:1",
        },
    }));
    return { root, server };
}

function rememberTwoModels(root: string): void {
    writeProviderCatalogSnapshot({
        schema_version: 2,
        provider: "openrouter",
        fetched_at: new Date().toISOString(),
        models: [
            { id: "vendor/remembered", label: "Remembered", levels: [] },
            { id: "vendor/also-remembered", label: "Also Remembered", levels: [] },
        ],
    }, { cacheDir: join(root, "runtime", "cache") });
}

async function withHome(
    root: string,
    body: () => Promise<void>,
): Promise<void> {
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = root;
    try {
        await body();
    } finally {
        if (previousHome === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
        else process.env.VERA_HOME = previousHome;
    }
}

test("vera models refresh names a provider it could not reach instead of zero models", async () => {
    const { root, server } = await homeWithOpenRouter(
        () => new Response("down", { status: 500 }),
    );
    try {
        await withHome(root, async () => {
            const { output, exitCode } = await modelsRefresh();

            expect(output).toContain("openrouter: failed (provider unavailable)\n");
            expect(output).not.toContain("openrouter: 0 models");
            expect(exitCode).toBe(1);
        });
    } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});

test("vera models refresh says how many cached models a failed provider kept", async () => {
    const { root, server } = await homeWithOpenRouter(
        () => new Response("down", { status: 500 }),
    );
    try {
        await withHome(root, async () => {
            rememberTwoModels(root);
            const { output } = await modelsRefresh();

            expect(output).toContain(
                "openrouter: failed (provider unavailable; kept 2 cached models)\n",
            );
            const kept = readProviderCatalogSnapshot("openrouter", {
                cacheDir: join(root, "runtime", "cache"),
            });
            expect(kept.models.map((model) => model.id)).toEqual([
                "vendor/remembered",
                "vendor/also-remembered",
            ]);
        });
    } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});

test("vera models refresh calls an empty model list a failure", async () => {
    const { root, server } = await homeWithOpenRouter(
        () => Response.json({ data: [] }),
    );
    try {
        await withHome(root, async () => {
            const { output } = await modelsRefresh();

            expect(output).toContain("openrouter: failed (empty response)\n");
            expect(output).not.toContain("openrouter: 0 models");
        });
    } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});

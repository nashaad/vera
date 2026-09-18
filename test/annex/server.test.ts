import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packWebAssets } from "../../scripts/pack-web.ts";
import { annexPathsFromHome } from "../../src/annex/home.ts";
import { exactRoute } from "../../src/annex/routes.ts";
import { startAnnexServer } from "../../src/annex/server.ts";

const temporaryDirectories: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function packedAssets(): Promise<string> {
    const directory = tempDir("vera-annex-packed-");
    await packWebAssets(directory, { force: true });
    return directory;
}

test("a second annex route is served without importing the host", async () => {
    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-annex-extra-"),
        webRoot: await packedAssets(),
        extraRoutes: [
            exactRoute("/probe", () => new Response("annex-probe")),
        ],
    });
    servers.push(server);
    const response = await fetch(`${server.url}probe`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("annex-probe");
});

test("vera-annex starts by hand against a Vera home", async () => {
    const home = tempDir("vera-annex-home-");
    const assets = await packedAssets();
    const entry = fileURLToPath(
        new URL("../../src/annex/main.ts", import.meta.url),
    );
    const child = Bun.spawn(
        ["bun", entry, "--home", home, "--port", "0", "--assets", assets],
        {
            argv0: "vera-annex",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let url: string | undefined;
    try {
        while (url === undefined) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            const line = buffered.split("\n")[0]?.trim();
            if (line !== undefined && line.startsWith("http://127.0.0.1:")) {
                url = line.endsWith("/") ? line : `${line}/`;
            }
        }
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const page = await fetch(new URL("usage", url).href);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("<title>Vera</title>");
        const paths = annexPathsFromHome(home);
        expect(paths.sessionDirectory).toContain(home);
    } finally {
        child.kill("SIGTERM");
        await child.exited;
    }
});

test("the runs page lists Halcyon runs and their spans", async () => {
    const workflowDirectory = tempDir("vera-annex-runs-");
    const entry = join(workflowDirectory, "entry.py");
    writeFileSync(entry, [
        "from pathlib import Path",
        "import sys",
        "from vera.workflow.api import step, workflow",
        "",
        "LEFT = {'n': 1}",
        "",
        "@step(retries=2)",
        "def shaky() -> int:",
        "    if LEFT['n'] > 0:",
        "        LEFT['n'] -= 1",
        "        raise RuntimeError('upstream said no')",
        "    return 5",
        "",
        "@workflow",
        "def demo() -> int:",
        "    return shaky()",
        "",
        "if __name__ == '__main__':",
        "    demo.run(journal_dir=Path(sys.argv[1]))",
        "",
    ].join("\n"));
    const python = Bun.spawnSync(
        ["python3", entry, workflowDirectory],
        { env: { ...process.env, PYTHONPATH: resolve(import.meta.dir, "../../python") } },
    );
    expect(python.exitCode).toBe(0);

    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-annex-runs-sessions-"),
        workflowDirectory,
        webRoot: await packedAssets(),
    });
    servers.push(server);

    const list = await (await fetch(`${server.url}api/runs`)).json() as {
        rows: { runId: string; workflow: string; status: string; tries: number; failedTries: number }[];
    };
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.workflow).toBe("demo");
    expect(list.rows[0]?.status).toBe("ok");
    expect(list.rows[0]?.tries).toBe(2);
    expect(list.rows[0]?.failedTries).toBe(1);

    const detail = await (
        await fetch(`${server.url}api/runs/${list.rows[0]?.runId ?? ""}`)
    ).json() as {
        attempts: { spans: { outcome?: string }[] }[];
        steps: unknown[];
        orphanSpans: unknown[];
    };
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]?.spans.map((span) => span.outcome))
        .toEqual(["failed", "ok"]);
    expect(detail.steps).toHaveLength(1);
    expect(detail.orphanSpans).toEqual([]);

    const missing = await fetch(`${server.url}api/runs/wf_00000000000000ff`);
    expect(missing.status).toBe(404);

    const page = await fetch(`${server.url}runs`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
});

test("the runs page prices the model calls a step recorded", async () => {
    const workflowDirectory = tempDir("vera-annex-cost-");
    const entry = join(workflowDirectory, "entry.py");
    writeFileSync(entry, [
        "from pathlib import Path",
        "import sys",
        "from vera.workflow.api import model_call, step, workflow",
        "",
        "@step",
        "def ask() -> str:",
        "    with model_call('claude-opus-5', provider='anthropic') as call:",
        "        call.usage(input_tokens=1200, output_tokens=310, cost=0.0123)",
        "    return 'done'",
        "",
        "@workflow",
        "def priced() -> str:",
        "    return ask()",
        "",
        "if __name__ == '__main__':",
        "    priced.run(journal_dir=Path(sys.argv[1]))",
        "",
    ].join("\n"));
    const python = Bun.spawnSync(
        ["python3", entry, workflowDirectory],
        { env: { ...process.env, PYTHONPATH: resolve(import.meta.dir, "../../python") } },
    );
    expect(python.exitCode).toBe(0);

    const server = await startAnnexServer({
        sessionDirectory: tempDir("vera-annex-cost-sessions-"),
        workflowDirectory,
        webRoot: await packedAssets(),
    });
    servers.push(server);

    const list = await (await fetch(`${server.url}api/runs`)).json() as {
        rows: { runId: string; cost?: number; steps: number; tries: number }[];
    };
    expect(list.rows[0]?.cost).toBeCloseTo(0.0123, 6);
    expect(list.rows[0]?.steps).toBe(1);
    expect(list.rows[0]?.tries).toBe(1);

    const detail = await (
        await fetch(`${server.url}api/runs/${list.rows[0]?.runId ?? ""}`)
    ).json() as {
        cost?: number;
        attempts: {
            spans: {
                spanId: string;
                parentId: string;
                depth: number;
                step: string;
                model?: string;
                tokens?: number;
                cost?: number;
            }[];
        }[];
    };
    const spans = detail.attempts[0]?.spans ?? [];
    expect(detail.cost).toBeCloseTo(0.0123, 6);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.depth).toBe(0);
    expect(spans[0]?.model).toBeUndefined();
    expect(spans[1]?.parentId).toBe(spans[0]?.spanId ?? "");
    expect(spans[1]?.depth).toBe(1);
    expect(spans[1]?.step).toBe("claude-opus-5");
    expect(spans[1]?.tokens).toBe(1510);
    expect(spans[1]?.cost).toBeCloseTo(0.0123, 6);
});

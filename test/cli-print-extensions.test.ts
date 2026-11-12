import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHostlessPrint } from "../clients/cli/main.ts";
import { loopbackTest } from "./support/socket-probe.ts";

const WIRE_MODEL = "print-extension-model";

function sseReply(text: string): Response {
    const body = [
        `data: {"model":"${WIRE_MODEL}","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
        "",
        "data: [DONE]",
        "",
    ].join("\n");
    return new Response(body, {
        headers: { "content-type": "text/event-stream" },
    });
}

async function writeExtension(
    root: string,
    name: string,
    source: string,
): Promise<string> {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "vera.extension.json"),
        JSON.stringify({
            id: `test.${name}`,
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: ["hooks.model_middleware"],
        }),
    );
    await writeFile(join(directory, "extension.ts"), source);
    return directory;
}

const RECORDING_EXTENSION = `import { appendFileSync } from "node:fs";

export function activate(vera) {
    const logPath = vera.config.logPath;
    vera.onDispose(() => appendFileSync(logPath, JSON.stringify({ disposed: true }) + "\\n"));
    vera.hooks.registerModelMiddleware((adapter, context) => ({
        stream(request) {
            appendFileSync(logPath, JSON.stringify({
                provider: context.provider,
                purpose: context.purpose,
                model: request.model,
                sessionId: context.sessionId,
                sessionPath: context.sessionPath,
                workspace: context.workspace,
            }) + "\\n");
            return adapter.stream(request);
        },
    }));
}
`;

const FAILING_EXTENSION = `export function activate() {
    throw new Error("boom");
}
`;

async function withPrintHome(
    extensions: (root: string) => Promise<readonly Record<string, unknown>[]>,
    run: (context: {
        readonly workspace: string;
        readonly requests: () => number;
    }) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "vera-print-extensions-"));
    const previousHome = process.env.VERA_HOME;
    let requests = 0;
    const server = Bun.serve({
        port: 0,
        fetch() {
            requests += 1;
            return sseReply("PRINT_EXTENSION_OK");
        },
    });
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    process.env.VERA_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
        schema_version: 1,
        provider: "print-local",
        model: WIRE_MODEL,
        approval_mode: "auto",
        providers: {
            "print-local": {
                protocol: "openai-chat",
                base_url: `http://127.0.0.1:${server.port}/v1`,
                credential: "none",
            },
        },
        extensions: await extensions(root),
    }));
    try {
        await run({ workspace, requests: () => requests });
    } finally {
        server.stop(true);
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
    }
}

loopbackTest(
    "@core print mode runs a config extension on every model call",
    async () => {
        let logPath = "";
        await withPrintHome(
            async (root) => {
                logPath = join(root, "calls.jsonl");
                const path = await writeExtension(
                    root,
                    "recorder",
                    RECORDING_EXTENSION,
                );
                return [{ path, enabled: true, config: { logPath } }];
            },
            async ({ workspace }) => {
                const result = await runHostlessPrint({
                    workspace,
                    prompt: "Say PRINT_EXTENSION_OK.",
                    startupProfile: "prompt_only",
                });

                expect(result.outcome).toBe("completed");
                expect(result.text).toContain("PRINT_EXTENSION_OK");
                const records = (await readFile(logPath, "utf8"))
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line) as Record<string, unknown>);
                expect(records).toHaveLength(2);
                expect(records[0]).toMatchObject({
                    provider: "print-local",
                    purpose: "turn",
                    model: WIRE_MODEL,
                    workspace,
                });
                expect(String(records[0]?.sessionId).length).toBeGreaterThan(0);
                expect(String(records[0]?.sessionPath)).toEndWith(".jsonl");
                // The registry closes before the run returns, so disposers have run.
                expect(records[1]).toEqual({ disposed: true });
            },
        );
    },
    20_000,
);

loopbackTest(
    "print mode skips a config extension that is disabled",
    async () => {
        let logPath = "";
        await withPrintHome(
            async (root) => {
                logPath = join(root, "calls.jsonl");
                const path = await writeExtension(
                    root,
                    "recorder",
                    RECORDING_EXTENSION,
                );
                return [{ path, enabled: false, config: { logPath } }];
            },
            async ({ workspace }) => {
                const result = await runHostlessPrint({
                    workspace,
                    prompt: "Say PRINT_EXTENSION_OK.",
                    startupProfile: "prompt_only",
                });

                expect(result.outcome).toBe("completed");
                expect(existsSync(logPath)).toBe(false);
            },
        );
    },
    20_000,
);

loopbackTest(
    "print mode ends the turn when a config extension fails to activate",
    async () => {
        await withPrintHome(
            async (root) => {
                const path = await writeExtension(
                    root,
                    "failing",
                    FAILING_EXTENSION,
                );
                return [{ path, enabled: true, config: {} }];
            },
            async ({ workspace, requests }) => {
                const result = await runHostlessPrint({
                    workspace,
                    prompt: "Say PRINT_EXTENSION_OK.",
                    startupProfile: "prompt_only",
                });

                expect(result.outcome).toBe("error");
                expect(result.error).toContain(
                    "Extension test.failing failed to activate",
                );
                expect(result.error).toContain("boom");
                expect(requests()).toBe(0);
            },
        );
    },
    20_000,
);

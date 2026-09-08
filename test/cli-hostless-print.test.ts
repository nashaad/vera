import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, runHostlessPrint } from "../clients/cli/main.ts";

const NESTED_ID = "unsloth-local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF";
const WIRE_MODEL = "unsloth/Qwen3.6-35B-A3B-MTP-GGUF";

function sseReply(text: string, model: string): Response {
    const body = [
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
        "",
        "data: [DONE]",
        "",
    ].join("\n");
    return new Response(body, {
        headers: { "content-type": "text/event-stream" },
    });
}

test("hostless --model refuses an unlibraryed reference", async () => {
    const result = await runHostlessPrint({
        workspace: process.cwd(),
        prompt: "Reply with exactly QWEN_CONNECTED and nothing else.",
        model: NESTED_ID,
    });
    expect(result.outcome).toBe("error");
    expect(result.error).toBe(`${NESTED_ID} is not in your model library`);
    expect(result.text).toBe("");
});

test("hostless --model omitted does not invent a provider binding", async () => {
    let output = "";
    let errors = "";
    let seen: Record<string, unknown> | undefined;
    const exit = await runCli(["-p", "hello"], {
        runOnce: async (request) => {
            seen = { ...request };
            return {
                agentId: "run",
                sessionPath: "",
                text: "ok",
                outcome: "completed",
                notes: [],
            };
        },
        stdout: { write: (text) => output += text },
        stderr: { write: (text) => errors += text },
    });
    expect(exit).toBe(0);
    expect(seen).toEqual({
        workspace: process.cwd(),
        prompt: "hello",
    });
    expect(output).toBe("ok\n");
    expect(errors).toBe("");
});

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "hostless --model splits a nested libraryed reference",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-hostless-print-"));
        const previousHome = process.env.VERA_HOME;
        const previousPool = process.env.VERA_POOL_FILE;
        const server = Bun.serve({
            port: 0,
            fetch() {
                return sseReply("QWEN_CONNECTED", WIRE_MODEL);
            },
        });
        process.env.VERA_HOME = root;
        const poolPath = join(root, "pool.json");
        process.env.VERA_POOL_FILE = poolPath;
        await writeFile(join(root, "config.json"), JSON.stringify({
            schema_version: 1,
            provider: "openai-codex",
            model: "gpt-5.6-sol",
            approval_mode: "auto",
            providers: {
                "unsloth-local": {
                    protocol: "openai-chat",
                    base_url: `http://127.0.0.1:${server.port}/v1`,
                    credential: "none",
                },
            },
        }));
        await writeFile(poolPath, JSON.stringify({
            models: {
                [NESTED_ID]: { tools: true, name: "qwen" },
            },
        }));
        await mkdir(join(root, "workspace"), { recursive: true });
        try {
            const byId = await runHostlessPrint({
                workspace: join(root, "workspace"),
                prompt: "Reply with exactly QWEN_CONNECTED and nothing else.",
                model: NESTED_ID,
                startupProfile: "prompt_only",
            });
            expect(byId.outcome).toBe("completed");
            expect(byId.text).toContain("QWEN_CONNECTED");

            const byName = await runHostlessPrint({
                workspace: join(root, "workspace"),
                prompt: "Reply with exactly QWEN_CONNECTED and nothing else.",
                model: "qwen",
                startupProfile: "prompt_only",
            });
            expect(byName.outcome).toBe("completed");
            expect(byName.text).toContain("QWEN_CONNECTED");
        } finally {
            server.stop(true);
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousPool === undefined) delete process.env.VERA_POOL_FILE;
            else process.env.VERA_POOL_FILE = previousPool;
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);

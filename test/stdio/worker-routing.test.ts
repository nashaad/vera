import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, spyOn } from "bun:test";
import { socketAndLoopbackTest } from "../support/socket-probe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { attachAgent } from "../../src/host/attached-client.ts";
import * as forwarding from "../../src/host/pool/forward.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";

socketAndLoopbackTest("stdio attaches to the worker returned by the host", async () => {
    mkdirSync(join(tmpdir(), "vera-dev"), { recursive: true });
    const home = await mkdtemp(join(tmpdir(), "vera-dev", "hs5-stdio-"));
    const stub = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
            return new Response([
                'data: {"id":"x","object":"chat.completion.chunk","model":"stub-model","choices":[{"index":0,"delta":{"role":"assistant","content":"The crow found the map."},"finish_reason":"stop"}]}',
                "", "data: [DONE]", "",
            ].join("\n"), { headers: { "content-type": "text/event-stream" } });
        },
    });
    let host: Awaited<ReturnType<typeof startResidentHost>> | undefined;
    let workerPid: number | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const forwarded = spyOn(forwarding, "forwardSessionConnection");
    try {
        host = await startResidentHost({
            home, processWorker: true, processWorkerCount: 1, skipStartupDiscovery: true,
            config: {
                schema_version: 1, provider: "stub", model: "stub-model", approval_mode: "auto", curated_models_url: "",
                providers: { stub: { protocol: "openai-chat", base_url: `http://127.0.0.1:${stub.port}/v1`, credential: "none" } },
            },
        });
        workerPid = (await requestHostIdentity(`${home}/runtime/w0.sock`))!.pid;
        child = Bun.spawn([process.execPath, "clients/cli/main.ts", "stdio"], {
            cwd: process.cwd(), env: { ...process.env, VERA_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        const input = child.stdin as { write(value: string): unknown; end(): unknown };
        const errors = new Response(child.stderr as ReadableStream<Uint8Array>).text();
        const frames = collect(child.stdout as ReadableStream<Uint8Array>, () => input.end());
        input.write(`${JSON.stringify({ type: "prompt", content: "Find the map." })}\n`);
        const [received, exit, stderr] = await Promise.race([
            Promise.all([frames, child.exited, errors]),
            Bun.sleep(15_000).then((): never => { throw new Error("Stdio did not finish"); }),
        ]);
        expect(exit).toBe(0);
        expect(stderr).toBe("");
        expect(received.some((frame) => frame.type === "turn_finished")).toBe(true);
        expect(forwarded).toHaveBeenCalledTimes(0);
        const id = received.find((frame) => frame.type === "stdio_attached")?.agent_id;
        expect(typeof id).toBe("string");
        const legacy = await attachAgent({ socketPath: host.server.socketPath, agentId: id as string });
        try {
            expect((await legacy.receive()).type).toBe("history");
            expect(forwarded).toHaveBeenCalledTimes(1);
        } finally {
            legacy.close();
        }
    } finally {
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (child !== undefined) {
            await child.exited;
            expect(() => process.kill(child!.pid, 0)).toThrow();
        }
        forwarded.mockRestore();
        const annexPid = host?.annexPid;
        await host?.close();
        stub.stop(true);
        try {
            if (workerPid !== undefined) expect(() => process.kill(workerPid!, 0)).toThrow();
            if (annexPid !== undefined) expect(() => process.kill(annexPid, 0)).toThrow();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    }
}, 30_000);

async function collect(stream: ReadableStream<Uint8Array>, onFinished: () => void): Promise<Record<string, unknown>[]> {
    const frames: Record<string, unknown>[] = [];
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const frame = JSON.parse(line) as Record<string, unknown>;
            frames.push(frame);
            if (frame.type === "turn_finished") onFinished();
        }
    }
    return frames;
}

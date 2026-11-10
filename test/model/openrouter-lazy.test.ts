import { expect, test } from "bun:test";

function runProbe(fail: boolean): { exitCode: number; stdout: string; stderr: string } {
    const script = `
        import { plugin } from "bun";
        let loads = 0;
        plugin({ name: "sdk-probe", setup(build) {
            build.onLoad({ filter: /node_modules\\/@openrouter\\/sdk\\/esm\\/index\\.js$/ }, async (args) => {
                loads++;
                if (${fail}) throw new Error("SDK unavailable");
                return { contents: await Bun.file(args.path).text(), loader: "js" };
            });
        }});
        const { createOpenRouterAdapter } = await import("./src/providers/openrouter.ts");
        const adapter = createOpenRouterAdapter({ apiKey: "stub", fetch: async () => new Response(
            'data: {"id":"stub","created":1,"object":"chat.completion.chunk","model":"crow","choices":[{"index":0,"delta":{"content":"ahoy"},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n',
            { headers: { "content-type": "text/event-stream" } },
        ) });
        const before = loads;
        const controller = new AbortController();
        controller.abort();
        await adapter.stream({ model: "crow", messages: [], signal: controller.signal }).result();
        const aborted = loads;
        const [result, second] = await Promise.all([
            adapter.stream({ model: "crow", messages: [] }).result(),
            adapter.stream({ model: "crow", messages: [] }).result(),
        ]);
        console.log(JSON.stringify({ before, aborted, loads, stopReason: result.stopReason, error: result.errorMessage, second: second.stopReason }));
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: process.cwd() });
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("@core OpenRouter loads the SDK on the first dispatched request", () => {
    const result = runProbe(false);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ before: 0, aborted: 0, loads: 1, stopReason: "stop", second: "stop" });
});

test("an SDK import failure becomes a terminal provider failure", () => {
    const result = runProbe(true);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ before: 0, aborted: 0, loads: 1, stopReason: "error", second: "error", error: "SDK unavailable" });
});

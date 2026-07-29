import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { activate } from "./index.ts";
import { renderD2, type ExecuteD2 } from "./render.ts";

const signal = new AbortController().signal;

test("manifest and entrypoint register a model-visible D2 tool", async () => {
    const manifest = JSON.parse(
        await readFile(new URL("./vera.extension.json", import.meta.url), "utf8"),
    );
    let registered: Record<string, unknown> | undefined;

    activate({
        tools: {
            register(spec) {
                registered = spec as unknown as Record<string, unknown>;
            },
        },
    });

    expect(manifest).toMatchObject({
        entrypoint: "./index.ts",
        capabilities: ["tools.register"],
    });
    expect(registered).toMatchObject({
        name: "render_d2",
        description: "Render D2 source as terminal-friendly text.",
        permissionOperation: "diagram.render",
        inputSchema: {
            required: ["source"],
            additionalProperties: false,
        },
    });
});

test("renderer returns D2 text output without the success diagnostic", async () => {
    const execute: ExecuteD2 = async (_source, characterSet, workspace) => {
        expect(characterSet).toBe("unicode");
        expect(workspace).toBe("/workspace");
        return {
            stdout: "┌──────┐\n│ Vera │\n└──────┘\n",
            stderr: "success: successfully compiled - to -",
            exitCode: 0,
        };
    };

    await expect(
        renderD2("vera", "unicode", "/workspace", signal, execute),
    ).resolves.toEqual({
        output: "┌──────┐\n│ Vera │\n└──────┘",
        isError: false,
    });
});

test("renderer returns D2 syntax errors to the model", async () => {
    const execute: ExecuteD2 = async () => ({
        stdout: "",
        stderr: "err: failed to compile: unexpected token",
        exitCode: 1,
    });

    await expect(
        renderD2("{", "ascii", "/workspace", signal, execute),
    ).resolves.toEqual({
        output: "err: failed to compile: unexpected token",
        isError: true,
    });
});

test("renderer bounds D2 syntax errors", async () => {
    const execute: ExecuteD2 = async () => ({
        stdout: "",
        stderr: "bad syntax\n".repeat(4_000),
        exitCode: 1,
    });

    const result = await renderD2(
        "{",
        "unicode",
        "/workspace",
        signal,
        execute,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toEndWith(
        "… (diagram truncated at 30000 characters)",
    );
});

test("renderer respects cancellation before starting D2", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
        renderD2(
            "a -> b",
            "unicode",
            "/workspace",
            controller.signal,
        ),
    ).rejects.toMatchObject({ name: "AbortError" });
});

test("renderer bounds source and output returned to model context", async () => {
    let calls = 0;
    const execute: ExecuteD2 = async () => {
        calls += 1;
        return { stdout: "x".repeat(31_000), stderr: "", exitCode: 0 };
    };

    const oversizedSource = await renderD2(
        "x".repeat(50_001),
        "unicode",
        "/workspace",
        signal,
        execute,
    );
    expect(oversizedSource).toMatchObject({ isError: true });
    expect(calls).toBe(0);

    const oversizedOutput = await renderD2(
        "a -> b",
        "unicode",
        "/workspace",
        signal,
        execute,
    );
    expect(oversizedOutput.isError).toBe(false);
    expect(oversizedOutput.output).toEndWith(
        "… (diagram truncated at 30000 characters)",
    );
});

test("installed D2 renders Unicode text", async () => {
    if (Bun.which("d2") === null) return;

    const result = await renderD2(
        "user -> vera: prompt\nvera -> model: request",
        "unicode",
        process.cwd(),
        signal,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain("user");
    expect(result.output).toContain("vera");
    expect(result.output).toContain("model");
});

test("successful tool calls publish the rendered diagram for clients", async () => {
    if (Bun.which("d2") === null) return;
    let run: ((request: {
        readonly input: Readonly<Record<string, unknown>>;
        readonly workspace: string;
        readonly signal: AbortSignal;
    }) => Promise<{
        readonly output: string;
        readonly presentation?: {
            readonly kind: "tool_notice";
            readonly text: string;
        };
    }>) | undefined;
    activate({
        tools: {
            register(spec) {
                run = spec.run;
            },
        },
    });
    if (run === undefined) throw new Error("render_d2 was not registered");

    const result = await run({
        input: { source: "a -> b" },
        workspace: process.cwd(),
        signal,
    });

    expect(result.presentation).toEqual({
        kind: "tool_notice",
        text: result.output,
    });
});

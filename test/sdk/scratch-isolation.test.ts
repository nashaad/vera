import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Vera } from "../../src/sdk/agent.ts";
import { SdkRuntime } from "../../src/sdk/tool-call.ts";
import type { VeraConfig } from "../../src/config.ts";
import type { RunAdapterSession } from "../../src/sdk/home-run.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";

const CONFIG: VeraConfig = {
    schema_version: 1,
    provider: "faux",
    model: "reviewer",
    approval_mode: "readonly",
};

const ANSWER: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    source: { provider: "faux", api: "test", model: "reviewer" },
    usage: emptyUsage(),
    stopReason: "stop",
};

test("@core SDK scratch is isolated, lives beside the instance sessions, and closes with it", async () => {
    let firstSessionPath = "";
    let firstSessionId = "";
    let secondSessionPath = "";
    const firstAdapter = new FauxAdapter([ANSWER, ANSWER]);
    const secondAdapter = new FauxAdapter([ANSWER]);
    const firstVera = await Vera.create({
        config: CONFIG,
        createAdapter: (_config, _workspace, context?: RunAdapterSession) => {
            if (context === undefined) throw new Error("Session context is unavailable");
            firstSessionPath = context.sessionPath;
            firstSessionId = context.sessionId;
            return firstAdapter;
        },
    });
    const secondVera = await Vera.create({
        config: CONFIG,
        createAdapter: (_config, _workspace, context?: RunAdapterSession) => {
            if (context === undefined) throw new Error("Session context is unavailable");
            secondSessionPath = context.sessionPath;
            return secondAdapter;
        },
    });

    try {
        await firstVera.agent("default").run("first", { session: "saved" });
        await firstVera.agent("default").run("resume", { session: "saved" });
        await secondVera.agent("default").run("second", { session: "saved" });

        const firstRoot = dirname(dirname(firstSessionPath));
        const secondRoot = dirname(dirname(secondSessionPath));
        const firstScratch = join(
            firstRoot,
            "runtime",
            "scratch",
            firstSessionId,
        );
        const secondScratch = join(
            secondRoot,
            "runtime",
            "scratch",
            firstSessionId,
        );
        expect(firstRoot).not.toBe(secondRoot);
        expect(existsSync(firstScratch)).toBe(true);
        expect(existsSync(secondScratch)).toBe(false);
        expect(dirname(firstSessionPath)).toBe(join(firstRoot, "sessions"));

        await firstVera.close();
        expect(existsSync(firstRoot)).toBe(false);
        expect(existsSync(secondRoot)).toBe(true);
    } finally {
        await firstVera.close();
        await secondVera.close();
    }
});

test("@core closing an SDK instance during scratch setup leaves no runtime behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-sdk-scratch-close-"));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const runtime = new SdkRuntime();
    try {
        const setup = runtime.scratchDir("saved");
        const close = runtime.close();
        const [setupResult, closeResult] = await Promise.allSettled([setup, close]);
        expect(setupResult.status).toBe("rejected");
        expect(closeResult.status).toBe("fulfilled");
        expect(readdirSync(root)).toEqual([]);
    } finally {
        await runtime.close();
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core a failed SDK scratch setup removes the temporary session", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-sdk-scratch-fail-"));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    let sessionPath = "";
    const vera = await Vera.create({
        config: CONFIG,
        createAdapter: (_config, _workspace, context?: RunAdapterSession) => {
            if (context === undefined) throw new Error("Session context is unavailable");
            sessionPath = context.sessionPath;
            return new FauxAdapter([ANSWER]);
        },
    });
    try {
        await vera.agent("default").run("first", { session: "saved" });
        const instanceRoot = dirname(dirname(sessionPath));
        const scratchRoot = join(instanceRoot, "runtime", "scratch");
        const external = join(root, "external");
        mkdirSync(external);
        rmSync(scratchRoot, { recursive: true });
        symlinkSync(external, scratchRoot);
        await expect(vera.agent("default").run("second")).rejects.toThrow(
            "Session scratch must stay inside its home",
        );
        expect(readdirSync(root).sort()).toEqual(["external", basename(instanceRoot)].sort());
    } finally {
        await vera.close();
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(root, { recursive: true, force: true });
    }
});

test("@core Vera.run removes ephemeral session scratch when its instance closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-sdk-scratch-test-"));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
        const result = await Vera.run({
            prompt: "Run once",
            config: CONFIG,
            createAdapter: () => new FauxAdapter([ANSWER]),
        });
        expect(result.outcome).toBe("completed");
        expect(readdirSync(root)).toEqual([]);
    } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(root, { recursive: true, force: true });
    }
});

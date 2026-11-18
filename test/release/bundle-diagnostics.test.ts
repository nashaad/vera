import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildWithDiagnostics, formatBuildFailure } from "../../src/release/build-diagnostics.ts";
import { bundleRelease } from "../../src/release/bundle.ts";

const sourceRoot = resolve(import.meta.dir, "../..");
const packer = join(sourceRoot, "scripts", "pack-release.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function scratchDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-bundle-diagnostics-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function rejectedError(run: () => Promise<unknown>): Promise<Error> {
    let failure: unknown;
    try {
        await run();
    } catch (error) {
        failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    return failure as Error;
}

function missingEntry(directory: string, count = 1): string {
    const path = join(directory, "missing-entry.ts");
    const imports = Array.from({ length: count }, (_, index) =>
        `import "./missing-crow-${index}.ts";`
    );
    writeFileSync(path, `${imports.join("\n")}\n`);
    return path;
}

function runPacker(directory: string, entry: string, target: "browser" | "bun") {
    const preload = join(directory, "preload.ts");
    writeFileSync(preload, [
        "const originalBuild = Bun.build;",
        "Bun.build = (config) => originalBuild({",
        "    ...config,",
        "    entrypoints: config.target === process.env.PACK_TEST_TARGET",
        "        ? [process.env.PACK_TEST_ENTRY] : config.entrypoints,",
        "});",
    ].join("\n"));
    return Bun.spawnSync(
        [process.execPath, "--preload", preload, packer, "--tarball", join(directory, "release.tar.gz")],
        {
            cwd: sourceRoot,
            env: { ...process.env, PACK_TEST_ENTRY: entry, PACK_TEST_TARGET: target },
            stdout: "pipe",
            stderr: "pipe",
        },
    );
}

test("release bundle failure includes the missing module and importer position", async () => {
    const directory = scratchDirectory();
    const entry = missingEntry(directory);
    const failure = await rejectedError(() => bundleRelease(directory, sourceRoot, entry));
    expect(failure.message.split("\n")).toEqual([
        "Bundle failed",
        `${entry}:1:8: Could not resolve: \"./missing-crow-0.ts\"`,
    ]);
    expect(failure.cause).toBeInstanceOf(AggregateError);
});

test("failed build results include Bun's logs", async () => {
    const directory = scratchDirectory();
    const entry = missingEntry(directory);
    const failure = await rejectedError(() => buildWithDiagnostics({
        entrypoints: [entry],
        target: "browser",
        throw: false,
    }, "Web compilation failed"));
    expect(failure.message.split("\n")).toEqual([
        "Web compilation failed",
        `${entry}:1:8: Could not resolve: \"./missing-crow-0.ts\"`,
    ]);
});

test("diagnostics stay on one line and tolerate absent positions", () => {
    const message = formatBuildFailure("Bundle failed", [
        { message: "first\nsecond", position: { file: "entry.ts", line: 3, column: 2 } },
        { message: "no position", position: null },
        "plain diagnostic",
    ]);
    expect(message.split("\n")).toEqual([
        "Bundle failed",
        "entry.ts:3:2: first second",
        "no position",
        "plain diagnostic",
    ]);
});

test("diagnostic limit counts only messages beyond the first twenty", () => {
    const diagnostics = Array.from({ length: 21 }, (_, index) => ({ message: `message ${index + 1}` }));
    const atLimit = formatBuildFailure("Bundle failed", diagnostics.slice(0, 20)).split("\n");
    expect(atLimit).toHaveLength(21);
    expect(atLimit.at(-1)).toBe("message 20");
    const aboveLimit = formatBuildFailure("Bundle failed", diagnostics).split("\n");
    expect(aboveLimit).toHaveLength(22);
    expect(aboveLimit.at(-2)).toBe("message 20");
    expect(aboveLimit.at(-1)).toBe("... and 1 more");
});

test("pack-release reports and limits real web build diagnostics", () => {
    const directory = scratchDirectory();
    const entry = missingEntry(directory, 25);
    const result = runPacker(directory, entry, "browser");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    const lines = result.stderr.toString().trimEnd().split("\n");
    expect(lines).toHaveLength(22);
    expect(lines[0]).toBe("vera pack-release: Bundle failed");
    for (let index = 0; index < 20; index++) {
        expect(lines[index + 1]).toBe(
            `${entry}:${index + 1}:8: Could not resolve: \"./missing-crow-${index}.ts\"`,
        );
    }
    expect(lines[21]).toBe("... and 5 more");
}, 120_000);

test("pack-release reports a missing module in the executable bundle", () => {
    const directory = scratchDirectory();
    const entry = missingEntry(directory);
    const result = runPacker(directory, entry, "bun");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString().trimEnd().split("\n")).toEqual([
        "vera pack-release: Bundle failed",
        `${entry}:1:8: Could not resolve: \"./missing-crow-0.ts\"`,
    ]);
}, 120_000);

test("pack-release keeps ordinary failures on their existing single line", () => {
    const result = Bun.spawnSync([process.execPath, packer, "--not-a-flag"], {
        cwd: sourceRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("vera pack-release: unknown flag: --not-a-flag\n");
});

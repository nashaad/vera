import { createHash } from "node:crypto";
import {
    chmodSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "bun:test";

const checker = resolve(import.meta.dir, "..", "scripts", "check-npm-release.ts");

interface RegistryResponse {
    readonly code?: number;
    readonly value?: unknown;
    readonly stderr?: string;
}

function runChecker(
    mode: "prepare" | "verify",
    version: string,
    responses: Record<string, RegistryResponse>,
    requireProvenance = false,
): ReturnType<typeof Bun.spawnSync> {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-release-test-"));
    const archive = join(root, "package.tgz");
    const fakeNpm = join(root, "npm");
    writeFileSync(archive, "exact package bytes");
    writeFileSync(fakeNpm, `#!/usr/bin/env bun
const responses = JSON.parse(process.env.FAKE_NPM_RESPONSES ?? "{}");
const key = \`${"${Bun.argv[3]}|${Bun.argv[4]}"}\`;
const response = responses[key];
if (!response) {
    console.error("npm error code E404");
    process.exit(1);
}
if (response.stderr) console.error(response.stderr);
if (response.value !== undefined) console.log(JSON.stringify(response.value));
process.exit(response.code ?? 0);
`);
    chmodSync(fakeNpm, 0o755);
    const args = ["bun", checker, mode, archive, version];
    if (requireProvenance) args.push("--require-provenance");
    const result = Bun.spawnSync(args, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
            FAKE_NPM_RESPONSES: JSON.stringify(responses),
        },
    });
    rmSync(root, { recursive: true, force: true });
    return result;
}

function integrity(): string {
    return `sha512-${createHash("sha512")
        .update("exact package bytes")
        .digest("base64")}`;
}

test("new npm version may advance latest", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera|dist-tags.latest": { value: "1.2.2" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString()).toContain("publish=true");
});

test("identical published npm version is an idempotent rerun", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera@1.2.3|dist.integrity": { value: integrity() },
        "@nashaad/vera|dist-tags.latest": { value: "1.2.3" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString()).toContain("publish=false");
});

test("npm release refuses different bytes for an existing version", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera@1.2.3|dist.integrity": { value: "sha512-different" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("registry integrity differs");
});

test("npm release refuses to move latest backward", () => {
    const result = runChecker("prepare", "1.2.3", {
        "@nashaad/vera|dist-tags.latest": { value: "1.2.4" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr?.toString()).toContain("refusing to move npm latest backward");
});

test("npm release verifies bytes, latest, and provenance", () => {
    const result = runChecker("verify", "1.2.3", {
        "@nashaad/vera@1.2.3|dist.integrity": { value: integrity() },
        "@nashaad/vera|dist-tags.latest": { value: "1.2.3" },
        "@nashaad/vera@1.2.3|dist.attestations": {
            value: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
        },
    }, true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString()).toContain('"published":true');
});

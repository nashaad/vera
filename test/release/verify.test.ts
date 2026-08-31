import { expect, test } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    RELEASE_ANNEX_NAME,
    RELEASE_BUN_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
    releaseDirectory,
} from "../../src/release/layout.ts";
import {
    RELEASE_ARTIFACT_NAMES,
    RELEASE_LAYOUT_VERSION,
    VERA_PRODUCT_VERSION,
    serializeReleaseManifest,
} from "../../src/release/manifest.ts";
import { digestPackedAnnex, verifyPackedRelease } from "../../src/release/verify.ts";

function writeAnnex(releaseRoot: string, buildId: string): void {
    const annex = join(releaseRoot, "annex");
    mkdirSync(annex, { recursive: true });
    writeFileSync(join(annex, "index.html"), "<html></html>\n");
    writeFileSync(join(annex, "main.js"), "console.log(1);\n");
    writeFileSync(join(annex, "styles.css"), "body{}\n");
    writeFileSync(join(annex, "build-id"), `${buildId}\n`);
}

function writeWrappers(releaseRoot: string): void {
    for (const name of [
        RELEASE_CLI_NAME,
        RELEASE_HOST_NAME,
        RELEASE_WORKER_NAME,
        RELEASE_ANNEX_NAME,
        RELEASE_SUPERVISOR_NAME,
        RELEASE_BUN_NAME,
    ]) {
        const path = join(releaseRoot, name);
        writeFileSync(path, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
        chmodSync(path, 0o755);
    }
}

function writeRuntime(releaseRoot: string): void {
    for (const entry of [
        "clients",
        "config",
        "extensions",
        "src",
        "node_modules",
    ]) {
        mkdirSync(join(releaseRoot, entry), { recursive: true });
    }
    mkdirSync(join(releaseRoot, "clients", "cli"), { recursive: true });
    mkdirSync(join(releaseRoot, "clients", "host"), { recursive: true });
    mkdirSync(join(releaseRoot, "src", "annex"), { recursive: true });
    writeFileSync(join(releaseRoot, "clients", "cli", "main.ts"), "export {}\n");
    writeFileSync(join(releaseRoot, "clients", "host", "main.ts"), "export {}\n");
    writeFileSync(join(releaseRoot, "src", "annex", "main.ts"), "export {}\n");
    writeFileSync(join(releaseRoot, "index.ts"), "export {}\n");
    writeFileSync(join(releaseRoot, "package.json"), "{}\n");
    writeFileSync(join(releaseRoot, "tsconfig.json"), "{}\n");
    writeFileSync(join(releaseRoot, "bunfig.toml"), "");
}

function writeManifest(releaseRoot: string, buildId: string, digest: string): void {
    writeFileSync(join(releaseRoot, "manifest.json"), serializeReleaseManifest({
        layout_version: RELEASE_LAYOUT_VERSION,
        product_version: VERA_PRODUCT_VERSION,
        source_revision: "abc",
        build_id: buildId,
        protocol_version: 1,
        platform: "darwin",
        arch: "arm64",
        asset_digest: digest,
        built_at: "2026-08-31T00:00:00.000Z",
        artifacts: [...RELEASE_ARTIFACT_NAMES],
    }));
}

function writeCompleteRelease(prefix: string, buildId: string): string {
    const root = releaseDirectory(buildId, prefix);
    mkdirSync(root, { recursive: true });
    writeAnnex(root, buildId);
    writeWrappers(root);
    writeRuntime(root);
    writeManifest(root, buildId, digestPackedAnnex(join(root, "annex")));
    return root;
}

test("verifyPackedRelease accepts a complete release under the prefix", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-verify-ok-"));
    try {
        const root = writeCompleteRelease(prefix, "vera-ok");
        verifyPackedRelease(root, prefix);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("verifyPackedRelease refuses a missing annex asset", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-verify-annex-"));
    try {
        const root = writeCompleteRelease(prefix, "vera-missing");
        rmSync(join(root, "annex", "main.js"));
        expect(() => verifyPackedRelease(root, prefix)).toThrow(/missing annex\/main.js/);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("verifyPackedRelease refuses an annex digest that does not match", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-verify-digest-"));
    try {
        const root = writeCompleteRelease(prefix, "vera-digest");
        writeFileSync(join(root, "annex", "main.js"), "changed\n");
        expect(() => verifyPackedRelease(root, prefix)).toThrow(/annex digest/);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

test("verifyPackedRelease refuses a wrapper that is not executable", () => {
    const prefix = mkdtempSync(join(tmpdir(), "vera-verify-exec-"));
    try {
        const root = writeCompleteRelease(prefix, "vera-exec");
        chmodSync(join(root, RELEASE_HOST_NAME), 0o644);
        expect(() => verifyPackedRelease(root, prefix)).toThrow(/host is not executable/);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
});

import { expect, test } from "bun:test";
import {
    chmodSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CommandResult {
    readonly exitCode: number;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
}

function run(
    command: string[],
    options: Parameters<typeof Bun.spawnSync>[1] = {},
): CommandResult {
    const result = Bun.spawnSync(command, {
        stdout: "pipe",
        stderr: "pipe",
        ...options,
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? new Uint8Array(),
        stderr: result.stderr ?? new Uint8Array(),
    };
}

test("curl installer verifies, installs, and reuses a release archive", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-test-"));
    const payload = join(root, "payload");
    const release = join(root, "release");
    const home = join(root, "home");
    mkdirSync(join(payload, "bin"), { recursive: true });
    mkdirSync(join(release, "latest", "download"), { recursive: true });
    mkdirSync(home, { recursive: true });

    const executable = join(payload, "bin", "vera");
    writeFileSync(executable, "#!/bin/sh\necho fixture-vera\n");
    chmodSync(executable, 0o755);
    writeFileSync(join(payload, "VERSION"), "0.1.0\n");
    writeFileSync(
        join(payload, "manifest.json"),
        '{"version":"0.1.0","platform":"darwin","architecture":"arm64"}\n',
    );

    const archive = "vera-darwin-arm64.tar.gz";
    const archivePath = join(release, "latest", "download", archive);
    const tar = run(["tar", "-czf", archivePath, "-C", payload, "."]);
    expect(tar.exitCode).toBe(0);
    const digest = createHash("sha256")
        .update(readFileSync(archivePath))
        .digest("hex");
    writeFileSync(`${archivePath}.sha256`, `${digest}  ${archive}\n`);

    try {
        const installRoot = join(home, ".local", "share", "vera");
        const binDir = join(home, ".local", "bin");
        const config = join(home, ".vera", "profiles", "default", "config.json");
        mkdirSync(join(home, ".vera", "profiles", "default"), { recursive: true });
        writeFileSync(config, '{"schema_version":1,"provider":"test"}\n');

        const first = run(["sh", join(import.meta.dir, "..", "install")], {
            env: {
                ...process.env,
                HOME: home,
                PATH: process.env.PATH ?? "",
                VERA_INSTALL_BASE_URL: `file://${release}`,
                VERA_INSTALL_ALLOW_FILE: "1",
                VERA_INSTALL_PLATFORM: "darwin",
                VERA_INSTALL_ARCH: "arm64",
                VERA_INSTALL_ROOT: installRoot,
                VERA_INSTALL_BIN_DIR: binDir,
            },
        });
        expect(first.exitCode).toBe(0);
        expect(readFileSync(config, "utf8")).toBe(
            '{"schema_version":1,"provider":"test"}\n',
        );

        const installed = join(installRoot, "versions", "0.1.0", "bin", "vera");
        expect(readFileSync(installed, "utf8")).toContain("fixture-vera");
        expect(run([join(binDir, "vera")]).stdout.toString()).toBe("fixture-vera\n");
        expect(readFileSync(join(installRoot, "current", "VERSION"), "utf8")).toBe(
            "0.1.0\n",
        );

        const second = run(["sh", join(import.meta.dir, "..", "install")], {
            env: {
                ...process.env,
                HOME: home,
                PATH: process.env.PATH ?? "",
                VERA_INSTALL_BASE_URL: `file://${release}`,
                VERA_INSTALL_ALLOW_FILE: "1",
                VERA_INSTALL_PLATFORM: "darwin",
                VERA_INSTALL_ARCH: "arm64",
                VERA_INSTALL_ROOT: installRoot,
                VERA_INSTALL_BIN_DIR: binDir,
            },
        });
        expect(second.exitCode).toBe(0);
        expect(second.stdout.toString()).toContain("Installed Vera 0.1.0");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("curl installer refuses to replace an executable owned by another install", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-owner-test-"));
    const payload = join(root, "payload");
    const release = join(root, "release");
    const home = join(root, "home");
    mkdirSync(join(payload, "bin"), { recursive: true });
    mkdirSync(join(release, "latest", "download"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(payload, "bin", "vera"), "#!/bin/sh\n");
    chmodSync(join(payload, "bin", "vera"), 0o755);
    writeFileSync(join(payload, "VERSION"), "0.1.0\n");
    writeFileSync(
        join(payload, "manifest.json"),
        '{"version":"0.1.0","platform":"darwin","architecture":"arm64"}\n',
    );

    const archivePath = join(release, "latest", "download", "vera-darwin-arm64.tar.gz");
    expect(run(["tar", "-czf", archivePath, "-C", payload, "."]).exitCode).toBe(0);
    const digest = createHash("sha256")
        .update(readFileSync(archivePath))
        .digest("hex");
    writeFileSync(`${archivePath}.sha256`, `${digest}\n`);
    writeFileSync(join(home, ".local", "bin", "vera"), "another-owner\n");

    try {
        const result = run(["sh", join(import.meta.dir, "..", "install")], {
            env: {
                ...process.env,
                HOME: home,
                PATH: process.env.PATH ?? "",
                VERA_INSTALL_BASE_URL: `file://${release}`,
                VERA_INSTALL_ALLOW_FILE: "1",
                VERA_INSTALL_PLATFORM: "darwin",
                VERA_INSTALL_ARCH: "arm64",
                VERA_INSTALL_ROOT: join(home, ".local", "share", "vera"),
                VERA_INSTALL_BIN_DIR: join(home, ".local", "bin"),
            },
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain("refusing to replace existing executable");
        expect(readFileSync(join(home, ".local", "bin", "vera"), "utf8")).toBe(
            "another-owner\n",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

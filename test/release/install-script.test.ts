import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "..", "..", "scripts", "install.sh");

function fakeTarball(root: string, buildId: string): string {
    const stage = join(root, `stage-${buildId}`);
    const release = join(stage, buildId);
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "manifest.json"), `{"build_id":"${buildId}"}\n`);
    writeFileSync(join(release, "vera"), `#!/bin/sh\necho ${buildId}\n`);
    chmodSync(join(release, "vera"), 0o755);
    const tarball = join(root, `${buildId}.tar.gz`);
    const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", stage, buildId]);
    expect(tar.exitCode).toBe(0);
    return tarball;
}

function install(prefix: string, tarball: string) {
    return Bun.spawnSync(["sh", installer, tarball], {
        env: { ...process.env, VERA_INSTALL_PREFIX: prefix, PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
    });
}

test("install.sh activates a release tarball and keeps the previous one as rollback", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-sh-"));
    try {
        const prefix = join(root, "prefix");
        const share = join(prefix, "share", "vera");
        const first = install(prefix, fakeTarball(root, "vera-aaaa"));
        expect(first.stderr.toString()).toBe("");
        expect(first.exitCode).toBe(0);
        expect(first.stdout.toString()).toContain("is not on PATH");
        expect(readlinkSync(join(share, "current"))).toBe("releases/vera-aaaa");
        expect(existsSync(join(share, "rollback"))).toBe(false);
        const launcher = join(prefix, "bin", "vera");
        expect(Bun.spawnSync([launcher]).stdout.toString()).toBe("vera-aaaa\n");

        expect(install(prefix, fakeTarball(root, "vera-bbbb")).exitCode).toBe(0);
        expect(readlinkSync(join(share, "current"))).toBe("releases/vera-bbbb");
        expect(readlinkSync(join(share, "rollback"))).toBe("releases/vera-aaaa");
        expect(Bun.spawnSync([launcher]).stdout.toString()).toBe("vera-bbbb\n");

        const again = install(prefix, fakeTarball(root, "vera-bbbb"));
        expect(again.exitCode).toBe(0);
        expect(again.stdout.toString()).toContain("already installed");
        expect(readlinkSync(join(share, "rollback"))).toBe("releases/vera-aaaa");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh refuses a tarball whose checksum file does not match", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-sh-"));
    try {
        const prefix = join(root, "prefix");
        const tarball = fakeTarball(root, "vera-cccc");
        writeFileSync(`${tarball}.sha256`, `${"0".repeat(64)}  vera-cccc.tar.gz\n`);
        const ran = install(prefix, tarball);
        expect(ran.exitCode).toBe(1);
        expect(ran.stderr.toString()).toContain("checksum mismatch");
        expect(existsSync(join(prefix, "share", "vera", "current"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh refuses a tarball without a release manifest and leaves no partial release", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-sh-"));
    try {
        const stage = join(root, "stage", "vera-dddd");
        mkdirSync(stage, { recursive: true });
        writeFileSync(join(stage, "vera"), "#!/bin/sh\n");
        const tarball = join(root, "bad.tar.gz");
        Bun.spawnSync(["tar", "-czf", tarball, "-C", join(root, "stage"), "vera-dddd"]);
        const prefix = join(root, "prefix");
        const ran = install(prefix, tarball);
        expect(ran.exitCode).toBe(1);
        expect(ran.stderr.toString()).toContain("no release manifest");
        const releases = join(prefix, "share", "vera", "releases");
        expect(Bun.spawnSync(["ls", "-A", releases]).stdout.toString()).toBe("");
        expect(readFileSync(installer, "utf8")).toContain("releases/latest/download");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

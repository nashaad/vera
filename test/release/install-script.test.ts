import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copySleep } from "../support/copied-sleep.ts";

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

function install(prefix: string, tarball: string, path = "/usr/bin:/bin:/usr/sbin") {
    return Bun.spawnSync(["sh", installer, tarball], {
        env: { ...process.env, HOME: prefix, VERA_HOME: join(prefix, "home"), VERA_INSTALL_PREFIX: prefix, PATH: path },
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

test("install.sh collects old releases but retains links, newest and running releases", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-gc-"));
    try {
        const prefix = join(root, "prefix");
        const share = join(prefix, "share", "vera");
        const releases = join(share, "releases");
        mkdirSync(releases, { recursive: true });
        for (const [index, name] of ["current", "running", "drop", "new1", "new2", "new3"].entries()) {
            const release = join(releases, `vera-${name}`);
            mkdirSync(release);
            utimesSync(release, index + 1, index + 1);
        }
        symlinkSync("releases/vera-current", join(share, "current"));
        const shims = join(root, "bin");
        mkdirSync(shims);
        writeFileSync(join(shims, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
        writeFileSync(join(shims, "lsof"), `#!/bin/sh\necho 'n${releases}/vera-running/vera-bin'\n`, { mode: 0o755 });
        const result = install(prefix, fakeTarball(root, "vera-installed"), `${shims}:/usr/bin:/bin`);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("Removed 2 old releases");
        expect(existsSync(join(releases, "vera-drop"))).toBe(false);
        expect(existsSync(join(releases, "vera-new1"))).toBe(false);
        for (const name of ["current", "running", "new2", "new3", "installed"]) {
            expect(existsSync(join(releases, `vera-${name}`))).toBe(true);
        }
        expect(readlinkSync(join(share, "rollback"))).toBe("releases/vera-current");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh restores a release when the second process scan fails", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-gc-fail-"));
    try {
        const prefix = join(root, "prefix");
        const releases = join(prefix, "share", "vera", "releases");
        mkdirSync(releases, { recursive: true });
        for (const [index, name] of ["old", "one", "two"].entries()) {
            const release = join(releases, `vera-${name}`);
            mkdirSync(release);
            utimesSync(release, index + 1, index + 1);
        }
        const shims = join(root, "bin");
        mkdirSync(shims);
        writeFileSync(join(shims, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
        writeFileSync(join(shims, "lsof"), `#!/bin/sh\n[ ! -f '${root}/called' ] || exit 1\ntouch '${root}/called'\n`, { mode: 0o755 });
        const result = install(prefix, fakeTarball(root, "vera-installed"), `${shims}:/usr/bin:/bin`);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("Removed 0 old releases");
        expect(existsSync(join(releases, "vera-old"))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh keeps a real running executable through a symlinked prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-gc-real-"));
    const physical = join(root, "physical");
    const prefix = join(root, "link");
    mkdirSync(physical);
    symlinkSync(physical, prefix);
    const releases = join(prefix, "share", "vera", "releases");
    const running = join(releases, "vera-running");
    mkdirSync(running, { recursive: true });
    const executable = join(running, "vera-bin");
    copySleep(executable);
    const child = Bun.spawn([executable, "60"], { stdout: "ignore", stderr: "ignore" });
    try {
        const drop = join(releases, "vera-drop");
        mkdirSync(drop);
        for (const name of ["one", "two", "three"]) mkdirSync(join(releases, `vera-${name}`));
        utimesSync(running, 1, 1);
        utimesSync(drop, 2, 2);
        await Bun.sleep(100);
        expect(child.exitCode).toBeNull();
        const result = install(prefix, fakeTarball(root, "vera-installed"));
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(existsSync(running)).toBe(true);
        expect(existsSync(drop)).toBe(false);
    } finally {
        child.kill();
        await child.exited;
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

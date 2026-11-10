import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

function installDownload(prefix: string, path: string, extra: Record<string, string> = {}) {
    return Bun.spawnSync(["sh", installer], {
        env: {
            ...process.env,
            HOME: prefix,
            VERA_HOME: join(prefix, "home"),
            VERA_INSTALL_PREFIX: prefix,
            VERA_VERSION: "",
            VERA_RELEASES_API: "",
            VERA_REPO: "",
            PATH: path,
            ...extra,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
}

function downloadShims(root: string, api: string, apiFile: string, tarball: string, log: string): string {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "uname"), "#!/bin/sh\ncase \"$1\" in\n  -m) echo arm64 ;;\n  *) echo Darwin ;;\nesac\n", { mode: 0o755 });
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const sha = `${tarball}.sha256`;
    writeFileSync(sha, `${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  vera-darwin-arm64.tar.gz\n`);
    writeFileSync(
        join(bin, "curl"),
        `#!/bin/sh
out=
url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --retry) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >> '${log}'
case "$url" in
  '${api}') cp '${apiFile}' "$out" ;;
  https://github.com/*/releases/download/*)
    case "$url" in
      *.sha256) cp '${sha}' "$out" ;;
      *) cp '${tarball}' "$out" ;;
    esac
    ;;
  *) exit 22 ;;
esac
`,
        { mode: 0o755 },
    );
    return bin;
}

function apiFixture(root: string, tag: string, prerelease = false): string {
    const file = join(root, "releases.json");
    writeFileSync(file, `[\n  {\n    "tag_name": "${tag}",\n    "prerelease": ${prerelease}\n  }\n]\n`);
    return file;
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
        expect(readFileSync(installer, "utf8")).toContain("releases?per_page=1");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh resolves the newest release from the API and downloads its explicit version", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-api-"));
    try {
        const prefix = join(root, "prefix");
        const tarball = fakeTarball(root, "vera-eeee");
        const api = "https://api.test/releases?per_page=1";
        const log = join(root, "curl.log");
        const bin = downloadShims(root, api, apiFixture(root, "v9.9.9"), tarball, log);
        const result = installDownload(prefix, `${bin}:/usr/bin:/bin`, { VERA_RELEASES_API: api });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const urls = readFileSync(log, "utf8");
        expect(urls).toContain("https://github.com/nashaad/vera/releases/download/v9.9.9/vera-darwin-arm64.tar.gz");
        expect(urls).toContain("https://github.com/nashaad/vera/releases/download/v9.9.9/vera-darwin-arm64.tar.gz.sha256");
        expect(readlinkSync(join(prefix, "share", "vera", "current"))).toBe("releases/vera-eeee");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh selects a pre-release when it is the newest release", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-api-pre-"));
    try {
        const prefix = join(root, "prefix");
        const tarball = fakeTarball(root, "vera-ffff");
        const api = "https://api.test/releases?per_page=1";
        const log = join(root, "curl.log");
        const bin = downloadShims(root, api, apiFixture(root, "v1.2.3-beta.1", true), tarball, log);
        const result = installDownload(prefix, `${bin}:/usr/bin:/bin`, { VERA_RELEASES_API: api });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(readFileSync(log, "utf8")).toContain(
            "https://github.com/nashaad/vera/releases/download/v1.2.3-beta.1/vera-darwin-arm64.tar.gz",
        );
        expect(readlinkSync(join(prefix, "share", "vera", "current"))).toBe("releases/vera-ffff");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh fails with one message when the release API is unreachable", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-api-down-"));
    try {
        const prefix = join(root, "prefix");
        const tarball = fakeTarball(root, "vera-gggg");
        const api = "https://api.test/releases?per_page=1";
        const unreachable = "https://api.test/unreachable";
        const log = join(root, "curl.log");
        const bin = downloadShims(root, api, apiFixture(root, "v9.9.9"), tarball, log);
        const result = installDownload(prefix, `${bin}:/usr/bin:/bin`, { VERA_RELEASES_API: unreachable });
        expect(result.exitCode).toBe(1);
        const stderr = result.stderr.toString().trim();
        expect(stderr).toContain("set VERA_VERSION");
        expect(stderr.split("\n")).toHaveLength(1);
        expect(readFileSync(log, "utf8")).toContain(unreachable);
        expect(readFileSync(log, "utf8")).not.toContain("github.com");
        expect(existsSync(join(prefix, "share", "vera", "current"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh fails when the release API has no usable tag_name", () => {
    const bodies = [
        "[]\n",
        `[{"tag_name": 123}]\n`,
        `[{"tag_name": null}]\n`,
        `[{"tag_name": ["v1.2.3"]}]\n`,
        `[{"tag_name": ""}]\n`,
        `[{"tag_name": "v1.2.3 beta"}]\n`,
        `[{"tag_name": "v1.2.3/evil"}]\n`,
        `[{"tag_name": "v1.2.3\n`,
    ];
    for (const [index, body] of bodies.entries()) {
        const root = mkdtempSync(join(tmpdir(), `vera-install-api-bad-${index}-`));
        try {
            const prefix = join(root, "prefix");
            const tarball = fakeTarball(root, "vera-iiii");
            const api = "https://api.test/releases?per_page=1";
            const apiFile = join(root, "releases.json");
            writeFileSync(apiFile, body);
            const log = join(root, "curl.log");
            const bin = downloadShims(root, api, apiFile, tarball, log);
            const result = installDownload(prefix, `${bin}:/usr/bin:/bin`, { VERA_RELEASES_API: api });
            expect(result.exitCode, result.stderr.toString()).toBe(1);
            expect(result.stderr.toString()).toContain("set VERA_VERSION");
            expect(readFileSync(log, "utf8")).not.toContain("github.com");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
});

test("install.sh uses VERA_REPO in the default API and asset URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-repo-"));
    try {
        const prefix = join(root, "prefix");
        const tarball = fakeTarball(root, "vera-jjjj");
        const api = "https://api.github.com/repos/acme/vera/releases?per_page=1";
        const log = join(root, "curl.log");
        const bin = downloadShims(root, api, apiFixture(root, "v2.0.0"), tarball, log);
        const result = installDownload(prefix, `${bin}:/usr/bin:/bin`, { VERA_REPO: "acme/vera" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const urls = readFileSync(log, "utf8");
        expect(urls).toContain(api);
        expect(urls).toContain("https://github.com/acme/vera/releases/download/v2.0.0/vera-darwin-arm64.tar.gz");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("install.sh uses VERA_VERSION without asking the release API", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-install-version-"));
    try {
        const prefix = join(root, "prefix");
        const tarball = fakeTarball(root, "vera-hhhh");
        const api = "https://api.test/releases?per_page=1";
        const log = join(root, "curl.log");
        const bin = downloadShims(root, api, apiFixture(root, "v9.9.9"), tarball, log);
        const result = installDownload(prefix, `${bin}:/usr/bin:/bin`, {
            VERA_RELEASES_API: api,
            VERA_VERSION: "1.2.3",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const urls = readFileSync(log, "utf8");
        expect(urls).not.toContain(api);
        expect(urls).toContain("https://github.com/nashaad/vera/releases/download/v1.2.3/vera-darwin-arm64.tar.gz");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

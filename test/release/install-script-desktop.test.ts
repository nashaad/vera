import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "..", "..", "scripts", "install.sh");

// Each case builds its own release feed and runs the installer.
const LOOP_TIMEOUT_MS = 60_000;

const BUILD_ID = "vera-hostbuild1";
const DESKTOP_VERSION = "1.2.3";
const PLIST = (bundleId: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>
`;

// Stands in for plutil where the system has none, for the two calls install.sh makes.
const PLUTIL_SHIM = `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args.at(-1);
const key = args[0] === "-type" ? args[1] : args[1];
let object;
try {
    const text = readFileSync(file, "utf8");
    if (text.trimStart().startsWith("<")) {
        object = {};
        for (const m of text.matchAll(/<key>([^<]*)<\\/key>\\s*<string>([^<]*)<\\/string>/g)) object[m[1]] = m[2];
    } else {
        object = JSON.parse(text);
    }
} catch {
    process.exit(1);
}
const value = object[key];
if (value === undefined || value === null) process.exit(1);
if (args[0] === "-type") {
    const kind = typeof value === "number" ? (Number.isInteger(value) ? "integer" : "float")
        : typeof value === "string" ? "string" : typeof value === "boolean" ? "bool"
        : Array.isArray(value) ? "array" : "dictionary";
    console.log(kind);
} else {
    console.log(String(value));
}
`;

interface FeedOptions {
    os?: "darwin" | "linux";
    arch?: "arm64" | "x64";
    manifest?: Record<string, unknown>;
    entryFile?: boolean;
    packageChecksum?: string;
    shellChecksum?: string;
    omit?: readonly string[];
}

interface RunOptions {
    desktop?: string;
    // File content for the terminal seam; undefined leaves the path missing.
    tty?: string;
    applications?: "writable" | "missing" | "symlink";
    customPrefix?: boolean;
    api?: boolean;
    downloadBase?: boolean;
    localTarball?: boolean;
    noOpen?: boolean;
    lsof?: string;
    lsofFails?: boolean;
    failPlacement?: boolean;
}

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pack(stage: string, archive: string, members: readonly string[]): void {
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, ...members]);
    expect(tar.exitCode, tar.stderr.toString()).toBe(0);
}

function writeShell(dir: string, note: string, options: { bundleId?: string; marker?: boolean } = {}): void {
    mkdirSync(join(dir, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(dir, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(dir, "Contents", "Info.plist"), PLIST(options.bundleId ?? "dev.vera.desktop"));
    if (options.marker !== false) {
        writeFileSync(join(dir, "Contents", "Resources", "vera-shell.json"), '{"shell_api": 1}\n');
    }
    writeFileSync(join(dir, "Contents", "Resources", "note.txt"), note);
}

class Scenario {
    readonly root = mkdtempSync(join(tmpdir(), "vera-install-desktop-"));
    readonly home = join(this.root, "home");
    readonly prefix = join(this.home, ".local");
    readonly customPrefix = join(this.root, "custom-prefix");
    readonly applications = join(this.root, "Applications");
    readonly feed = join(this.root, "feed");
    readonly bin = join(this.root, "bin");
    readonly curlLog = join(this.root, "curl.log");
    readonly openLog = join(this.root, "open.log");
    readonly xattrLog = join(this.root, "xattr.log");
    readonly ttyFile = join(this.root, "tty");
    readonly share = join(this.prefix, "share", "vera");
    readonly arch: "arm64" | "x64";
    readonly os: "darwin" | "linux";
    readonly hostTarball: string;

    constructor(private readonly feedOptions: FeedOptions = {}) {
        this.arch = feedOptions.arch ?? "arm64";
        this.os = feedOptions.os ?? "darwin";
        mkdirSync(this.feed, { recursive: true });
        mkdirSync(this.home, { recursive: true });
        mkdirSync(this.applications, { recursive: true });
        mkdirSync(this.bin, { recursive: true });
        writeFileSync(this.curlLog, "");
        writeFileSync(this.openLog, "");
        writeFileSync(this.xattrLog, "");
        writeFileSync(join(this.feed, "releases.json"), '[{"tag_name": "v9.9.9"}]\n');
        this.hostTarball = this.buildHost();
        this.buildPackage();
        this.buildShell();
        this.writeShims();
    }

    dispose(): void {
        rmSync(this.root, { recursive: true, force: true });
    }

    private publish(name: string, source: string, checksum?: string): void {
        if (this.feedOptions.omit?.includes(name)) return;
        Bun.spawnSync(["cp", source, join(this.feed, name)]);
        writeFileSync(join(this.feed, `${name}.sha256`), `${checksum ?? sha256(source)}  ${name}\n`);
    }

    private buildHost(): string {
        const stage = join(this.root, "stage-host");
        const release = join(stage, BUILD_ID);
        mkdirSync(release, { recursive: true });
        writeFileSync(join(release, "manifest.json"), `{"build_id":"${BUILD_ID}"}\n`);
        writeFileSync(join(release, "vera"), `#!/bin/sh\necho ${BUILD_ID}\n`);
        chmodSync(join(release, "vera"), 0o755);
        const archive = join(this.root, "host.tar.gz");
        pack(stage, archive, [BUILD_ID]);
        this.publish(`vera-${this.os}-${this.arch}.tar.gz`, archive);
        return archive;
    }

    private buildPackage(): void {
        const stage = join(this.root, "stage-package");
        mkdirSync(join(stage, "app"), { recursive: true });
        const manifest = {
            layout_version: 1,
            desktop_version: DESKTOP_VERSION,
            host_build_id: BUILD_ID,
            entry: "app/main.js",
            ...this.feedOptions.manifest,
        };
        writeFileSync(join(stage, "desktop-package.json"), `${JSON.stringify(manifest)}\n`);
        if (this.feedOptions.entryFile !== false) writeFileSync(join(stage, "app", "main.js"), "// entry\n");
        const archive = join(this.root, "package.tar.gz");
        pack(stage, archive, ["."]);
        this.publish(`vera-desktop-darwin-${this.arch}.tar.gz`, archive, this.feedOptions.packageChecksum);
    }

    private buildShell(): void {
        const stage = join(this.root, "stage-shell");
        writeShell(join(stage, "Vera.app"), "new shell\n");
        const archive = join(this.root, "shell.tar.gz");
        pack(stage, archive, ["Vera.app"]);
        this.publish(`vera-desktop-shell-darwin-${this.arch}.tar.gz`, archive, this.feedOptions.shellChecksum);
    }

    private writeShims(): void {
        const machine = this.arch === "arm64" ? "arm64" : "x86_64";
        const system = this.os === "darwin" ? "Darwin" : "Linux";
        const shim = (name: string, body: string): void => {
            writeFileSync(join(this.bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        };
        shim("uname", `case "$1" in -m) echo ${machine} ;; *) echo ${system} ;; esac`);
        shim("xattr", `printf '%s\\n' "$*" >> '${this.xattrLog}'`);
        shim("open", `printf '%s\\n' "$*" >> '${this.openLog}'`);
        shim(
            "curl",
            `out=
url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --retry) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >> '${this.curlLog}'
case "$url" in
  https://api.test/releases) cp '${this.feed}/releases.json' "$out"; exit 0 ;;
esac
name=\${url##*/}
[ -f '${this.feed}'/"$name" ] || exit 22
cp '${this.feed}'/"$name" "$out"`,
        );
        if (!existsSync("/usr/bin/plutil")) {
            const script = join(this.bin, "plutil.js");
            writeFileSync(script, PLUTIL_SHIM);
            shim("plutil", `exec '${process.execPath}' '${script}' "$@"`);
        }
    }

    appPath(system = true): string {
        return join(system ? this.applications : join(this.home, "Applications"), "Vera.app");
    }

    private applicationsFor(kind: RunOptions["applications"]): string {
        if (kind === "missing") return join(this.root, "NoApplications");
        if (kind === "symlink") {
            const link = join(this.root, "ApplicationsLink");
            if (!existsSync(link)) symlinkSync(this.applications, link);
            return link;
        }
        return this.applications;
    }

    run(options: RunOptions = {}) {
        if (options.tty !== undefined) writeFileSync(this.ttyFile, options.tty);
        if (options.lsofFails) {
            writeFileSync(join(this.bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        } else {
            writeFileSync(join(this.bin, "lsof"), `#!/bin/sh\nprintf 'n%s\\n' ${shellWords(options.lsof ?? "")}\n`, { mode: 0o755 });
        }
        if (options.failPlacement) {
            writeFileSync(
                join(this.bin, "mv"),
                `#!/bin/sh\ncase "$1" in */.Vera.app.new-*) exit 1 ;; esac\nexec /bin/mv "$@"\n`,
                { mode: 0o755 },
            );
        }
        const env: Record<string, string> = {
            HOME: this.home,
            SHELL: "/bin/sh",
            PATH: `${this.bin}:/usr/bin:/bin:/usr/sbin`,
            VERA_INSTALL_TTY: this.ttyFile,
            VERA_INSTALL_APPLICATIONS: this.applicationsFor(options.applications),
        };
        if (options.customPrefix) env.VERA_INSTALL_PREFIX = this.customPrefix;
        if (options.desktop !== undefined) env.VERA_DESKTOP = options.desktop;
        if (options.noOpen) env.VERA_INSTALL_NO_OPEN = "1";
        if (options.api) env.VERA_RELEASES_API = "https://api.test/releases";
        else env.VERA_VERSION = "v9.9.9".slice(1);
        if (options.downloadBase !== false) env.VERA_RELEASES_DOWNLOAD_BASE = "https://feed.test";
        const argv = options.localTarball ? ["sh", installer, this.hostTarball] : ["sh", installer];
        return Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    }

    urls(): string[] {
        return readFileSync(this.curlLog, "utf8").split("\n").filter((line) => line.length > 0);
    }

    opened(): string[] {
        return readFileSync(this.openLog, "utf8").split("\n").filter((line) => line.length > 0);
    }

    probeUrl(): string {
        return `https://feed.test/v9.9.9/vera-desktop-darwin-${this.arch}.tar.gz.sha256`;
    }

    desktopUrls(): string[] {
        return this.urls().filter((url) => url.includes("vera-desktop"));
    }

    packageDirectory(): string {
        return join(this.share, "desktop", BUILD_ID, DESKTOP_VERSION);
    }

    record(): unknown {
        return JSON.parse(readFileSync(join(this.share, "desktop", "installed.json"), "utf8"));
    }

    hasCli(): boolean {
        return readlinkSync(join(this.share, "current")) === `releases/${BUILD_ID}`;
    }
}

function shellWords(value: string): string {
    return value.length === 0 ? "''" : `'${value.replaceAll("'", "'\\''")}'`;
}

async function withScenario(
    feed: FeedOptions,
    body: (scenario: Scenario) => void,
): Promise<void> {
    const scenario = new Scenario(feed);
    try {
        body(scenario);
    } finally {
        scenario.dispose();
    }
}

function assertNothingDesktop(scenario: Scenario, apps = scenario.applications): void {
    expect(existsSync(join(scenario.share, "desktop"))).toBe(false);
    expect(readdirSync(apps)).toEqual([]);
    expect(scenario.opened()).toEqual([]);
}

test("install.sh installs the desktop app from the same release when VERA_DESKTOP=yes", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ desktop: "yes", api: true });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(scenario.hasCli()).toBe(true);
        expect(scenario.urls()).toEqual([
            "https://api.test/releases",
            "https://feed.test/v9.9.9/vera-darwin-arm64.tar.gz",
            "https://feed.test/v9.9.9/vera-darwin-arm64.tar.gz.sha256",
            "https://feed.test/v9.9.9/vera-desktop-darwin-arm64.tar.gz.sha256",
            "https://feed.test/v9.9.9/vera-desktop-darwin-arm64.tar.gz",
            "https://feed.test/v9.9.9/vera-desktop-shell-darwin-arm64.tar.gz",
            "https://feed.test/v9.9.9/vera-desktop-shell-darwin-arm64.tar.gz.sha256",
        ]);
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        const packageDirectory = scenario.packageDirectory();
        expect(readFileSync(join(packageDirectory, "app", "main.js"), "utf8")).toBe("// entry\n");
        expect(readdirSync(join(scenario.share, "desktop", BUILD_ID))).toEqual([DESKTOP_VERSION]);
        expect(readFileSync(join(scenario.appPath(), "Contents", "Resources", "note.txt"), "utf8")).toBe("new shell\n");
        expect(readdirSync(scenario.applications)).toEqual(["Vera.app"]);
        expect(scenario.record()).toEqual({ layout_version: 1, app_path: scenario.appPath() });
        expect(scenario.opened()).toEqual([scenario.appPath()]);
        expect(result.stdout.toString()).toContain(`Installed the Vera desktop app ${DESKTOP_VERSION}`);
        expect(result.stdout.toString()).toEndWith(`Open a new terminal window, or run: . '${scenario.home}/.profile'\n`);
        const cleared = readFileSync(scenario.xattrLog, "utf8");
        expect(cleared).toContain("-dr com.apple.quarantine");
        expect(cleared).toContain("/desktop/shell/Vera.app");
        expect(cleared).toContain(`/share/vera/desktop/${BUILD_ID}/.tmp-`);
    });
});

test("install.sh downloads the desktop files from the GitHub release when no feed base is set", async () => {
    await withScenario({ arch: "x64" }, (scenario) => {
        const result = scenario.run({ desktop: "yes", downloadBase: false });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const base = "https://github.com/nashaad/vera/releases/download/v9.9.9";
        expect(scenario.desktopUrls()).toEqual([
            `${base}/vera-desktop-darwin-x64.tar.gz.sha256`,
            `${base}/vera-desktop-darwin-x64.tar.gz`,
            `${base}/vera-desktop-shell-darwin-x64.tar.gz`,
            `${base}/vera-desktop-shell-darwin-x64.tar.gz.sha256`,
        ]);
        expect(existsSync(scenario.appPath())).toBe(true);
    });
});

test("install.sh asks, and Enter installs the desktop app", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ tty: "\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("Also install the Vera desktop app? [Y/n] ");
        expect(existsSync(scenario.appPath())).toBe(true);
        expect(scenario.opened()).toEqual([scenario.appPath()]);
    });
});

test("install.sh installs the desktop app on y and on yes, in any case", async () => {
    for (const answer of ["y\n", "Y\n", "yes\n", "YES\n"]) {
        await withScenario({}, (scenario) => {
            const result = scenario.run({ tty: answer });
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            expect(existsSync(scenario.appPath())).toBe(true);
        });
    }
}, LOOP_TIMEOUT_MS);

test("install.sh leaves the desktop app out on n and says nothing more", async () => {
    for (const answer of ["n\n", "N\n", "no\n"]) {
        await withScenario({}, (scenario) => {
            const result = scenario.run({ tty: answer });
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            expect(scenario.hasCli()).toBe(true);
            expect(result.stdout.toString()).toContain("Also install the Vera desktop app? [Y/n] ");
            expect(result.stdout.toString()).not.toContain("VERA_DESKTOP=yes");
            expect(scenario.desktopUrls()).toEqual([scenario.probeUrl()]);
            assertNothingDesktop(scenario);
        });
    }
}, LOOP_TIMEOUT_MS);

test("install.sh asks again after an answer it does not understand", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ tty: "maybe\nn\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("Please answer y or n.");
        assertNothingDesktop(scenario);
    });
});

test("install.sh skips the desktop app with one line when there is no usable terminal", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run();
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain(
            "To add the desktop app later, run the installer again with VERA_DESKTOP=yes.",
        );
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        expect(scenario.hasCli()).toBe(true);
        expect(scenario.desktopUrls()).toEqual([scenario.probeUrl()]);
        assertNothingDesktop(scenario);
    });
});

test("install.sh skips the desktop app when the terminal ends before an answer", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ tty: "" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("run the installer again with VERA_DESKTOP=yes.");
        assertNothingDesktop(scenario);
    });
});

test("install.sh never asks or installs when VERA_DESKTOP=no", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ desktop: "no", tty: "y\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        expect(result.stdout.toString()).not.toContain("VERA_DESKTOP=yes");
        expect(scenario.desktopUrls()).toEqual([]);
        assertNothingDesktop(scenario);
    });
});

test("install.sh does not ask when VERA_DESKTOP=yes, even if the terminal would say no", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ desktop: "yes", tty: "n\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        expect(existsSync(scenario.appPath())).toBe(true);
    });
});

test("install.sh treats VERA_DESKTOP=ask like the default", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ desktop: "ask", tty: "y\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("Also install the Vera desktop app? [Y/n] ");
        expect(existsSync(scenario.appPath())).toBe(true);
    });
});

test("install.sh rejects an invalid VERA_DESKTOP before it changes anything", async () => {
    for (const value of ["maybe", "YES", "1", "true"]) {
        await withScenario({}, (scenario) => {
            const result = scenario.run({ desktop: value, tty: "y\n" });
            expect(result.exitCode).toBe(1);
            expect(result.stderr.toString()).toContain(`VERA_DESKTOP must be ask, yes or no, not '${value}'`);
            expect(existsSync(join(scenario.prefix, "share"))).toBe(false);
            expect(existsSync(join(scenario.prefix, "bin"))).toBe(false);
            expect(scenario.urls()).toEqual([]);
            assertNothingDesktop(scenario);
        });
    }
}, LOOP_TIMEOUT_MS);

test("install.sh says the desktop app is not available on Linux and still installs vera", async () => {
    await withScenario({ os: "linux" }, (scenario) => {
        const result = scenario.run({ tty: "y\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain("The Vera desktop app is not available on Linux yet.");
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        expect(scenario.hasCli()).toBe(true);
        expect(scenario.desktopUrls()).toEqual([]);
        assertNothingDesktop(scenario);
    });
});

test("install.sh fails VERA_DESKTOP=yes on Linux after the vera command is installed", async () => {
    await withScenario({ os: "linux" }, (scenario) => {
        const result = scenario.run({ desktop: "yes" });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("The Vera desktop app is not available on Linux yet.");
        expect(result.stdout.toString()).toContain("Installed vera-hostbuild1");
        expect(scenario.hasCli()).toBe(true);
        expect(scenario.desktopUrls()).toEqual([]);
        assertNothingDesktop(scenario);
    });
});

test("install.sh says nothing about Linux when VERA_DESKTOP=no", async () => {
    await withScenario({ os: "linux" }, (scenario) => {
        const result = scenario.run({ desktop: "no" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).not.toContain("desktop app");
    });
});

test("install.sh does not offer the desktop app when installing from a local tarball", async () => {
    await withScenario({}, (scenario) => {
        const asked = scenario.run({ localTarball: true, tty: "y\n" });
        expect(asked.exitCode, asked.stderr.toString()).toBe(0);
        expect(asked.stdout.toString()).toContain("The desktop app comes from a release download.");
        expect(asked.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        assertNothingDesktop(scenario);

        const required = scenario.run({ localTarball: true, desktop: "yes" });
        expect(required.exitCode).toBe(1);
        expect(required.stderr.toString()).toContain("The vera command is installed.");
        assertNothingDesktop(scenario);
    });
});

test("install.sh stops on a desktop checksum mismatch before writing any desktop file", async () => {
    const bad = "0".repeat(64);
    for (const feed of [{ packageChecksum: bad }, { shellChecksum: bad }]) {
        await withScenario(feed, (scenario) => {
            const result = scenario.run({ desktop: "yes" });
            expect(result.exitCode).toBe(1);
            expect(result.stderr.toString()).toContain("checksum mismatch for vera-desktop");
            expect(result.stderr.toString()).toContain("The vera command is installed.");
            expect(result.stdout.toString()).toEndWith(`Open a new terminal window, or run: . '${scenario.home}/.profile'\n`);
            expect(scenario.hasCli()).toBe(true);
            assertNothingDesktop(scenario);
        });
    }
}, LOOP_TIMEOUT_MS);

const CUSTOM_PREFIX_LINE = "The desktop app needs Vera in ~/.local; it was not installed.";

function assertCustomPrefixInstall(scenario: Scenario): void {
    expect(readlinkSync(join(scenario.customPrefix, "share", "vera", "current"))).toBe(`releases/${BUILD_ID}`);
    expect(existsSync(scenario.prefix)).toBe(false);
    expect(existsSync(join(scenario.customPrefix, "share", "vera", "desktop"))).toBe(false);
    expect(scenario.urls().filter((url) => url.includes("vera-desktop"))).toEqual([]);
    expect(readdirSync(scenario.applications)).toEqual([]);
    expect(scenario.opened()).toEqual([]);
}

test("install.sh skips the desktop app without a question or a download when the prefix is not ~/.local", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ customPrefix: true, tty: "y\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(result.stdout.toString()).toContain(CUSTOM_PREFIX_LINE);
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        assertCustomPrefixInstall(scenario);
    });
});

test("install.sh fails VERA_DESKTOP=yes when the prefix is not ~/.local, after vera is installed", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ customPrefix: true, desktop: "yes" });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toBe(`${CUSTOM_PREFIX_LINE}\n`);
        expect(result.stdout.toString()).toContain("Installed vera-hostbuild1");
        assertCustomPrefixInstall(scenario);
    });
});

test("install.sh says nothing about the desktop app for a custom prefix when VERA_DESKTOP=no", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ customPrefix: true, desktop: "no" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).not.toContain("desktop app");
        expect(result.stdout.toString()).not.toContain("~/.local");
        expect(result.stderr.toString()).toBe("");
        assertCustomPrefixInstall(scenario);
    });
});

test("install.sh treats an explicit ~/.local prefix, with or without a trailing slash, as the default", async () => {
    for (const suffix of ["", "/"]) {
        await withScenario({}, (scenario) => {
            const result = Bun.spawnSync(["sh", installer], {
                env: {
                    HOME: scenario.home,
                    SHELL: "/bin/sh",
                    PATH: `${scenario.bin}:/usr/bin:/bin:/usr/sbin`,
                    VERA_INSTALL_PREFIX: `${scenario.prefix}${suffix}`,
                    VERA_INSTALL_TTY: scenario.ttyFile,
                    VERA_INSTALL_APPLICATIONS: scenario.applications,
                    VERA_INSTALL_NO_OPEN: "1",
                    VERA_DESKTOP: "yes",
                    VERA_VERSION: "9.9.9",
                    VERA_RELEASES_DOWNLOAD_BASE: "https://feed.test",
                },
                stdout: "pipe",
                stderr: "pipe",
                stdin: "ignore",
            });
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            expect(existsSync(scenario.appPath())).toBe(true);
        });
    }
}, LOOP_TIMEOUT_MS);

const NO_DESKTOP_LINE = "This release has no desktop app yet. The vera command is installed.";
const NO_DESKTOP_PACKAGE: FeedOptions = {
    omit: ["vera-desktop-darwin-arm64.tar.gz", "vera-desktop-shell-darwin-arm64.tar.gz"],
};

test("install.sh skips without asking when the release has no desktop app", async () => {
    await withScenario(NO_DESKTOP_PACKAGE, (scenario) => {
        const result = scenario.run({ tty: "y\n" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stderr.toString()).toBe("");
        expect(result.stdout.toString()).toContain(NO_DESKTOP_LINE);
        expect(result.stdout.toString()).toEndWith(`Open a new terminal window, or run: . '${scenario.home}/.profile'\n`);
        expect(result.stdout.toString()).not.toContain("Also install the Vera desktop app?");
        expect(result.stdout.toString()).not.toContain("VERA_DESKTOP=yes");
        expect(scenario.hasCli()).toBe(true);
        expect(scenario.desktopUrls()).toEqual([scenario.probeUrl()]);
        assertNothingDesktop(scenario);
    });
});

test("install.sh reports a release without a desktop app even with no terminal", async () => {
    await withScenario(NO_DESKTOP_PACKAGE, (scenario) => {
        const result = scenario.run();
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString()).toContain(NO_DESKTOP_LINE);
        expect(result.stdout.toString()).not.toContain("VERA_DESKTOP=yes");
        assertNothingDesktop(scenario);
    });
});

test("install.sh fails VERA_DESKTOP=yes when the release has no desktop app", async () => {
    await withScenario(NO_DESKTOP_PACKAGE, (scenario) => {
        const result = scenario.run({ desktop: "yes" });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toBe(`${NO_DESKTOP_LINE}\n`);
        expect(result.stdout.toString()).toContain("Installed vera-hostbuild1");
        expect(scenario.hasCli()).toBe(true);
        expect(scenario.desktopUrls()).toEqual([scenario.probeUrl()]);
        assertNothingDesktop(scenario);
    });
});

test("install.sh stops when the release has no desktop files", async () => {
    await withScenario({ omit: ["vera-desktop-shell-darwin-arm64.tar.gz"] }, (scenario) => {
        const result = scenario.run({ desktop: "yes" });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(
            "download failed: https://feed.test/v9.9.9/vera-desktop-shell-darwin-arm64.tar.gz",
        );
        expect(scenario.hasCli()).toBe(true);
        assertNothingDesktop(scenario);
    });
});

test("install.sh refuses a desktop package built for another host build", async () => {
    await withScenario({ manifest: { host_build_id: "vera-otherbuild" } }, (scenario) => {
        const result = scenario.run({ desktop: "yes" });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("is not built for the installed host build vera-hostbuild1");
        expect(scenario.hasCli()).toBe(true);
        expect(readdirSync(join(scenario.share, "desktop", BUILD_ID), { withFileTypes: true })).toEqual([]);
        expect(existsSync(join(scenario.share, "desktop", "installed.json"))).toBe(false);
        expect(readdirSync(scenario.applications)).toEqual([]);
        expect(scenario.opened()).toEqual([]);
    });
});

test("install.sh refuses a desktop package with an unsupported layout or an unsafe manifest", async () => {
    const cases: readonly { manifest: Record<string, unknown>; entryFile?: boolean; message: string }[] = [
        { manifest: { layout_version: 2 }, message: "unsupported desktop-package.json layout_version" },
        { manifest: { layout_version: "1" }, message: "unsupported desktop-package.json layout_version" },
        { manifest: { entry: "../outside.js" }, message: "unsafe entry path" },
        { manifest: { entry: "/etc/passwd" }, message: "unsafe entry path" },
        { manifest: { entry: "app//main.js" }, message: "unsafe entry path" },
        { manifest: { entry: "app/./main.js" }, message: "unsafe entry path" },
        { manifest: { entry: "app\\main.js" }, message: "unsafe entry path" },
        { manifest: { entry: "app/missing.js" }, message: "has no entry file app/missing.js" },
        { manifest: { desktop_version: "../1.2.3" }, message: "invalid desktop_version" },
        { manifest: { desktop_version: "latest" }, message: "invalid desktop_version" },
        { manifest: { host_build_id: 7 }, message: "is not built for the installed host build" },
    ];
    for (const item of cases) {
        await withScenario({ manifest: item.manifest }, (scenario) => {
            const result = scenario.run({ desktop: "yes" });
            expect(result.exitCode, JSON.stringify(item.manifest)).toBe(1);
            expect(result.stderr.toString()).toContain(item.message);
            expect(existsSync(join(scenario.share, "desktop", "installed.json"))).toBe(false);
            expect(readdirSync(scenario.applications)).toEqual([]);
            expect(readdirSync(join(scenario.share, "desktop", BUILD_ID))).toEqual([]);
        });
    }
}, LOOP_TIMEOUT_MS);

test("install.sh refuses an existing Vera.app that is not the Vera desktop app", async () => {
    const shells: readonly { make: (dir: string) => void }[] = [
        { make: (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "mine.txt"), "mine\n"); } },
        { make: (dir) => writeShell(dir, "mine\n", { bundleId: "com.example.other" }) },
        { make: (dir) => writeShell(dir, "mine\n", { marker: false }) },
    ];
    for (const shell of shells) {
        await withScenario({}, (scenario) => {
            shell.make(scenario.appPath());
            const before = Bun.spawnSync(["find", scenario.appPath()]).stdout.toString();
            const result = scenario.run({ desktop: "yes" });
            expect(result.exitCode).toBe(1);
            expect(result.stderr.toString()).toContain(`${scenario.appPath()} is not the Vera desktop app`);
            expect(Bun.spawnSync(["find", scenario.appPath()]).stdout.toString()).toBe(before);
            expect(scenario.hasCli()).toBe(true);
            expect(scenario.desktopUrls()).toEqual([scenario.probeUrl()]);
            expect(existsSync(join(scenario.share, "desktop"))).toBe(false);
            expect(scenario.opened()).toEqual([]);
        });
    }
}, LOOP_TIMEOUT_MS);

test("install.sh does not replace a running Vera and leaves the installed command in place", async () => {
    await withScenario({}, (scenario) => {
        writeShell(scenario.appPath(), "old shell\n");
        const result = scenario.run({ desktop: "yes", lsof: `${scenario.appPath()}/Contents/MacOS/Vera` });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("Vera is running. Quit Vera and run the installer again.");
        expect(result.stderr.toString()).toContain("The vera command is installed.");
        expect(scenario.hasCli()).toBe(true);
        expect(readFileSync(join(scenario.appPath(), "Contents", "Resources", "note.txt"), "utf8")).toBe("old shell\n");
        expect(scenario.desktopUrls()).toEqual([scenario.probeUrl()]);
        expect(existsSync(join(scenario.share, "desktop"))).toBe(false);
        expect(scenario.opened()).toEqual([]);
    });
});

test("install.sh does not guess when it cannot tell whether Vera is running", async () => {
    await withScenario({}, (scenario) => {
        writeShell(scenario.appPath(), "old shell\n");
        const result = scenario.run({ desktop: "yes", lsofFails: true });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("could not tell whether Vera is running");
        expect(readFileSync(join(scenario.appPath(), "Contents", "Resources", "note.txt"), "utf8")).toBe("old shell\n");
    });
});

test("install.sh replaces an existing Vera desktop app that is not running", async () => {
    await withScenario({}, (scenario) => {
        writeShell(scenario.appPath(), "old shell\n");
        writeFileSync(join(scenario.appPath(), "Contents", "Resources", "old-only.txt"), "old\n");
        const elsewhere = join(scenario.root, "Other.app", "Contents", "MacOS", "Other");
        const result = scenario.run({ desktop: "yes", lsof: elsewhere });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(readFileSync(join(scenario.appPath(), "Contents", "Resources", "note.txt"), "utf8")).toBe("new shell\n");
        expect(existsSync(join(scenario.appPath(), "Contents", "Resources", "old-only.txt"))).toBe(false);
        expect(readdirSync(scenario.applications)).toEqual(["Vera.app"]);
        expect(scenario.record()).toEqual({ layout_version: 1, app_path: scenario.appPath() });
        expect(scenario.opened()).toEqual([scenario.appPath()]);
    });
});

test("install.sh sees a running Vera that the system reports under its real path", async () => {
    await withScenario({}, (scenario) => {
        writeShell(scenario.appPath(), "old shell\n");
        const result = scenario.run({
            desktop: "yes",
            applications: "symlink",
            lsof: `${scenario.appPath()}/Contents/MacOS/Vera`,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("Vera is running. Quit Vera and run the installer again.");
        expect(readFileSync(join(scenario.appPath(), "Contents", "Resources", "note.txt"), "utf8")).toBe("old shell\n");
    });
});

test("install.sh restores the old app when the new one cannot be moved in", async () => {
    await withScenario({}, (scenario) => {
        writeShell(scenario.appPath(), "old shell\n");
        const result = scenario.run({ desktop: "yes", failPlacement: true });
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(`could not place ${scenario.appPath()}`);
        expect(readFileSync(join(scenario.appPath(), "Contents", "Resources", "note.txt"), "utf8")).toBe("old shell\n");
        expect(readdirSync(scenario.applications)).toEqual(["Vera.app"]);
        expect(existsSync(join(scenario.share, "desktop", "installed.json"))).toBe(false);
        expect(scenario.opened()).toEqual([]);
    });
});

test("install.sh installs into ~/Applications when /Applications cannot be written", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ desktop: "yes", applications: "missing" });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const app = scenario.appPath(false);
        expect(existsSync(join(app, "Contents", "Info.plist"))).toBe(true);
        expect(readdirSync(scenario.applications)).toEqual([]);
        expect(scenario.record()).toEqual({ layout_version: 1, app_path: app });
        expect(scenario.opened()).toEqual([app]);
    });
});

test("install.sh installs the same desktop package again without rewriting it", async () => {
    await withScenario({}, (scenario) => {
        expect(scenario.run({ desktop: "yes" }).exitCode).toBe(0);
        writeFileSync(join(scenario.packageDirectory(), "kept.txt"), "kept\n");
        const again = scenario.run({ desktop: "yes" });
        expect(again.exitCode, again.stderr.toString()).toBe(0);
        expect(again.stdout.toString()).toContain(`Desktop package ${DESKTOP_VERSION} is already installed`);
        expect(readFileSync(join(scenario.packageDirectory(), "kept.txt"), "utf8")).toBe("kept\n");
        expect(readdirSync(join(scenario.share, "desktop", BUILD_ID))).toEqual([DESKTOP_VERSION]);
        expect(readdirSync(scenario.applications)).toEqual(["Vera.app"]);
        expect(scenario.opened()).toHaveLength(2);
    });
});

test("install.sh does not open the app when VERA_INSTALL_NO_OPEN is set", async () => {
    await withScenario({}, (scenario) => {
        const result = scenario.run({ desktop: "yes", noOpen: true });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(existsSync(scenario.appPath())).toBe(true);
        expect(scenario.opened()).toEqual([]);
    });
});

import { expect, test } from "bun:test";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const uninstaller = resolve(import.meta.dir, "..", "..", "scripts", "uninstall.sh");

interface RunOptions {
    answers?: string;
    automated?: boolean;
    backup?: string;
    backupDir?: string;
    failBackup?: boolean;
    traceBackup?: boolean;
    failHost?: boolean;
    noHost?: boolean;
    pendingHost?: boolean;
    failQuit?: boolean;
    hostOutput?: string;
    useDefaults?: boolean;
    extraEnv?: Record<string, string>;
}

class Scenario {
    readonly root = mkdtempSync(join(tmpdir(), "vera uninstall-"));
    readonly home = join(this.root, "user-home");
    readonly veraHome = join(this.home, "custom-vera-home");
    readonly prefix = join(this.root, "prefix");
    readonly applications = join(this.root, "Applications");
    readonly bin = join(this.root, "bin");
    readonly tty = join(this.root, "tty");
    readonly log = join(this.root, "calls.log");
    readonly launcher = join(this.prefix, "bin", "vera");
    readonly share = join(this.prefix, "share", "vera");
    readonly app = join(this.applications, "Vera.app");

    constructor() {
        mkdirSync(join(this.home, "Documents"), { recursive: true });
        mkdirSync(join(this.veraHome, "machine"), { recursive: true });
        mkdirSync(join(this.prefix, "bin"), { recursive: true });
        mkdirSync(this.share, { recursive: true });
        mkdirSync(this.applications, { recursive: true });
        mkdirSync(this.bin, { recursive: true });
        writeFileSync(join(this.home, "Documents", "note.txt"), "home data\n");
        writeFileSync(join(this.veraHome, "settings.json"), "settings\n");
        writeFileSync(join(this.veraHome, "machine", "auth.json"), "fake sign-ins\n", { mode: 0o600 });
        writeFileSync(join(this.share, "release.txt"), "release data\n");
        writeFileSync(this.launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(this.log, "");
        writeFileSync(join(this.bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
        writeFileSync(join(this.bin, "osascript"), `#!/bin/sh\nprintf 'osascript %s\\n' "$*" >> '${this.log}'\nexit 0\n`, { mode: 0o755 });
        if (!existsSync("/usr/bin/plutil")) {
            const shim = join(this.bin, "plutil.js");
            writeFileSync(shim, `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
let contents;
try { contents = readFileSync(args.at(-1), "utf8"); } catch { process.exit(1); }
if (args[0] === "-type") {
    try {
        const value = JSON.parse(contents)[args[1]];
        if (Number.isInteger(value)) console.log("integer");
        else process.exit(1);
    } catch { process.exit(1); }
} else if (args[1] === "CFBundleIdentifier") {
    const match = contents.match(/<key>CFBundleIdentifier<\\/key>\\s*<string>([^<]+)<\\/string>/);
    if (match) console.log(match[1]); else process.exit(1);
} else {
    try {
        const value = JSON.parse(contents)[args[1]];
        if (typeof value === "string") console.log(value); else process.exit(1);
    } catch { process.exit(1); }
}
`);
            writeFileSync(join(this.bin, "plutil"), `#!/bin/sh\nexec '${process.execPath}' '${shim}' "$@"\n`, { mode: 0o755 });
        }
    }

    dispose(): void {
        rmSync(this.root, { recursive: true, force: true });
    }

    installRecord(): void {
        mkdirSync(join(this.share, "desktop"), { recursive: true });
        writeFileSync(join(this.share, "desktop", "installed.json"), JSON.stringify({
            layout_version: 1,
            app_path: this.app,
        }));
        mkdirSync(join(this.app, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(this.app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>dev.vera.desktop</string></dict></plist>`);
        writeFileSync(join(this.app, "Contents", "Resources", "vera-shell.json"), '{"shell_api":1}\n');
    }

    run(options: RunOptions = {}) {
        if (options.answers !== undefined) writeFileSync(this.tty, options.answers);
        if (options.failBackup) {
            const backupDir = join(this.root, "backup-parent");
            mkdirSync(backupDir);
            writeFileSync(join(this.bin, "tar"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
            options.backupDir ??= backupDir;
        }
        if (options.failQuit) {
            writeFileSync(join(this.bin, "osascript"), `#!/bin/sh\nprintf 'osascript %s\\n' "$*" >> '${this.log}'\nexit 1\n`, { mode: 0o755 });
        }
        if (options.traceBackup) {
            const tar = Bun.which("tar");
            if (tar === null) throw new Error("tar is missing");
            writeFileSync(join(this.bin, "tar"), `#!/bin/sh\nprintf 'archive created\\n' >> '${this.log}'\nexec '${tar}' "$@"\n`, { mode: 0o755 });
        }
        const hostOutput = options.hostOutput ?? (options.pendingHost
            ? "Resident Vera host PID 123 will stop once its running turns end."
            : options.noHost
                ? "No resident Vera host is running."
                : "Stopped resident Vera host PID 123 after its running turns ended.");
        const launcher = options.useDefaults ? join(this.home, ".local", "bin", "vera") : this.launcher;
        const backupProbe = options.traceBackup
            ? `for archive in '${this.home}'/vera-backup-*.tar.gz; do\n    if [ -e "$archive" ]; then echo 'archive existed before host stop' >> '${this.log}'; exit 1; fi\ndone\n`
            : "";
        writeFileSync(launcher, `#!/bin/sh\n${backupProbe}printf 'vera %s VERA_HOME=%s\\n' "$*" "$VERA_HOME" >> '${this.log}'\necho '${hostOutput}'\n[ '${options.failHost ? "fail" : "ok"}' = ok ]\n`, { mode: 0o755 });
        const env: Record<string, string> = {
            HOME: this.home,
            VERA_HOME: options.useDefaults ? "" : this.veraHome,
            VERA_INSTALL_PREFIX: options.useDefaults ? "" : this.prefix,
            VERA_INSTALL_APPLICATIONS: this.applications,
            VERA_UNINSTALL_TTY: this.tty,
            PATH: `${this.bin}:/usr/bin:/bin:/usr/sbin`,
        };
        if (options.automated) {
            env.VERA_UNINSTALL = "yes";
            env.CI = "true";
        }
        if (options.backup !== undefined) env.VERA_UNINSTALL_BACKUP = options.backup;
        if (options.backupDir !== undefined) env.VERA_UNINSTALL_BACKUP_DIR = options.backupDir;
        Object.assign(env, options.extraEnv ?? {});
        return Bun.spawnSync(["sh", uninstaller], {
            env,
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
        });
    }

    output(result: ReturnType<Scenario["run"]>): string {
        return `${result.stdout.toString()}\n${result.stderr.toString()}`;
    }
}

function withScenario(body: (scenario: Scenario) => void): void {
    const scenario = new Scenario();
    try {
        body(scenario);
    } finally {
        scenario.dispose();
    }
}

function archives(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return Bun.spawnSync(["sh", "-c", `printf '%s\\n' "$1"/vera-backup-*.tar.gz`, "sh", directory])
        .stdout.toString().trim().split("\n").filter((path) => existsSync(path));
}

function singleArchive(directory: string): string {
    const found = archives(directory);
    expect(found).toHaveLength(1);
    const archive = found[0];
    if (archive === undefined) throw new Error("Backup archive is missing");
    return archive;
}

test("uninstall.sh lists existing install paths with sizes and removes them after confirmation", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        const result = scenario.run({ answers: "y\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        for (const path of [scenario.launcher, scenario.share, scenario.app, scenario.veraHome]) {
            expect(output).toContain(path);
        }
        expect(output).toMatch(/launcher: \d+(?:\.\d+)?[KMGT]?\s/);
        expect(existsSync(scenario.launcher)).toBe(false);
        expect(existsSync(scenario.share)).toBe(false);
        expect(existsSync(scenario.app)).toBe(false);
        expect(existsSync(scenario.veraHome)).toBe(false);
        expect(readFileSync(scenario.log, "utf8")).toContain(`vera host stop --yes VERA_HOME=${scenario.veraHome}`);
        expect(readFileSync(scenario.log, "utf8")).toContain("osascript");
        expect(archives(scenario.home)).toEqual([]);
    });
});

test("uninstall.sh backs up home without sign-ins when requested and writes a restorable archive", () => {
    withScenario((scenario) => {
        const result = scenario.run({ answers: "y\ny\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        const archive = singleArchive(scenario.home);
        expect(archive).toMatch(/vera-backup-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d\.tar\.gz$/);
        expect(statSync(archive).mode & 0o777).toBe(0o600);
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
        expect(listing).toContain("README.md");
        expect(listing).toContain(`${scenario.veraHome.split("/").at(-1)}/`);
        expect(listing).not.toContain("auth.json");
        const readme = Bun.spawnSync(["tar", "-xOzf", archive, "README.md"]).stdout.toString();
        expect(readme).toContain(scenario.veraHome);
        expect(readme).toMatch(/sign-in|sign in/i);
        expect(readme).toContain("https://raw.githubusercontent.com/nashaad/vera/main/scripts/install.sh");
        expect(existsSync(scenario.veraHome)).toBe(false);
    });
});

test("uninstall.sh includes sign-ins when requested and saves to a custom location", () => {
    withScenario((scenario) => {
        const destination = join(scenario.root, "backups");
        mkdirSync(destination);
        const result = scenario.run({ answers: `y\ny\ny\n${destination}\n` });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        const archive = singleArchive(destination);
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
        expect(listing).toContain("auth.json");
        const auth = Bun.spawnSync(["tar", "-xOzf", archive, "./custom-vera-home/machine/auth.json"]);
        expect(auth.exitCode, auth.stderr.toString()).toBe(0);
        expect(auth.stdout.toString()).toBe("fake sign-ins\n");
        const readme = Bun.spawnSync(["tar", "-xOzf", archive, "README.md"]).stdout.toString();
        expect(readme).toMatch(/sign-in.*included|included.*sign-in/i);
        expect(output).toContain(archive);
    });
});

test("uninstall.sh honors a custom backup directory from the environment", () => {
    withScenario((scenario) => {
        const destination = join(scenario.root, "environment-backups");
        mkdirSync(destination);
        const result = scenario.run({ answers: "y\ny\nn\n\n", backupDir: destination });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(scenario.output(result)).toContain(`Backup directory [${destination}]`);
        expect(archives(destination)).toHaveLength(1);
    });
});

test("a typed tilde backup directory resolves under the scratch HOME", () => {
    for (const typed of ["~", "~/typed backups"]) {
        withScenario((scenario) => {
            const destination = typed === "~" ? scenario.home : join(scenario.home, "typed backups");
            mkdirSync(destination, { recursive: true });
            const result = scenario.run({ answers: `y\ny\nn\n${typed}\n` });
            expect(result.exitCode, scenario.output(result)).toBe(0);
            const archive = singleArchive(destination);
            expect(scenario.output(result)).toContain(archive);
            expect(existsSync(scenario.veraHome)).toBe(false);
        });
    }
});

test("a tilde in VERA_UNINSTALL_BACKUP_DIR resolves under the scratch HOME", () => {
    for (const configured of ["~", "~/environment backups"]) {
        withScenario((scenario) => {
            const destination = configured === "~" ? scenario.home : join(scenario.home, "environment backups");
            mkdirSync(destination, { recursive: true });
            const result = scenario.run({ automated: true, backupDir: configured });
            expect(result.exitCode, scenario.output(result)).toBe(0);
            expect(scenario.output(result)).toContain(singleArchive(destination));
        });
    }
});

test("a tilde environment default is used when the interactive answer is empty", () => {
    withScenario((scenario) => {
        const destination = join(scenario.home, "default backups");
        mkdirSync(destination);
        const result = scenario.run({ answers: "y\ny\nn\n\n", backupDir: "~/default backups" });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(scenario.output(result)).toContain(singleArchive(destination));
    });
});

test("uninstall.sh refuses a noninteractive run without explicit authorization", () => {
    withScenario((scenario) => {
        const result = scenario.run();
        expect(result.exitCode).not.toBe(0);
        expect(scenario.output(result)).toMatch(/VERA_UNINSTALL=yes|automated|terminal/i);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
        expect(existsSync(scenario.veraHome)).toBe(true);
        expect(readFileSync(scenario.log, "utf8")).toBe("");
    });
});

test("VERA_UNINSTALL=yes bypasses an available terminal and backs up sign-ins by default", () => {
    withScenario((scenario) => {
        const result = scenario.run({ automated: true, answers: "n\nn\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        expect(output).not.toMatch(/Continue with uninstall\?|include sign-ins\?/i);
        const archive = singleArchive(scenario.home);
        expect(Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString()).toContain("auth.json");
        expect(existsSync(scenario.veraHome)).toBe(false);
    });
});

test("VERA_UNINSTALL_BACKUP=no skips the archive during an automated uninstall", () => {
    withScenario((scenario) => {
        const result = scenario.run({ automated: true, backup: "no" });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(archives(scenario.home)).toEqual([]);
        expect(existsSync(scenario.veraHome)).toBe(false);
    });
});

test("@core uninstall.sh leaves paths intact when backup fails after the host stops", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        const result = scenario.run({ answers: "y\ny\nn\n\n", failBackup: true });
        const output = scenario.output(result);
        expect(result.exitCode).not.toBe(0);
        expect(output).toMatch(/backup.*failed/i);
        expect(output).toMatch(/host is stopped.*next time you run vera/i);
        expect(output).toMatch(/nothing was removed/i);
        for (const path of [scenario.launcher, scenario.share, scenario.app, scenario.veraHome]) {
            expect(existsSync(path)).toBe(true);
        }
        const log = readFileSync(scenario.log, "utf8");
        expect(log).toContain("osascript");
        expect(log).toContain(`vera host stop --yes VERA_HOME=${scenario.veraHome}`);
        expect(archives(join(scenario.root, "backup-parent"))).toEqual([]);
    });
});

test("uninstall.sh quits the app and stops the host before creating the archive", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        const result = scenario.run({ answers: "y\ny\nn\n\n", traceBackup: true });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        const log = readFileSync(scenario.log, "utf8");
        const quit = log.indexOf("osascript");
        const stop = log.indexOf("vera host stop --yes");
        const archive = log.indexOf("archive created");
        expect(quit).toBeGreaterThanOrEqual(0);
        expect(stop).toBeGreaterThan(quit);
        expect(archive).toBeGreaterThan(stop);
        expect(log).not.toContain("archive existed before host stop");
        expect(archives(scenario.home)).toHaveLength(1);
    });
});

test("@core uninstall.sh stops without removing paths when the installed host will not stop", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        const result = scenario.run({ automated: true, backup: "no", failHost: true });
        expect(result.exitCode).not.toBe(0);
        expect(scenario.output(result)).toMatch(/host.*stop|could not stop/i);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
        expect(existsSync(scenario.veraHome)).toBe(true);
        expect(readFileSync(scenario.log, "utf8")).toContain(`vera host stop --yes VERA_HOME=${scenario.veraHome}`);
        expect(existsSync(scenario.app)).toBe(true);
    });
});

test("uninstall.sh applies the Vera shell identity check to a recorded app", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        rmSync(join(scenario.app, "Contents", "Resources", "vera-shell.json"));
        writeFileSync(join(scenario.app, "keep.txt"), "not Vera\n");
        const result = scenario.run({ answers: "y\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        expect(existsSync(join(scenario.app, "keep.txt"))).toBe(true);
        expect(output).toContain(scenario.app);
        expect(output).toMatch(/left|not the Vera/i);
    });
});

test("uninstall.sh finds Vera.app in the configured Applications folder without a record", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        rmSync(join(scenario.share, "desktop", "installed.json"));
        const result = scenario.run({ answers: "y\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        expect(output).toContain(scenario.app);
        expect(existsSync(scenario.app)).toBe(false);
    });
});

test("uninstall.sh finds Vera.app in HOME Applications when the configured folder has none", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        rmSync(join(scenario.share, "desktop", "installed.json"));
        const userApplications = join(scenario.home, "Applications");
        mkdirSync(userApplications);
        const userApp = join(userApplications, "Vera.app");
        renameSync(scenario.app, userApp);
        const result = scenario.run({ answers: "y\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        expect(output).toContain(userApp);
        expect(existsSync(userApp)).toBe(false);
    });
});

test("uninstall.sh continues when the installed host is already stopped", () => {
    withScenario((scenario) => {
        const result = scenario.run({ automated: true, backup: "no", noHost: true });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        const log = readFileSync(scenario.log, "utf8");
        expect(log).toContain(`vera host stop --yes VERA_HOME=${scenario.veraHome}`);
        expect(output).toContain("No resident Vera host is running.");
        expect(existsSync(scenario.launcher)).toBe(false);
        expect(existsSync(scenario.veraHome)).toBe(false);
    });
});

test("@core uninstall.sh preserves all targets when the host has pending turns", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        const result = scenario.run({ automated: true, backup: "no", pendingHost: true });
        const output = scenario.output(result);
        expect(result.exitCode).not.toBe(0);
        expect(output).toContain("Resident Vera host PID 123 will stop once its running turns end.");
        expect(output).toMatch(/retry/i);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
        expect(existsSync(scenario.app)).toBe(true);
        expect(existsSync(scenario.veraHome)).toBe(true);
    });
});

test("uninstall.sh reports macOS Library leftovers and the backup location", () => {
    withScenario((scenario) => {
        const preferences = join(scenario.home, "Library", "Preferences", "dev.vera.desktop.plist");
        const savedState = join(scenario.home, "Library", "Saved Application State", "dev.vera.desktop.savedState");
        mkdirSync(join(scenario.home, "Library", "Preferences"), { recursive: true });
        mkdirSync(join(scenario.home, "Library", "Saved Application State"), { recursive: true });
        writeFileSync(preferences, "plist\n");
        writeFileSync(savedState, "state\n");
        const result = scenario.run({ answers: "y\ny\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        expect(output).toContain(preferences);
        expect(output).toContain(savedState);
        expect(output).toContain(singleArchive(scenario.home));
        expect(existsSync(preferences)).toBe(true);
        expect(existsSync(savedState)).toBe(true);
    });
});

test("uninstall.sh requires an explicit sign-in answer and defaults the backup to yes", () => {
    withScenario((scenario) => {
        const result = scenario.run({ answers: "y\n\n\nn\n\n" });
        const output = scenario.output(result);
        expect(result.exitCode, output).toBe(0);
        expect(output).toContain("Please answer y or n.");
        const archive = singleArchive(scenario.home);
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
        expect(listing).not.toContain("machine/auth.json");
        const extract = join(scenario.root, "restore");
        mkdirSync(extract);
        const restored = Bun.spawnSync(["tar", "-xzf", archive, "-C", extract]);
        expect(restored.exitCode, restored.stderr.toString()).toBe(0);
        expect(readFileSync(join(extract, "custom-vera-home", "settings.json"), "utf8")).toBe("settings\n");
        expect(existsSync(join(extract, "custom-vera-home", "machine", "auth.json"))).toBe(false);
    });
});

test("uninstall.sh cancels by default and leaves all paths intact on terminal EOF", () => {
    for (const answers of ["\n", "y\ny\n", "y\ny\nn\n"]) {
        withScenario((scenario) => {
            scenario.installRecord();
            const result = scenario.run({ answers });
            if (answers === "\n") expect(result.exitCode).toBe(0);
            else expect(result.exitCode).not.toBe(0);
            expect(existsSync(scenario.launcher)).toBe(true);
            expect(existsSync(scenario.share)).toBe(true);
            expect(existsSync(scenario.app)).toBe(true);
            expect(existsSync(scenario.veraHome)).toBe(true);
            expect(readFileSync(scenario.log, "utf8")).toBe("");
        });
    }
});

test("CI refuses without authorization even when a terminal seam is present", () => {
    withScenario((scenario) => {
        const result = scenario.run({ answers: "y\nn\n", extraEnv: { CI: "true" } });
        const output = scenario.output(result);
        expect(result.exitCode).not.toBe(0);
        expect(output).toContain("VERA_UNINSTALL=yes");
        expect(output).not.toContain("Continue with uninstall?");
        expect(existsSync(scenario.veraHome)).toBe(true);
        expect(readFileSync(scenario.log, "utf8")).toBe("");
    });
});

test("@core uninstall.sh rejects an unavailable backup directory before shutdown", () => {
    for (const automated of [false, true]) {
        withScenario((scenario) => {
            scenario.installRecord();
            const destination = join(scenario.home, "missing backups");
            const result = automated
                ? scenario.run({ automated: true, backupDir: destination })
                : scenario.run({ answers: "y\ny\nn\n~/missing backups\n" });
            const output = scenario.output(result);
            expect(result.exitCode).not.toBe(0);
            expect(output).toContain(`backup directory does not exist or cannot be read: ${destination}; nothing was removed`);
            expect(output).not.toContain("host is stopped");
            for (const path of [scenario.launcher, scenario.share, scenario.app, scenario.veraHome]) {
                expect(existsSync(path)).toBe(true);
            }
            expect(existsSync(destination)).toBe(false);
            expect(archives(scenario.home)).toEqual([]);
            expect(readFileSync(scenario.log, "utf8")).toBe("");
        });
    }
});

test("a backup directory inside a removal path is refused before shutdown", () => {
    for (const location of ["home", "release", "app"] as const) {
        withScenario((scenario) => {
            scenario.installRecord();
            const removalPath = location === "home" ? scenario.veraHome : location === "release" ? scenario.share : scenario.app;
            const destination = join(removalPath, "backups");
            mkdirSync(destination);
            const result = scenario.run({ automated: true, backupDir: destination });
            const output = scenario.output(result);
            expect(result.exitCode).not.toBe(0);
            expect(output).toMatch(/backup directory.*inside/i);
            expect(output).not.toContain("host is stopped");
            for (const path of [scenario.launcher, scenario.share, scenario.app, scenario.veraHome]) {
                expect(existsSync(path)).toBe(true);
            }
            expect(archives(destination)).toEqual([]);
            expect(readFileSync(scenario.log, "utf8")).toBe("");
        });
    }
});

test("excluding sign-ins handles wildcard characters in a home directory name", () => {
    withScenario((scenario) => {
        const unusualHome = join(scenario.home, "home[?]*");
        renameSync(scenario.veraHome, unusualHome);
        const result = scenario.run({ answers: "y\ny\nn\n\n", extraEnv: { VERA_HOME: unusualHome } });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        const archive = singleArchive(scenario.home);
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
        expect(listing).toContain("settings.json");
        expect(listing).not.toContain("machine/auth.json");
    });
});

test("a home named README.md has a distinct restore README in the archive", () => {
    withScenario((scenario) => {
        const unusualHome = join(scenario.home, "README.md");
        renameSync(scenario.veraHome, unusualHome);
        const result = scenario.run({ answers: "y\ny\nn\n\n", extraEnv: { VERA_HOME: unusualHome } });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        const archive = singleArchive(scenario.home);
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
        expect(listing).toContain("README.md/settings.json");
        expect(listing).toContain("VERA-RESTORE-README.md");
        expect(listing).not.toContain("machine/auth.json");
        const extract = join(scenario.root, "restore-readme-home");
        mkdirSync(extract);
        const restored = Bun.spawnSync(["tar", "-xzf", archive, "-C", extract]);
        expect(restored.exitCode, restored.stderr.toString()).toBe(0);
        expect(readFileSync(join(extract, "README.md", "settings.json"), "utf8")).toBe("settings\n");
        expect(readFileSync(join(extract, "VERA-RESTORE-README.md"), "utf8")).toContain(unusualHome);
    });
});

test("an app quit failure leaves the launcher, app, release and home intact", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        const result = scenario.run({ automated: true, backup: "no", failQuit: true });
        expect(result.exitCode).not.toBe(0);
        expect(scenario.output(result)).toMatch(/could not quit/i);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
        expect(existsSync(scenario.app)).toBe(true);
        expect(existsSync(scenario.veraHome)).toBe(true);
        expect(readFileSync(scenario.log, "utf8")).not.toContain("vera host stop");
    });
});

test("an unrecognized successful host response fails closed", () => {
    withScenario((scenario) => {
        const result = scenario.run({ automated: true, backup: "no", hostOutput: "Waiting on Stopped resident Vera host PID 42\nrequest accepted" });
        expect(result.exitCode).not.toBe(0);
        expect(scenario.output(result)).toMatch(/could not confirm/i);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
        expect(existsSync(scenario.veraHome)).toBe(true);
    });
});

test("inherited tar options cannot silently exclude backup files", () => {
    withScenario((scenario) => {
        const result = scenario.run({ automated: true, extraEnv: { TAR_OPTIONS: "--exclude=*" } });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        const archive = singleArchive(scenario.home);
        const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
        expect(listing).toContain("settings.json");
        expect(listing).toContain("machine/auth.json");
        expect(listing).toContain("README.md");
    });
});

test("a failed host stop leaves the installation intact and creates no backup", () => {
    withScenario((scenario) => {
        const result = scenario.run({ automated: true, failHost: true });
        expect(result.exitCode).not.toBe(0);
        expect(archives(scenario.home)).toEqual([]);
        expect(scenario.output(result)).not.toContain("Backup saved");
        expect(existsSync(scenario.veraHome)).toBe(true);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
    });
});

test("default prefix and home are resolved under the scratch HOME", () => {
    withScenario((scenario) => {
        const home = join(scenario.home, ".vera");
        const prefix = join(scenario.home, ".local");
        renameSync(scenario.veraHome, home);
        renameSync(scenario.prefix, prefix);
        const result = scenario.run({ automated: true, backup: "no", useDefaults: true });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(readFileSync(scenario.log, "utf8")).toContain(`vera host stop --yes VERA_HOME=${home}`);
        expect(existsSync(home)).toBe(false);
        expect(existsSync(join(prefix, "share", "vera"))).toBe(false);
        expect(existsSync(join(prefix, "bin", "vera"))).toBe(false);
    });
});

test("no backup is made when the Vera home is absent", () => {
    withScenario((scenario) => {
        rmSync(scenario.veraHome, { recursive: true });
        const result = scenario.run({ automated: true });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(scenario.output(result)).not.toContain(`home: `);
        expect(archives(scenario.home)).toEqual([]);
        expect(existsSync(scenario.launcher)).toBe(false);
    });
});

test("the installed launcher is used instead of a vera command on PATH", () => {
    withScenario((scenario) => {
        writeFileSync(join(scenario.bin, "vera"), `#!/bin/sh\nprintf 'PATH vera\\n' >> '${scenario.log}'\nexit 1\n`, { mode: 0o755 });
        const result = scenario.run({ automated: true, backup: "no" });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        const log = readFileSync(scenario.log, "utf8");
        expect(log).toContain(`vera host stop --yes VERA_HOME=${scenario.veraHome}`);
        expect(log).not.toContain("PATH vera");
    });
});

test("both verified fallback apps are removed when no install record exists", () => {
    withScenario((scenario) => {
        scenario.installRecord();
        rmSync(join(scenario.share, "desktop", "installed.json"));
        const userApplications = join(scenario.home, "Applications");
        mkdirSync(userApplications);
        const otherApp = join(userApplications, "Vera.app");
        cpSync(scenario.app, otherApp, { recursive: true });
        const result = scenario.run({ automated: true, backup: "no" });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(existsSync(scenario.app)).toBe(false);
        expect(existsSync(otherApp)).toBe(false);
        const log = readFileSync(scenario.log, "utf8");
        expect(log).toContain(scenario.app);
        expect(log).toContain(otherApp);
    });
});

test("@core uninstall.sh refuses HOME or an ancestor before removing anything", () => {
    for (const useAncestor of [false, true]) {
        withScenario((scenario) => {
            scenario.installRecord();
            const target = useAncestor ? scenario.root : scenario.home;
            const result = scenario.run({ automated: true, backup: "no", extraEnv: { VERA_HOME: target } });
            expect(result.exitCode).not.toBe(0);
            expect(scenario.output(result)).toMatch(/home directory.*ancestors.*nothing was removed/i);
            expect(readFileSync(join(scenario.home, "Documents", "note.txt"), "utf8")).toBe("home data\n");
            expect(readFileSync(join(scenario.veraHome, "settings.json"), "utf8")).toBe("settings\n");
            for (const path of [scenario.root, scenario.launcher, scenario.share, scenario.app, scenario.veraHome]) {
                expect(existsSync(path)).toBe(true);
            }
            expect(readFileSync(scenario.log, "utf8")).toBe("");
            expect(archives(scenario.home)).toEqual([]);
        });
    }
});

test("ancestor detection resolves a symlinked scratch HOME", () => {
    withScenario((scenario) => {
        const alias = join(scenario.root, "home-alias");
        symlinkSync(scenario.home, alias);
        const result = scenario.run({
            automated: true,
            backup: "no",
            extraEnv: { HOME: alias, VERA_HOME: scenario.root },
        });
        expect(result.exitCode).not.toBe(0);
        expect(scenario.output(result)).toMatch(/ancestors.*nothing was removed/i);
        expect(existsSync(join(scenario.home, "Documents", "note.txt"))).toBe(true);
        expect(existsSync(scenario.launcher)).toBe(true);
        expect(existsSync(scenario.share)).toBe(true);
        expect(existsSync(scenario.veraHome)).toBe(true);
        expect(readFileSync(scenario.log, "utf8")).toBe("");
    });
});

test("a sibling with a HOME prefix is not treated as an ancestor", () => {
    withScenario((scenario) => {
        const sibling = join(scenario.root, "user-home-sibling");
        renameSync(scenario.veraHome, sibling);
        const result = scenario.run({ automated: true, backup: "no", extraEnv: { VERA_HOME: sibling } });
        expect(result.exitCode, scenario.output(result)).toBe(0);
        expect(existsSync(sibling)).toBe(false);
        expect(readFileSync(join(scenario.home, "Documents", "note.txt"), "utf8")).toBe("home data\n");
    });
});

test("a symlinked home with a trailing slash is not removed", () => {
    withScenario((scenario) => {
        const target = join(scenario.root, "home-target");
        renameSync(scenario.veraHome, target);
        symlinkSync(target, scenario.veraHome);
        const result = scenario.run({ automated: true, backup: "no", extraEnv: { VERA_HOME: `${scenario.veraHome}/` } });
        expect(result.exitCode).not.toBe(0);
        expect(scenario.output(result)).toMatch(/symlink/i);
        expect(existsSync(join(target, "settings.json"))).toBe(true);
        expect(existsSync(scenario.launcher)).toBe(true);
    });
});

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cliRequiresMigratedHome } from "../clients/cli/main.ts";

const CLI = fileURLToPath(new URL("../clients/cli/main.ts", import.meta.url));
const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryHome(): string {
    const home = join(mkdtempSync(join(tmpdir(), "vera-migrate-cli-")), ".vera");
    temporaryDirectories.push(home);
    mkdirSync(join(home, "machine"), { recursive: true });
    mkdirSync(join(home, "profiles", "default", "memory"), { recursive: true });
    mkdirSync(join(home, "profiles", "other"), { recursive: true });
    writeFileSync(join(home, "machine", "auth.json"), "{}");
    writeFileSync(join(home, "profiles", "default", "config.json"), "default-config");
    writeFileSync(join(home, "profiles", "default", "memory", "note.md"), "keep me");
    writeFileSync(join(home, "profiles", "other", "config.json"), "other-config");
    return home;
}

function runCli(home: string, args: readonly string[]): {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
} {
    const result = Bun.spawnSync({
        cmd: ["bun", CLI, ...args],
        env: { ...process.env, VERA_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

test("--help and migrate-home skip the unmigrated-home refuse", () => {
    expect(cliRequiresMigratedHome([])).toBe(true);
    expect(cliRequiresMigratedHome(["ls"])).toBe(true);
    expect(cliRequiresMigratedHome(["migrate-home"])).toBe(false);
    expect(cliRequiresMigratedHome(["--yes", "migrate-home"])).toBe(false);
    expect(cliRequiresMigratedHome(["--help"])).toBe(false);
    expect(cliRequiresMigratedHome(["help"])).toBe(false);
    expect(cliRequiresMigratedHome(["ls", "--help"])).toBe(false);
    expect(cliRequiresMigratedHome(["-p", "-h"])).toBe(true);
    expect(cliRequiresMigratedHome(["--version"])).toBe(false);
});

test("vera ls refuses an unmigrated home and names migrate-home", () => {
    const home = temporaryHome();
    const result = runCli(home, ["ls"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("still uses the profiles/ layout");
    expect(result.stderr).toContain("vera migrate-home");
});

test("vera migrate-home lifts default from an unmigrated home", () => {
    const home = temporaryHome();
    const result = runCli(home, ["migrate-home"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Other profiles kept in backup: other");
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("default-config");
    expect(readFileSync(join(home, "memory", "note.md"), "utf8")).toBe("keep me");
    expect(readdirSync(home).includes("profiles")).toBe(false);
});

import { expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installer = resolve(import.meta.dir, "..", "install");

function executable(path: string, body: string): void {
    writeFileSync(path, body);
    chmodSync(path, 0o755);
}

function fakeCommands(
    directory: string,
    npmBody: string,
    bunVersion = "1.3.6",
): void {
    mkdirSync(directory);
    executable(
        join(directory, "bun"),
        `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo ${bunVersion}; exit 0; fi
exit 0
`,
    );
    executable(join(directory, "npm"), `#!/bin/sh
${npmBody}
`);
}

function successfulNpm(version: string, record?: string): string {
    return `${record === undefined ? "" : `printf '%s\\n' "$@" > '${record}'`}
prefix=
while [ "$#" -gt 0 ]; do
    if [ "$1" = "--prefix" ]; then prefix=$2; shift 2; else shift; fi
done
package="$prefix/lib/node_modules/@nashaad/vera"
mkdir -p "$package/bin" "$prefix/bin"
printf '%s\\n' '#!/bin/sh' 'echo vera ${version}' > "$package/bin/vera"
chmod 755 "$package/bin/vera"
ln -s ../lib/node_modules/@nashaad/vera/bin/vera "$prefix/bin/vera"
`;
}

function installEnvironment(
    home: string,
    commands: string,
    prefix: string,
    extra: Record<string, string> = {},
): Record<string, string> {
    return {
        HOME: home,
        PATH: `${commands}:/usr/bin:/bin`,
        VERA_INSTALL_PREFIX: prefix,
        ...extra,
    };
}

test("npm installer stages, validates, activates, and safely repeats", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-install-"));
    const commands = join(root, "commands");
    const home = join(root, "home");
    const prefix = join(home, ".local");
    const record = join(root, "npm-args");
    mkdirSync(home);
    fakeCommands(commands, successfulNpm("1.2.3", record));

    try {
        const env = installEnvironment(home, commands, prefix, {
            VERA_INSTALL_VERSION: "v1.2.3",
        });
        const first = Bun.spawnSync(["/bin/sh", installer], {
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(first.exitCode).toBe(0);
        expect(first.stdout?.toString()).toContain("Installed vera 1.2.3");
        expect(readlinkSync(join(prefix, "bin", "vera"))).toBe(
            "../lib/node_modules/@nashaad/vera/bin/vera",
        );
        expect(readFileSync(record, "utf8")).toContain("--ignore-scripts\n");
        expect(readFileSync(record, "utf8")).toContain("--registry\n");
        expect(readFileSync(record, "utf8")).toContain("https://registry.npmjs.org\n");
        expect(readFileSync(record, "utf8")).toContain("--\n@nashaad/vera@1.2.3\n");

        const second = Bun.spawnSync(["/bin/sh", installer], {
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(second.exitCode).toBe(0);
        expect(second.stdout?.toString()).toContain("Installed vera 1.2.3");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("failed npm staging preserves the legacy executable", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-rollback-"));
    const commands = join(root, "commands");
    const home = join(root, "home");
    const prefix = join(home, ".local");
    const legacy = join(home, ".local", "share", "vera", "current", "bin");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(legacy, { recursive: true });
    executable(join(legacy, "vera"), "#!/bin/sh\necho vera legacy\n");
    symlinkSync(join(legacy, "vera"), join(prefix, "bin", "vera"));
    fakeCommands(commands, "exit 42");

    try {
        const result = Bun.spawnSync(["/bin/sh", installer], {
            env: installEnvironment(home, commands, prefix),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.exitCode).not.toBe(0);
        expect(readlinkSync(join(prefix, "bin", "vera"))).toBe(join(legacy, "vera"));
        expect(Bun.spawnSync([join(prefix, "bin", "vera")]).stdout?.toString())
            .toBe("vera legacy\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("version mismatch never replaces the installed package or command", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-version-rollback-"));
    const commands = join(root, "commands");
    const home = join(root, "home");
    const prefix = join(home, ".local");
    const currentPackage = join(prefix, "lib", "node_modules", "@nashaad", "vera");
    mkdirSync(join(currentPackage, "bin"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    executable(join(currentPackage, "bin", "vera"), "#!/bin/sh\necho vera 1.2.2\n");
    symlinkSync("../lib/node_modules/@nashaad/vera/bin/vera", join(prefix, "bin", "vera"));
    fakeCommands(commands, successfulNpm("1.2.2"));

    try {
        const result = Bun.spawnSync(["/bin/sh", installer], {
            env: installEnvironment(home, commands, prefix, {
                VERA_INSTALL_VERSION: "1.2.3",
            }),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr?.toString()).toContain("does not match 1.2.3");
        expect(Bun.spawnSync([join(prefix, "bin", "vera")]).stdout?.toString())
            .toBe("vera 1.2.2\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("custom package specs cannot become npm options", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-option-boundary-"));
    const commands = join(root, "commands");
    const home = join(root, "home");
    const prefix = join(home, ".local");
    const record = join(root, "npm-args");
    mkdirSync(home);
    fakeCommands(commands, successfulNpm("1.2.3", record));

    try {
        const result = Bun.spawnSync(["/bin/sh", installer], {
            env: installEnvironment(home, commands, prefix, {
                VERA_NPM_PACKAGE: "--ignore-scripts=false",
            }),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        expect(readFileSync(record, "utf8")).toContain(
            "--\n--ignore-scripts=false\n",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("installer enforces Bun, ownership, prefix, and shadow boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-npm-boundaries-"));
    const commands = join(root, "commands");
    const home = join(root, "home");
    const prefix = join(home, ".local");
    mkdirSync(home);
    fakeCommands(commands, successfulNpm("1.2.3"), "1.3.5");

    try {
        const oldBun = Bun.spawnSync(["/bin/sh", installer], {
            env: installEnvironment(home, commands, prefix),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(oldBun.exitCode).not.toBe(0);
        expect(oldBun.stderr?.toString()).toContain("Bun 1.3.6 or newer");

        executable(join(commands, "bun"), "#!/bin/sh\necho 1.3.6\n");
        mkdirSync(join(prefix, "bin"), { recursive: true });
        writeFileSync(join(prefix, "bin", "vera"), "foreign\n");
        const foreign = Bun.spawnSync(["/bin/sh", installer], {
            env: installEnvironment(home, commands, prefix),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(foreign.exitCode).not.toBe(0);
        expect(foreign.stderr?.toString()).toContain("refusing to replace existing");

        const unsafe = Bun.spawnSync(["/bin/sh", installer], {
            env: installEnvironment(home, commands, "/usr/local"),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(unsafe.exitCode).not.toBe(0);
        expect(unsafe.stderr?.toString()).toContain("unsafe install prefix");

        expect(existsSync(join(prefix, ".vera-install.lock"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

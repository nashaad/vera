#!/usr/bin/env bun

import {
    chmodSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PACKAGE_NAME = "@nashaad/vera";
const REPOSITORY_URL = "git+https://github.com/nashaad/vera.git";
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RUNTIME_ENTRIES = [
    "clients",
    "config",
    "extensions",
    "src",
    "index.ts",
    "tsconfig.json",
    "bunfig.toml",
] as const;

function fail(message: string): never {
    console.error(`vera npm package: ${message}`);
    process.exit(1);
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lockedDependencies(
    dependencies: Readonly<Record<string, string>>,
    lockfile: string,
): Record<string, string> {
    return Object.fromEntries(Object.keys(dependencies).sort().map((name) => {
        const escaped = escapeRegularExpression(name);
        const match = lockfile.match(
            new RegExp(`^\\s*"${escaped}": \\["${escaped}@([^"\\s]+)"`, "m"),
        );
        const resolved = match?.[1];
        if (resolved === undefined) fail(`bun.lock has no resolved version for ${name}`);
        if (!STABLE_VERSION.test(resolved)) {
            fail(`bun.lock has a non-registry version for ${name}: ${resolved}`);
        }
        return [name, resolved];
    }));
}

function rejectSymlinks(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`runtime input contains a symlink: ${path}`);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) rejectSymlinks(join(path, entry));
}

function run(command: string[], options: Parameters<typeof Bun.spawnSync>[1] = {}): void {
    const result = Bun.spawnSync(command, {
        stdout: "pipe",
        stderr: "pipe",
        ...options,
    });
    if (result.exitCode === 0) return;
    if (result.stdout !== undefined) process.stderr.write(result.stdout);
    if (result.stderr !== undefined) process.stderr.write(result.stderr);
    fail(`command failed: ${command.join(" ")}`);
}

const [version, outputArgument] = Bun.argv.slice(2);
if (version === undefined || outputArgument === undefined) {
    fail("usage: scripts/build-npm-package.ts <version> <output-directory>");
}
if (!STABLE_VERSION.test(version)) fail(`invalid stable version: ${version}`);

const root = resolve(import.meta.dir, "..");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "vera-npm-package-"));
const stage = join(temporary, "package");
const archivedSource = join(temporary, "source");
mkdirSync(stage);

try {
    const sourceOverride = process.env.VERA_NPM_SOURCE_ROOT;
    let sourceRoot: string;
    if (sourceOverride !== undefined) {
        sourceRoot = resolve(sourceOverride);
    } else {
        mkdirSync(archivedSource);
        const sourceArchive = join(temporary, "source.tar");
        run(["git", "-C", root, "archive", "--format=tar", `--output=${sourceArchive}`, "HEAD"]);
        run(["tar", "-xf", sourceArchive, "-C", archivedSource]);
        sourceRoot = archivedSource;
    }

    for (const entry of RUNTIME_ENTRIES) {
        const source = join(sourceRoot, entry);
        if (!existsSync(source)) fail(`runtime entry is missing: ${entry}`);
        rejectSymlinks(source);
        cpSync(source, join(stage, entry), { recursive: true, errorOnExist: true });
    }

    const launcher = join(sourceRoot, "scripts", "npm-launcher.sh");
    if (!existsSync(launcher)) fail("npm launcher is missing from the release source");
    rejectSymlinks(launcher);
    mkdirSync(join(stage, "bin"));
    cpSync(launcher, join(stage, "bin", "vera"));
    chmodSync(join(stage, "bin", "vera"), 0o755);
    writeFileSync(join(stage, "VERSION"), `${version}\n`);

    const sourcePackage = JSON.parse(
        readFileSync(join(sourceRoot, "package.json"), "utf8"),
    ) as { readonly dependencies?: Record<string, string> };
    if (sourcePackage.dependencies === undefined) {
        fail("source package.json has no runtime dependencies");
    }
    const dependencies = lockedDependencies(
        sourcePackage.dependencies,
        readFileSync(join(sourceRoot, "bun.lock"), "utf8"),
    );
    const publishedPackage = {
        name: PACKAGE_NAME,
        version,
        description: "Vera agent runtime and terminal client",
        type: "module",
        module: "./index.ts",
        exports: "./index.ts",
        bin: { vera: "./bin/vera" },
        repository: { type: "git", url: REPOSITORY_URL },
        engines: { bun: ">=1.3.6" },
        os: ["darwin", "linux"],
        cpu: ["arm64", "x64"],
        dependencies,
        publishConfig: {
            access: "public",
            registry: "https://registry.npmjs.org",
        },
    };
    writeFileSync(
        join(stage, "package.json"),
        JSON.stringify(publishedPackage, null, 2) + "\n",
    );

    const suppliedShrinkwrap = process.env.VERA_NPM_SHRINKWRAP_SOURCE;
    if (suppliedShrinkwrap !== undefined) {
        const shrinkwrap = JSON.parse(readFileSync(resolve(suppliedShrinkwrap), "utf8")) as {
            name?: string;
            version?: string;
            packages?: Record<string, Record<string, unknown>>;
        };
        shrinkwrap.name = PACKAGE_NAME;
        shrinkwrap.version = version;
        shrinkwrap.packages ??= {};
        shrinkwrap.packages[""] = {
            name: PACKAGE_NAME,
            version,
            dependencies,
            engines: { bun: ">=1.3.6" },
            os: ["darwin", "linux"],
            cpu: ["arm64", "x64"],
        };
        writeFileSync(
            join(stage, "npm-shrinkwrap.json"),
            JSON.stringify(shrinkwrap, null, 2) + "\n",
        );
    } else {
        const npmCache = join(temporary, "npm-cache");
        run(
            [
                "npm",
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--registry=https://registry.npmjs.org",
            ],
            {
                cwd: stage,
                env: { ...process.env, npm_config_cache: npmCache },
            },
        );
        renameSync(
            join(stage, "package-lock.json"),
            join(stage, "npm-shrinkwrap.json"),
        );
    }

    const pack = Bun.spawnSync(
        [
            "npm",
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            output,
            stage,
        ],
        {
            cwd: root,
            env: {
                ...process.env,
                npm_config_cache: join(temporary, "npm-cache"),
            },
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    if (pack.exitCode !== 0) {
        if (pack.stderr !== undefined) process.stderr.write(pack.stderr);
        fail("npm pack failed");
    }
    const result = JSON.parse(pack.stdout?.toString() ?? "[]") as Array<{ filename: string }>;
    const filename = result[0]?.filename;
    if (filename === undefined) fail("npm pack returned no package filename");
    console.log(join(output, basename(filename)));
} finally {
    rmSync(temporary, { recursive: true, force: true });
}

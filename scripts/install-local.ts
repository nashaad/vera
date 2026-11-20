#!/usr/bin/env bun

import {
    describeDesktopOutcome,
    installLocalDesktop,
    isDesktopPrefix,
    type LocalDesktopOutcome,
    type LocalDesktopSettings,
} from "./install-local-desktop.ts";
import { packRunnableRelease, type InstallReleaseOptions as PackOptions } from "./pack-release.ts";
import { defaultInstallPrefix } from "../src/release/layout.ts";
import {
    installRelease,
    type InstallOutcome,
    type InstallReleaseOptions,
} from "../src/release/install.ts";

export type InstallLocalOptions = PackOptions & Partial<Pick<
    InstallReleaseOptions,
    "pack" | "verify" | "readLiveHost" | "handOff" | "report"
>> & {
    // Skips the desktop app. It is also skipped everywhere but macOS, and for any prefix but ~/.local.
    readonly noDesktop?: boolean;
    readonly desktop?: LocalDesktopSettings;
};

export interface InstallLocalResult {
    readonly outcome: InstallOutcome;
    // Undefined when the desktop step did not run.
    readonly desktop: LocalDesktopOutcome | undefined;
}

// Pack and verify, then activate at once when no host runs. With a host running,
// the host moves current once its running turns end. On macOS the desktop package for the
// packed build is installed before that, so current never names a build without one.
export async function installLocal(
    options: InstallLocalOptions = {},
): Promise<InstallLocalResult> {
    const prefix = options.prefix ?? defaultInstallPrefix();
    const wanted = options.noDesktop !== true && (options.desktop?.platform ?? process.platform) === "darwin";
    const withDesktop = wanted && isDesktopPrefix(prefix, options.desktop?.home);
    const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
    const pack = options.pack ?? (() => packRunnableRelease({
        prefix: options.prefix,
        cwd: options.cwd,
        sourceRoot: options.sourceRoot,
        force: options.force,
    }));
    let desktop: LocalDesktopOutcome | undefined = wanted && !withDesktop ? { kind: "other_prefix" } : undefined;
    const outcome = await installRelease({
        prefix,
        pack: async () => {
            const packed = await pack();
            if (withDesktop) {
                desktop = await installLocalDesktop({
                    ...options.desktop,
                    prefix,
                    buildId: packed.manifest.build_id,
                    report,
                });
            }
            return packed;
        },
        report,
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.readLiveHost === undefined ? {} : { readLiveHost: options.readLiveHost }),
        ...(options.handOff === undefined ? {} : { handOff: options.handOff }),
    });
    return { outcome, desktop };
}

function fail(message: string): never {
    console.error(`vera install:local: ${message}`);
    process.exit(1);
}

function parseArgs(argv: readonly string[]): {
    readonly prefix: string | undefined;
    readonly force: boolean;
    readonly noDesktop: boolean;
} {
    let force = false;
    let noDesktop = false;
    let prefix: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--force") {
            force = true;
            continue;
        }
        if (arg === "--no-desktop") {
            noDesktop = true;
            continue;
        }
        if (arg === "--prefix") {
            prefix = argv[++i];
            if (prefix === undefined || prefix.length === 0) {
                fail("missing --prefix path");
            }
            continue;
        }
        if (arg?.startsWith("-")) {
            fail(`unknown flag: ${arg}`);
        }
        fail("usage: bun run install:local [--prefix DIR] [--force] [--no-desktop]");
    }
    return { prefix, force, noDesktop };
}

function printOutcome(outcome: InstallOutcome): number {
    switch (outcome.kind) {
        case "activated":
            process.stdout.write(`${outcome.releaseRoot}\n`);
            process.stdout.write(`${outcome.launcher}\n`);
            process.stdout.write(`${outcome.buildId}\n`);
            if (outcome.fromBuildId !== null) {
                process.stderr.write(
                    `vera install:local: activated ${outcome.buildId} (was ${outcome.fromBuildId})\n`,
                );
            }
            return 0;
        case "updated":
            process.stdout.write(`vera install:local: the running host moved to ${outcome.buildId}\n`);
            return 0;
        case "accepted":
            process.stdout.write(
                `vera install:local: ${outcome.buildId} is unpacked. The running host moves to it when its running turns end.\n`,
            );
            return 0;
        case "restored":
        case "no_host_started":
            process.stderr.write(`vera install:local: ${outcome.message}\n`);
            return 1;
        case "not_moved":
            process.stderr.write(`vera install:local: ${outcome.message}\n`);
            return 1;
    }
}

function printDesktop(desktop: LocalDesktopOutcome | undefined): number {
    if (desktop === undefined) return 0;
    const { line, failure } = describeDesktopOutcome(desktop);
    (failure ? process.stderr : process.stdout).write(`${line}\n`);
    return failure ? 1 : 0;
}

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        const result = await installLocal({
            force: args.force,
            noDesktop: args.noDesktop,
            ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
        });
        process.exitCode = Math.max(printOutcome(result.outcome), printDesktop(result.desktop));
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}

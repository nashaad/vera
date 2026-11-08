#!/usr/bin/env bun

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
>>;

// Pack and verify, then activate at once when no host runs. With a host running,
// the host moves current once its running turns end.
export async function installLocal(
    options: InstallLocalOptions = {},
): Promise<InstallOutcome> {
    return installRelease({
        prefix: options.prefix ?? defaultInstallPrefix(),
        pack: options.pack ?? (() => packRunnableRelease({
            prefix: options.prefix,
            cwd: options.cwd,
            sourceRoot: options.sourceRoot,
            force: options.force,
        })),
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.readLiveHost === undefined ? {} : { readLiveHost: options.readLiveHost }),
        ...(options.handOff === undefined ? {} : { handOff: options.handOff }),
        ...(options.report === undefined ? {} : { report: options.report }),
    });
}

function fail(message: string): never {
    console.error(`vera install:local: ${message}`);
    process.exit(1);
}

function parseArgs(argv: readonly string[]): {
    readonly prefix: string | undefined;
    readonly force: boolean;
} {
    let force = false;
    let prefix: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--force") {
            force = true;
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
        fail("usage: bun run install:local [--prefix DIR] [--force]");
    }
    return { prefix, force };
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

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        const outcome = await installLocal({
            force: args.force,
            ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
        });
        process.exitCode = printOutcome(outcome);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}

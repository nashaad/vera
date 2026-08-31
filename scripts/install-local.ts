#!/usr/bin/env bun

import { packRunnableRelease, type InstallReleaseOptions } from "./pack-release.ts";
import {
    upgradeLocalInstall,
    type UpgradeLocalOptions,
    type UpgradedLocal,
} from "../src/release/upgrade.ts";

export type InstallLocalOptions = InstallReleaseOptions & Pick<
    UpgradeLocalOptions,
    "pack" | "verify" | "drainHost" | "startHost"
>;

/**
 * Pack, verify, drain, activate, and restart as one command. Does not write
 * user data under ~/.vera except stopping and starting the resident host.
 */
export async function installLocal(
    options: InstallLocalOptions = {},
): Promise<UpgradedLocal> {
    return upgradeLocalInstall({
        prefix: options.prefix,
        pack: options.pack ?? (() => packRunnableRelease({
            prefix: options.prefix,
            cwd: options.cwd,
            sourceRoot: options.sourceRoot,
            force: options.force,
        })),
        ...(options.verify === undefined ? {} : { verify: options.verify }),
        ...(options.drainHost === undefined ? {} : { drainHost: options.drainHost }),
        ...(options.startHost === undefined ? {} : { startHost: options.startHost }),
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

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        const result = await installLocal({
            force: args.force,
            ...(args.prefix === undefined ? {} : { prefix: args.prefix }),
        });
        process.stdout.write(`${result.releaseRoot}\n`);
        process.stdout.write(`${result.launcher}\n`);
        process.stdout.write(`${result.manifest.build_id}\n`);
        if (result.fromBuildId !== null) {
            process.stderr.write(
                `vera install:local: activated ${result.manifest.build_id}`
                    + ` (was ${result.fromBuildId})\n`,
            );
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}

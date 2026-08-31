import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    RELEASE_ANNEX_NAME,
    RELEASE_BUN_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
} from "./layout.ts";

export interface ReleaseWrapperSources {
    readonly cli: string;
    readonly host: string;
    readonly worker: string;
    readonly annex: string;
    readonly supervisor: string;
}

export function releaseSourceEntries(sourceRoot: string): ReleaseWrapperSources {
    return {
        cli: join(sourceRoot, "clients", "cli", "main.ts"),
        host: join(sourceRoot, "clients", "host", "main.ts"),
        worker: join(sourceRoot, "src", "host", "worker", "entry.ts"),
        annex: join(sourceRoot, "src", "annex", "main.ts"),
        supervisor: join(sourceRoot, "src", "host", "worker-supervisor.ts"),
    };
}

/**
 * Wrappers at the release root. Each one execs the release bun against a
 * TypeScript entry inside that same release. Spawners use these paths, never
 * `bun` from PATH.
 */
export function writeSelfContainedWrappers(releaseRoot: string): void {
    const bun = `"$here/${RELEASE_BUN_NAME}"`;
    writeWrapper(join(releaseRoot, RELEASE_CLI_NAME), bun, `"$here/clients/cli/main.ts"`);
    writeWrapper(join(releaseRoot, RELEASE_HOST_NAME), bun, `"$here/clients/host/main.ts"`);
    writeWrapper(
        join(releaseRoot, RELEASE_WORKER_NAME),
        bun,
        `"$here/src/host/worker/entry.ts"`,
    );
    writeWrapper(
        join(releaseRoot, RELEASE_ANNEX_NAME),
        bun,
        `"$here/src/annex/main.ts"`,
    );
    writeWrapper(
        join(releaseRoot, RELEASE_SUPERVISOR_NAME),
        bun,
        `"$here/src/host/worker-supervisor.ts"`,
    );
}

/**
 * Wrappers that point at an external bun and source tree. Tests use this so
 * in-process hosts can spawn helpers without packing a full release.
 */
export function writeExternalWrappers(
    releaseRoot: string,
    bunPath: string,
    sources: ReleaseWrapperSources,
): void {
    const bun = shellSingleQuote(bunPath);
    writeWrapper(join(releaseRoot, RELEASE_CLI_NAME), bun, shellSingleQuote(sources.cli));
    writeWrapper(join(releaseRoot, RELEASE_HOST_NAME), bun, shellSingleQuote(sources.host));
    writeWrapper(
        join(releaseRoot, RELEASE_WORKER_NAME),
        bun,
        shellSingleQuote(sources.worker),
    );
    writeWrapper(
        join(releaseRoot, RELEASE_ANNEX_NAME),
        bun,
        shellSingleQuote(sources.annex),
    );
    writeWrapper(
        join(releaseRoot, RELEASE_SUPERVISOR_NAME),
        bun,
        shellSingleQuote(sources.supervisor),
    );
}

function writeWrapper(path: string, bun: string, entry: string): void {
    writeFileSync(
        path,
        `#!/bin/sh\n`
            + `set -eu\n`
            + `here=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)\n`
            + `exec ${bun} ${entry} "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(path, 0o755);
}

function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

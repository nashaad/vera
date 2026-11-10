import { chmodSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
    RELEASE_ANNEX_NAME,
    RELEASE_BUN_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
} from "./layout.ts";
import { RELAUNCH_EXIT_CODE, RELAUNCH_LAUNCHER_ENV } from "./relaunch.ts";

export interface ReleaseWrapperSources {
    readonly cli: string;
    readonly host: string;
    readonly worker: string;
    readonly sessionWorker: string;
    readonly annex: string;
    readonly supervisor: string;
}

export function releaseSourceEntries(sourceRoot: string): ReleaseWrapperSources {
    return {
        cli: join(sourceRoot, "clients", "cli", "main.ts"),
        host: join(sourceRoot, "clients", "host", "main.ts"),
        worker: join(sourceRoot, "src", "host", "worker", "entry.ts"),
        sessionWorker: join(sourceRoot, "clients", "host", "session-worker.ts"),
        annex: join(sourceRoot, "src", "annex", "main.ts"),
        supervisor: join(sourceRoot, "src", "host", "worker-supervisor.ts"),
    };
}

export function writeSelfContainedWrappers(releaseRoot: string): void {
    const bun = `"$here/${RELEASE_BUN_NAME}"`;
    writeLauncher(join(releaseRoot, RELEASE_CLI_NAME), {
        bun: `"$release/bun"`,
        entry: `"$release/bundle/clients/cli/main.js"`,
        relocatable: true,
    });
    writeWrapper(join(releaseRoot, RELEASE_HOST_NAME), bun, `"$here/bundle/clients/host/main.js"`);
    writeWrapper(
        join(releaseRoot, RELEASE_WORKER_NAME),
        bun,
        `"$here/bundle/src/host/worker/entry.js"`,
    );
    writeWrapper(join(releaseRoot, RELEASE_SESSION_WORKER_NAME), bun, `"$here/bundle/clients/host/session-worker.js"`);
    writeWrapper(
        join(releaseRoot, RELEASE_ANNEX_NAME),
        bun,
        `"$here/bundle/src/annex/main.js"`,
    );
    writeWrapper(
        join(releaseRoot, RELEASE_SUPERVISOR_NAME),
        bun,
        `"$here/bundle/src/host/worker-supervisor.js"`,
    );
}

export function writeExternalWrappers(
    releaseRoot: string,
    bunPath: string,
    sources: ReleaseWrapperSources,
): void {
    const bun = shellSingleQuote(bunPath);
    writeLauncher(join(releaseRoot, RELEASE_CLI_NAME), {
        bun: shellSingleQuote(bunPath),
        entry: shellSingleQuote(sources.cli),
        relocatable: false,
    });
    writeWrapper(join(releaseRoot, RELEASE_HOST_NAME), bun, shellSingleQuote(sources.host));
    writeWrapper(
        join(releaseRoot, RELEASE_WORKER_NAME),
        bun,
        shellSingleQuote(sources.worker),
    );
    writeWrapper(join(releaseRoot, RELEASE_SESSION_WORKER_NAME), bun, shellSingleQuote(sources.sessionWorker));
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

// The top-level wrapper files writeCheckoutPackWrappers creates.
export const CHECKOUT_PACK_WRAPPER_NAMES: readonly string[] = [
    RELEASE_WORKER_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_ANNEX_NAME,
    RELEASE_SUPERVISOR_NAME,
];

export function writeCheckoutPackWrappers(
    releaseRoot: string,
    bunPath: string,
    sources: Pick<ReleaseWrapperSources, "worker" | "sessionWorker" | "annex" | "supervisor">,
): void {
    const bun = shellSingleQuote(bunPath);
    writeWrapper(
        join(releaseRoot, RELEASE_WORKER_NAME),
        bun,
        shellSingleQuote(sources.worker),
    );
    writeWrapper(join(releaseRoot, RELEASE_SESSION_WORKER_NAME), bun, shellSingleQuote(sources.sessionWorker));
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

interface LauncherTarget {
    readonly bun: string;
    readonly entry: string;
    // A relocatable launcher re-resolves `current` after a relaunch exit.
    readonly relocatable: boolean;
}

// The CLI launcher stays a shell so a TUI can ask for a restart into the new build
// in the same terminal. Bun has no in-place exec. Only the relaunch code loops; any
// other status ends the loop with that status. Ctrl+C reaches the child in the
// foreground and the shell ignores it.
function writeLauncher(path: string, target: LauncherTarget): void {
    const resolve = target.relocatable
        ? `    release=$(CDPATH= cd -P -- "$root/current" 2>/dev/null && pwd) || release=$here\n`
        : "";
    const setup = target.relocatable
        ? `here=$(CDPATH= cd -P -- "\${0%/*}" && pwd)\n`
            + `root=\${here%/*/*}\n`
            + `release=$here\n`
        : `here=$(CDPATH= cd -P -- "\${0%/*}" && pwd)\n`;
    writeFileSync(
        path,
        `#!/bin/sh\n`
            + setup
            + `stop=0\n`
            + `named=0\n`
            + `if (exec -a vera true) 2>/dev/null; then named=1; fi\n`
            + `trap ':' INT\n`
            + `trap 'stop=1' TERM HUP\n`
            + `while :; do\n`
            + `    if [ "$named" -eq 1 ]; then\n`
            + `        ( ${RELAUNCH_LAUNCHER_ENV}=$$ exec -a vera ${target.bun} ${target.entry} "$@" )\n`
            + `    else\n`
            + `        ${RELAUNCH_LAUNCHER_ENV}=$$ ${target.bun} ${target.entry} "$@"\n`
            + `    fi\n`
            + `    code=$?\n`
            + `    if [ "$code" -ne ${RELAUNCH_EXIT_CODE} ] || [ "$stop" -ne 0 ]; then\n`
            + `        exit "$code"\n`
            + `    fi\n`
            + resolve
            + `done\n`,
        { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(path, 0o755);
}

function writeWrapper(path: string, bun: string, entry: string): void {
    // ps names the process after argv[0]; a plain exec would show bun.
    const name = shellSingleQuote(basename(path));
    writeFileSync(
        path,
        `#!/bin/sh\n`
            + `set -eu\n`
            + `here=$(CDPATH= cd -P -- "\${0%/*}" && pwd)\n`
            + `if (exec -a x true) 2>/dev/null; then\n`
            + `    exec -a ${name} ${bun} ${entry} "$@"\n`
            + `fi\n`
            + `exec ${bun} ${entry} "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(path, 0o755);
}

function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

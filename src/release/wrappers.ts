import { chmodSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TERMINAL_RESTORE_SEQUENCE, TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE } from "../terminal-restore-sequence.ts";

import {
    RELEASE_ANNEX_NAME,
    RELEASE_CLI_NAME,
    RELEASE_HOST_NAME,
    RELEASE_SESSION_WORKER_NAME,
    RELEASE_SUPERVISOR_NAME,
    RELEASE_WORKER_NAME,
} from "./layout.ts";
import { RELAUNCH_EXIT_CODE, RELAUNCH_LAUNCHER_ENV, RELAUNCH_RESTORE_ARG } from "./relaunch.ts";

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
    const executable = `"$here/vera-bin"`;
    writeLauncher(join(releaseRoot, RELEASE_CLI_NAME), {
        bun: `"$release/vera-bin"`,
        entry: "--vera-role=cli",
        relocatable: true,
    });
    writeWrapper(join(releaseRoot, RELEASE_HOST_NAME), executable, "--vera-role=host");
    writeWrapper(join(releaseRoot, RELEASE_WORKER_NAME), executable, "--vera-role=worker");
    writeWrapper(join(releaseRoot, RELEASE_SESSION_WORKER_NAME), executable, "--vera-role=session-worker");
    writeWrapper(join(releaseRoot, RELEASE_ANNEX_NAME), executable, "--vera-role=annex");
    writeWrapper(join(releaseRoot, RELEASE_SUPERVISOR_NAME), executable, "--vera-role=supervisor");
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
    const restoreSequence = TERMINAL_RESTORE_SEQUENCE.replaceAll("\x1b", "\\033");
    const relaunchRestoreSequence = TERMINAL_RESTORE_WITHOUT_KITTY_SEQUENCE.replaceAll("\x1b", "\\033");
    writeFileSync(
        path,
        `#!/bin/sh\n`
            + setup
            + `stop=0\n`
            + `relaunched=0\n`
            + `saved_tty=\n`
            + `if [ -t 0 ]; then saved_tty=$(stty -g <&0 2>/dev/null) || saved_tty=; fi\n`
            + `named=0\n`
            + `if (exec -a vera true) 2>/dev/null; then named=1; fi\n`
            + `trap ':' INT\n`
            + `trap 'stop=1' TERM HUP\n`
            + `base_node_path=\${NODE_PATH-}\n`
            + `while :; do\n`
            + (target.relocatable ? `    NODE_PATH="$release/node_modules\${base_node_path:+:$base_node_path}"; export NODE_PATH\n` : "")
            + `    if [ "$named" -eq 1 ]; then\n`
            + `        ( ${RELAUNCH_LAUNCHER_ENV}=$$ exec -a vera ${target.bun} ${target.entry} "$@" )\n`
            + `    else\n`
            + `        ${RELAUNCH_LAUNCHER_ENV}=$$ ${target.bun} ${target.entry} "$@"\n`
            + `    fi\n`
            + `    code=$?\n`
            + `    if [ "$code" -gt 128 ] && [ "$code" -ne 129 ] && [ "$code" -ne 131 ] && [ "$code" -ne 143 ]; then\n`
            + `        if [ -n "$saved_tty" ]; then stty "$saved_tty" <&0 2>/dev/null || :; fi\n`
            + `        if [ -t 1 ]; then printf '%b' '${restoreSequence}'; fi\n`
            + `    elif [ "$relaunched" -eq 1 ] && [ "$code" -ne ${RELAUNCH_EXIT_CODE} ]; then\n`
            + `        if [ -n "$saved_tty" ]; then stty "$saved_tty" <&0 2>/dev/null || :; fi\n`
            + `        ${target.bun} ${target.entry} ${RELAUNCH_RESTORE_ARG} "$$"\n`
            + `        helper_code=$?\n`
            + `        # 0 means the helper restored or had nothing to restore; any other status leaves it to this script.\n`
            + `        if [ "$helper_code" -ne 0 ]; then\n`
            + `            if [ -t 1 ]; then printf '%b' '${relaunchRestoreSequence}'; fi\n`
            + `        fi\n`
            + `    fi\n`
            + `    if [ "$code" -ne ${RELAUNCH_EXIT_CODE} ] || [ "$stop" -ne 0 ]; then\n`
            + `        exit "$code"\n`
            + `    fi\n`
            + `    relaunched=1\n`
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
            + (bun.includes("vera-bin") ? `NODE_PATH="$here/node_modules\${NODE_PATH:+:$NODE_PATH}"; export NODE_PATH\n` : "")
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

import {
    installedBuildAtPrefix,
    installedBuildMismatch,
    type InstalledBuildMismatch,
} from "../../shared/installed-build.ts";
import { runningDesktopShell } from "../../../src/release/desktop-shell.ts";
import { desktopClientBuildId } from "./client-build.ts";
import { bootsFromSource } from "./vera-command.ts";

export interface BuildCheckSources {
    readonly env: NodeJS.ProcessEnv;
    readonly clientBuildId: () => string | undefined;
    readonly installedBuildId: () => string | undefined;
    // True when the app shell loaded this code: the shell's own prefix names the installed build, and a source host does not change it.
    readonly underShell?: boolean;
}

const PROCESS_SOURCES: BuildCheckSources = {
    env: process.env,
    clientBuildId: desktopClientBuildId,
    installedBuildId: () => installedBuildAtPrefix(runningDesktopShell()?.prefix),
    get underShell() {
        return runningDesktopShell() !== undefined;
    },
};

// A source launch starts the host from the checkout, so the installed release is not what would run.
export function desktopBuildMismatch(sources: BuildCheckSources = PROCESS_SOURCES): InstalledBuildMismatch | undefined {
    if (sources.underShell !== true && bootsFromSource(sources.env)) return undefined;
    return installedBuildMismatch(sources.clientBuildId(), sources.installedBuildId());
}

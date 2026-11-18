import {
    installedBuildAtPrefix,
    installedBuildMismatch,
    type InstalledBuildMismatch,
} from "../../shared/installed-build.ts";
import { desktopClientBuildId } from "./client-build.ts";
import { bootsFromSource } from "./vera-command.ts";

export interface BuildCheckSources {
    readonly env: NodeJS.ProcessEnv;
    readonly clientBuildId: () => string | undefined;
    readonly installedBuildId: () => string | undefined;
}

const PROCESS_SOURCES: BuildCheckSources = {
    env: process.env,
    clientBuildId: desktopClientBuildId,
    installedBuildId: () => installedBuildAtPrefix(),
};

// A source launch starts the host from the checkout, so the installed release is not what would run.
export function desktopBuildMismatch(sources: BuildCheckSources = PROCESS_SOURCES): InstalledBuildMismatch | undefined {
    if (bootsFromSource(sources.env)) return undefined;
    return installedBuildMismatch(sources.clientBuildId(), sources.installedBuildId());
}

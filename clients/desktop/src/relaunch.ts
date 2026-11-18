import type { DesktopPackage } from "../../../src/release/desktop-packages.ts";
import type { DesktopShellHandle } from "../../../src/release/desktop-shell.ts";
import type { RelaunchRecord } from "../../../src/release/relaunch.ts";
import type { InstalledBuildMismatch } from "../../shared/installed-build.ts";

// The relaunch record the next window reads to reopen the session this one had open.
export const DESKTOP_RELAUNCH_KEY = "desktop";

export type RelaunchBanner = "not_under_shell" | "no_package" | "shell_too_old" | "same_package";

export type RelaunchDecision =
    | { readonly kind: "relaunch"; readonly package: DesktopPackage }
    | { readonly kind: "banner"; readonly reason: RelaunchBanner };

export interface RelaunchSources {
    readonly shell: DesktopShellHandle | undefined;
    readonly findPackage: (buildId: string, prefix: string) => DesktopPackage | undefined;
}

// A window relaunches only when its shell can load a package for the installed build that is not the one already running.
export function decideRelaunch(mismatch: InstalledBuildMismatch, sources: RelaunchSources): RelaunchDecision {
    const { shell } = sources;
    if (shell === undefined) return { kind: "banner", reason: "not_under_shell" };
    const found = sources.findPackage(mismatch.installedBuildId, shell.prefix);
    if (found === undefined) return { kind: "banner", reason: "no_package" };
    if (found.shellApi > shell.shellApi) return { kind: "banner", reason: "shell_too_old" };
    if (found.hostBuildId === shell.hostBuildId && found.desktopVersion === shell.desktopVersion) {
        return { kind: "banner", reason: "same_package" };
    }
    return { kind: "relaunch", package: found };
}

export interface RelaunchActions {
    readonly shell: () => DesktopShellHandle | undefined;
    readonly findPackage: RelaunchSources["findPackage"];
    readonly writeRecord: (record: RelaunchRecord) => void;
    readonly takeRecord: () => RelaunchRecord | undefined;
    // Closes what the window holds open, as quitting does.
    readonly stop: () => void;
    // Drops this process's hold on its package, so cleanup can remove the package once nothing else uses it.
    readonly release: () => void;
    // Starts the shell's executable again with its arguments, then exits this process.
    readonly restart: () => void;
}

// Relaunches the window into the package for the installed build and hands the open session to the next one.
export class DesktopRelaunch {
    private openSessionId: string | undefined;

    constructor(private readonly actions: RelaunchActions, private readonly now: () => Date = () => new Date()) {}

    // The session the page shows; undefined on any other page.
    sessionShown(agentId: string | undefined): void {
        this.openSessionId = agentId;
    }

    // True when the window is relaunching, so the caller shows nothing.
    buildChanged(mismatch: InstalledBuildMismatch): boolean {
        const decision = decideRelaunch(mismatch, { shell: this.actions.shell(), findPackage: this.actions.findPackage });
        if (decision.kind !== "relaunch") return false;
        try {
            this.actions.writeRecord({
                ...(this.openSessionId === undefined ? {} : { sessionId: this.openSessionId }),
                writtenAt: this.now().toISOString(),
            });
        } catch {
            // The next window then opens on the home page.
        }
        this.actions.stop();
        this.actions.release();
        this.actions.restart();
        return true;
    }

    // The session the window before this one had open, once.
    takeSession(): string | undefined {
        return this.actions.takeRecord()?.sessionId;
    }
}

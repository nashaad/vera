import type { DesktopPackage } from "../../../src/release/desktop-packages.ts";
import type { DesktopShellHandle } from "../../../src/release/desktop-shell.ts";
import type { RelaunchRecord } from "../../../src/release/relaunch.ts";
import { compareReleaseVersions } from "../../../src/release/version-order.ts";
import type { InstalledBuildMismatch } from "../../shared/installed-build.ts";

// The relaunch record the next window reads to reopen the session this one had open.
export const DESKTOP_RELAUNCH_KEY = "desktop";

// A composer holding more than this is not carried; the record stays small.
export const MAX_RELAUNCH_DRAFT_CHARS = 64 * 1024;

export interface ReopenTarget {
    readonly agentId: string;
    // The text the last window's composer held for that session.
    readonly draft?: string;
}

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
    private composer: { readonly agentId: string; readonly text: string } | undefined;

    constructor(private readonly actions: RelaunchActions, private readonly now: () => Date = () => new Date()) {}

    // The session the page shows; undefined on any other page.
    sessionShown(agentId: string | undefined): void {
        this.openSessionId = agentId;
    }

    // What the main composer of a session holds. Text that is blank or too long is not kept.
    draftChanged(agentId: string | undefined, text: string): void {
        this.composer = agentId === undefined || text.trim().length === 0 || text.length > MAX_RELAUNCH_DRAFT_CHARS ? undefined : { agentId, text };
    }

    // True when the window is relaunching, so the caller shows nothing.
    buildChanged(mismatch: InstalledBuildMismatch): boolean {
        const decision = decideRelaunch(mismatch, { shell: this.actions.shell(), findPackage: this.actions.findPackage });
        if (decision.kind !== "relaunch") return false;
        this.relaunchNow();
        return true;
    }

    // True when a newer package for the build this window runs is installed and the window is relaunching into it.
    packageAdded(): boolean {
        const shell = this.actions.shell();
        if (shell === undefined) return false;
        const sameBuild = { clientBuildId: shell.hostBuildId, installedBuildId: shell.hostBuildId };
        const decision = decideRelaunch(sameBuild, { shell, findPackage: this.actions.findPackage });
        if (decision.kind !== "relaunch") return false;
        if (compareReleaseVersions(decision.package.desktopVersion, shell.desktopVersion) <= 0) return false;
        this.relaunchNow();
        return true;
    }

    private relaunchNow(): void {
        try {
            const draft = this.composer !== undefined && this.composer.agentId === this.openSessionId ? this.composer.text : undefined;
            this.actions.writeRecord({
                ...(this.openSessionId === undefined ? {} : { sessionId: this.openSessionId }),
                ...(draft === undefined ? {} : { draft: { text: draft, attachmentIds: [] } }),
                writtenAt: this.now().toISOString(),
            });
        } catch {
            // The next window then opens on the home page.
        }
        this.actions.stop();
        this.actions.release();
        this.actions.restart();
    }

    // The session the window before this one had open, with the text its composer held, once.
    takeReopen(): ReopenTarget | undefined {
        const record = this.actions.takeRecord();
        if (record?.sessionId === undefined) return undefined;
        const draft = record.draft?.text;
        return { agentId: record.sessionId, ...(draft === undefined || draft.length === 0 ? {} : { draft }) };
    }
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
    VERA_HOME_ENV,
    veraRuntimeDirectory,
} from "../profile-paths.ts";

export const SUPERVISED_HOST_ENV = "VERA_SUPERVISED";

const THROTTLE_SECONDS = 10;

export class SupervisionUnsupportedError extends Error {
    constructor(platform: string) {
        super(
            `Host supervision uses launchd, which ${platform} does not have.`
                + " Vera works without it; a dead host still starts again the"
                + " next time you run 'vera'.",
        );
        this.name = "SupervisionUnsupportedError";
    }
}

export interface SupervisionPaths {
    readonly label: string;
    readonly plistPath: string;
}

export function supervisionPaths(
    home = homedir(),
): SupervisionPaths {
    const label = "dev.vera.host";
    return {
        label,
        plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
    };
}

function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function stringEntries(pairs: Readonly<Record<string, string>>): string {
    return Object.entries(pairs)
        .map(([key, value]) =>
            `        <key>${escapeXml(key)}</key>\n`
            + `        <string>${escapeXml(value)}</string>`
        )
        .join("\n");
}

export interface SupervisionPlistInput {
    readonly label: string;
    readonly executable: string;
    readonly entrypoint: string;
    readonly logDirectory: string;
    readonly workingDirectory: string;
    readonly veraHome?: string;
    readonly path?: string;
}

export function renderSupervisionPlist(input: SupervisionPlistInput): string {
    const environment: Record<string, string> = {
        [SUPERVISED_HOST_ENV]: "1",
    };
    if (input.veraHome !== undefined) {
        environment[VERA_HOME_ENV] = input.veraHome;
    }
    if (input.path !== undefined) environment.PATH = input.path;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(input.executable)}</string>
        <string>${escapeXml(input.entrypoint)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${stringEntries(environment)}
    </dict>
    <key>WorkingDirectory</key>
    <string>${escapeXml(input.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_SECONDS}</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(input.logDirectory, "launchd.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(input.logDirectory, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function launchctl(args: readonly string[]): string {
    return execFileSync("launchctl", [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

function domainTarget(): string {
    return `gui/${process.getuid?.() ?? 0}`;
}

export interface SupervisionOptions {
    readonly home?: string;
    readonly executable?: string;
    readonly entrypoint?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: string;
    readonly run?: (args: readonly string[]) => string;
}

function assertSupported(platform: string): void {
    if (platform !== "darwin") throw new SupervisionUnsupportedError(platform);
}

export interface SupervisionInstall extends SupervisionPaths {
    readonly replaced: boolean;
}

export function installHostSupervision(
    options: SupervisionOptions & { readonly entrypoint: string },
): SupervisionInstall {
    const platform = options.platform ?? process.platform;
    assertSupported(platform);
    const env = options.env ?? process.env;
    const paths = supervisionPaths(options.home);
    const run = options.run ?? launchctl;
    const logDirectory = join(veraRuntimeDirectory(env), "logs");
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(paths.plistPath), { recursive: true });
    const replaced = existsSync(paths.plistPath);
    writeFileSync(
        paths.plistPath,
        renderSupervisionPlist({
            label: paths.label,
            executable: options.executable ?? process.execPath,
            entrypoint: options.entrypoint,
            logDirectory,
            workingDirectory: options.home ?? homedir(),
            veraHome: env[VERA_HOME_ENV]?.trim() || undefined,
            path: env.PATH,
        }),
        { encoding: "utf8", mode: 0o644 },
    );
    try {
        run(["bootout", `${domainTarget()}/${paths.label}`]);
    } catch {
    }
    run(["bootstrap", domainTarget(), paths.plistPath]);
    return { ...paths, replaced };
}

export interface SupervisionRemoval extends SupervisionPaths {
    readonly removed: boolean;
}

export function removeHostSupervision(
    options: SupervisionOptions,
): SupervisionRemoval {
    const platform = options.platform ?? process.platform;
    assertSupported(platform);
    const paths = supervisionPaths(options.home);
    const run = options.run ?? launchctl;
    try {
        run(["bootout", `${domainTarget()}/${paths.label}`]);
    } catch {
    }
    if (!existsSync(paths.plistPath)) return { ...paths, removed: false };
    unlinkSync(paths.plistPath);
    return { ...paths, removed: true };
}

export interface SupervisionStatus extends SupervisionPaths {
    readonly installed: boolean;
    readonly loaded: boolean;
    readonly pid?: number;
}

export type SupervisionReport =
    | ({ readonly action: "on" } & SupervisionInstall)
    | ({ readonly action: "off" } & SupervisionRemoval)
    | ({ readonly action: "status" } & SupervisionStatus);

export function superviseHost(
    action: "on" | "off" | "status",
    options: SupervisionOptions & { readonly entrypoint: string },
): SupervisionReport {
    if (action === "on") {
        return { action, ...installHostSupervision(options) };
    }
    if (action === "off") {
        return { action, ...removeHostSupervision(options) };
    }
    return { action, ...hostSupervisionStatus(options) };
}

export function hostSupervisionStatus(
    options: SupervisionOptions = {},
): SupervisionStatus {
    const platform = options.platform ?? process.platform;
    assertSupported(platform);
    const paths = supervisionPaths(options.home);
    const run = options.run ?? launchctl;
    const installed = existsSync(paths.plistPath);
    let printed: string;
    try {
        printed = run(["print", `${domainTarget()}/${paths.label}`]);
    } catch {
        return { ...paths, installed, loaded: false };
    }
    const pid = /^\s*pid = (\d+)$/m.exec(printed)?.[1];
    return {
        ...paths,
        installed,
        loaded: true,
        ...(pid === undefined ? {} : { pid: Number(pid) }),
    };
}

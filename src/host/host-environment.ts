import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

import { veraMachineDirectoryIn, VERA_HOME_ENV } from "../profile-paths.ts";

export const HOST_ENV_FILE_NAME = "env";
export const DEFAULT_HOST_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SEEDED_SUFFIX = /_API_KEY$/;

// Set by the launcher, never by the file: they decide which Vera this host is.
const LAUNCHER_ONLY = new Set([VERA_HOME_ENV, "VERA_DEV_INSTANCE"]);

export class HostEnvironmentFileError extends Error {
    readonly path: string;
    readonly line: number;
    readonly reason: string;

    constructor(path: string, line: number, reason: string) {
        super(`${path} line ${line}: ${reason}. Each line is NAME=value, a # comment, or blank.`);
        this.name = "HostEnvironmentFileError";
        this.path = path;
        this.line = line;
        this.reason = reason;
    }
}

export function hostEnvironmentPath(veraHome: string): string {
    return join(veraMachineDirectoryIn(veraHome), HOST_ENV_FILE_NAME);
}

// A file the next host start would refuse; a missing or unreadable file is left to the start itself.
export function hostEnvironmentProblem(veraHome: string): HostEnvironmentFileError | undefined {
    const path = hostEnvironmentPath(resolve(veraHome));
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
    try {
        parseHostEnvironment(text, path);
    } catch (error) {
        if (error instanceof HostEnvironmentFileError) return error;
        throw error;
    }
    return undefined;
}

export function parseHostEnvironment(text: string, path: string): Map<string, string> {
    const entries = new Map<string, string>();
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] as string).replace(/\r$/, "");
        if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
        const equals = line.indexOf("=");
        if (equals <= 0) throw new HostEnvironmentFileError(path, index + 1, "no NAME= at the start");
        const name = line.slice(0, equals);
        if (!NAME.test(name)) throw new HostEnvironmentFileError(path, index + 1, `${JSON.stringify(name)} is not a variable name`);
        if (LAUNCHER_ONLY.has(name)) throw new HostEnvironmentFileError(path, index + 1, `${name} is set by the launcher, not this file`);
        entries.set(name, line.slice(equals + 1));
    }
    return entries;
}

// The names a new file copies from the launching shell: what tools need to run, provider keys, and every {env:NAME} the home's config uses.
export function seededHostEnvironmentNames(veraHome: string, source: NodeJS.ProcessEnv): string[] {
    const names = new Set(["PATH", "LANG"]);
    for (const name of Object.keys(source)) {
        if (SEEDED_SUFFIX.test(name)) names.add(name);
    }
    for (const file of ["config.json", "extensions.json"]) {
        let text: string;
        try {
            text = readFileSync(join(veraHome, file), "utf8");
        } catch {
            continue;
        }
        for (const match of text.matchAll(ENV_REFERENCE)) names.add(match[1] as string);
    }
    return [...names].filter((name) => {
        const value = source[name];
        return value !== undefined && value.length > 0 && !value.includes("\n") && !LAUNCHER_ONLY.has(name);
    }).sort();
}

export function seedHostEnvironmentFile(veraHome: string, source: NodeJS.ProcessEnv): void {
    const path = hostEnvironmentPath(veraHome);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lines = seededHostEnvironmentNames(veraHome, source).map((name) => `${name}=${source[name]}`);
    writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
}

export interface HostLaunchEnvironmentOptions {
    readonly source?: NodeJS.ProcessEnv;
    readonly extra?: Readonly<Record<string, string>>;
}

// All a resident host gets: user identity, the home's env file, the launcher-only names and `extra`.
// A missing file is created once from the launcher's values for the seeded names.
export function hostLaunchEnvironment(
    veraHome: string,
    options: HostLaunchEnvironmentOptions = {},
): Record<string, string> {
    const source = options.source ?? process.env;
    const home = resolve(veraHome);
    const path = hostEnvironmentPath(home);
    if (!existsSync(path)) {
        try {
            seedHostEnvironmentFile(home, source);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    const declared = parseHostEnvironment(readFileSync(path, "utf8"), path);
    const user = userInfo();
    const environment: Record<string, string> = {
        HOME: source.HOME || homedir(),
        USER: user.username,
        LOGNAME: user.username,
        SHELL: user.shell ?? "/bin/sh",
        TMPDIR: source.TMPDIR || tmpdir(),
        PATH: DEFAULT_HOST_PATH,
    };
    for (const [name, value] of declared) environment[name] = value;
    for (const name of LAUNCHER_ONLY) {
        const value = source[name]?.trim();
        if (value !== undefined && value.length > 0) environment[name] = name === VERA_HOME_ENV ? home : value;
    }
    return { ...environment, ...options.extra };
}

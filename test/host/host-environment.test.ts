import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
    DEFAULT_HOST_PATH,
    HostEnvironmentFileError,
    hostEnvironmentPath,
    hostEnvironmentProblem,
    hostLaunchEnvironment,
    parseHostEnvironment,
} from "../../src/host/host-environment.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryHome(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-host-env-"));
    roots.push(root);
    return root;
}

function writeEnvFile(home: string, text: string): void {
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(hostEnvironmentPath(home), text);
}

test("@core a host's environment is the home's file, whichever shell launches it", () => {
    const home = temporaryHome();
    writeEnvFile(home, "PATH=/opt/crow/bin:/usr/bin\nAXIOM_TOKEN=parrot\n");
    const full = hostLaunchEnvironment(home, {
        source: { HOME: "/Users/crow", PATH: "/elsewhere", AXIOM_TOKEN: "other", TMUX: "/tmp/tmux", RUM_RATION: "3" },
    });
    const bare = hostLaunchEnvironment(home, { source: { HOME: "/Users/crow" } });

    expect(full).toEqual(bare);
    expect(full.PATH).toBe("/opt/crow/bin:/usr/bin");
    expect(full.AXIOM_TOKEN).toBe("parrot");
    expect(full.TMUX).toBeUndefined();
    expect(full.RUM_RATION).toBeUndefined();
    expect(full.HOME).toBe("/Users/crow");
});

test("@core the first launch writes the file from the launcher once, owner-only", () => {
    const home = temporaryHome();
    writeFileSync(join(home, "config.json"), JSON.stringify({ extensions: [{ config: { token: "{env:AXIOM_TOKEN}" } }] }));
    const first = hostLaunchEnvironment(home, {
        source: {
            PATH: "/opt/crow/bin",
            LANG: "en_US.UTF-8",
            OPENROUTER_API_KEY: "sk-crow",
            AXIOM_TOKEN: "parrot",
            TERM_SESSION_ID: "w0t0p0",
            VERA_HOME: home,
        },
    });
    const path = hostEnvironmentPath(home);

    expect(readFileSync(path, "utf8")).toBe(
        "AXIOM_TOKEN=parrot\nLANG=en_US.UTF-8\nOPENROUTER_API_KEY=sk-crow\nPATH=/opt/crow/bin\n",
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(first.OPENROUTER_API_KEY).toBe("sk-crow");
    expect(first.TERM_SESSION_ID).toBeUndefined();

    const later = hostLaunchEnvironment(home, { source: { PATH: "/changed", OPENROUTER_API_KEY: "sk-gull" } });
    expect(later.PATH).toBe("/opt/crow/bin");
    expect(later.OPENROUTER_API_KEY).toBe("sk-crow");
});

test("a file without PATH gets the system default", () => {
    const home = temporaryHome();
    writeEnvFile(home, "# empty hold\n\n");
    expect(hostLaunchEnvironment(home, { source: { PATH: "/opt/crow/bin" } }).PATH).toBe(DEFAULT_HOST_PATH);
});

test("@core VERA_HOME and the dev instance come from the launcher, with the home made absolute", () => {
    const home = temporaryHome();
    writeEnvFile(home, "");
    const relativeHome = relative(process.cwd(), home);
    const environment = hostLaunchEnvironment(relativeHome, {
        source: { VERA_HOME: relativeHome, VERA_DEV_INSTANCE: "hoststart abc123" },
    });
    expect(environment.VERA_HOME).toBe(home);
    expect(environment.VERA_DEV_INSTANCE).toBe("hoststart abc123");
    expect(hostLaunchEnvironment(home, { source: {} }).VERA_HOME).toBeUndefined();
});

test("the file cannot choose which Vera the host is", () => {
    expect(() => parseHostEnvironment("PATH=/bin\nVERA_HOME=/tmp/other\n", "/h/machine/env"))
        .toThrow("/h/machine/env line 2: VERA_HOME is set by the launcher, not this file");
});

test("@core a bad line is found before a start is tried, and a missing file is not a problem", () => {
    const home = temporaryHome();
    expect(hostEnvironmentProblem(home)).toBeUndefined();
    writeEnvFile(home, "PATH=/bin\nexport AXIOM_TOKEN=parrot\n");
    const problem = hostEnvironmentProblem(home);
    expect(problem).toBeInstanceOf(HostEnvironmentFileError);
    expect(problem?.line).toBe(2);
    expect(problem?.path).toBe(hostEnvironmentPath(home));
});

test("a malformed line names the file and line", () => {
    const error = (() => {
        try {
            parseHostEnvironment("PATH=/bin\nexport AXIOM_TOKEN=parrot\n", "/h/machine/env");
        } catch (caught) {
            return caught;
        }
        return undefined;
    })();
    expect(error).toBeInstanceOf(HostEnvironmentFileError);
    expect((error as HostEnvironmentFileError).line).toBe(2);
});

test("values are literal, including spaces, quotes and equals signs", () => {
    const entries = parseHostEnvironment("GREETING=\"ahoy = matey\" \n", "/h/machine/env");
    expect(entries.get("GREETING")).toBe("\"ahoy = matey\" ");
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    hostSupervisionStatus,
    installHostSupervision,
    removeHostSupervision,
    renderSupervisionPlist,
    SUPERVISED_HOST_ENV,
    supervisionPaths,
    SupervisionUnsupportedError,
} from "../../src/host/supervision.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function temporaryHome(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-supervise-"));
    roots.push(root);
    return root;
}

function recordingLaunchctl(): {
    readonly calls: string[][];
    readonly run: (args: readonly string[]) => string;
} {
    const calls: string[][] = [];
    return {
        calls,
        run: (args) => {
            calls.push([...args]);
            return "";
        },
    };
}

function options(home: string, extra: Record<string, unknown> = {}) {
    return {
        entrypoint: "/checkout/clients/host/main.ts",
        executable: "/usr/local/bin/bun",
        home,
        platform: "darwin",
        env: { VERA_HOME: home, PATH: "/opt/homebrew/bin:/usr/bin" },
        ...extra,
    };
}

test("supervision is refused where launchd does not exist", () => {
    expect(() =>
        hostSupervisionStatus({ platform: "linux", home: temporaryHome() })
    ).toThrow(SupervisionUnsupportedError);
});

test("the plist runs the host entrypoint for the daily home", () => {
    const home = temporaryHome();
    const launchctl = recordingLaunchctl();
    const install = installHostSupervision(
        options(home, { run: launchctl.run }),
    );

    expect(install.label).toBe("dev.vera.host");
    expect(install.replaced).toBe(false);
    const plist = readFileSync(install.plistPath, "utf8");
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>/checkout/clients/host/main.ts</string>");
    expect(plist).toContain(`<key>${SUPERVISED_HOST_ENV}</key>`);
    expect(plist).toContain(`<string>${home}</string>`);
    expect(launchctl.calls.at(-1)?.[0]).toBe("bootstrap");
});

test("a clean exit is not restarted, a crash is", () => {
    const plist = renderSupervisionPlist({
        label: "dev.vera.host",
        executable: "/bun",
        entrypoint: "/host.ts",
        logDirectory: "/logs",
        workingDirectory: "/home",
    });
    // 'vera host stop' exits the host 0, and must not be undone by launchd.
    expect(plist).toContain(
        "<key>KeepAlive</key>\n    <dict>\n        <key>SuccessfulExit</key>\n        <false/>\n    </dict>",
    );
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>");
});

test("installing over an existing agent unloads it first", () => {
    const home = temporaryHome();
    const launchctl = recordingLaunchctl();
    installHostSupervision(options(home, { run: launchctl.run }));
    const again = installHostSupervision(options(home, { run: launchctl.run }));

    expect(again.replaced).toBe(true);
    expect(launchctl.calls.map((call) => call[0])).toEqual([
        "bootout",
        "bootstrap",
        "bootout",
        "bootstrap",
    ]);
});

test("supervision uses one host label", () => {
    const home = temporaryHome();
    expect(supervisionPaths(home).label).toBe("dev.vera.host");
});

test("turning supervision off unloads the agent and removes the plist", () => {
    const home = temporaryHome();
    const launchctl = recordingLaunchctl();
    const install = installHostSupervision(options(home, { run: launchctl.run }));

    const removal = removeHostSupervision(
        options(home, { run: launchctl.run }),
    );

    expect(removal.removed).toBe(true);
    expect(existsSync(install.plistPath)).toBe(false);
    expect(launchctl.calls.at(-1)).toEqual([
        "bootout",
        `gui/${process.getuid?.() ?? 0}/dev.vera.host`,
    ]);
});

test("turning off what was never on is not an error", () => {
    const home = temporaryHome();
    const removal = removeHostSupervision(options(home, {
        run: () => {
            throw new Error("no such service");
        },
    }));
    expect(removal.removed).toBe(false);
});

test("status reports the supervised host's pid", () => {
    const home = temporaryHome();
    const plistPath = supervisionPaths(home).plistPath;
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, "");

    const status = hostSupervisionStatus(options(home, {
        run: () => "state = running\n\tpid = 4321\n\tprogram = /bun\n",
    }));

    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);
    expect(status.pid).toBe(4321);
});

test("an installed but unloaded agent reads as not loaded", () => {
    const home = temporaryHome();
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(supervisionPaths(home).plistPath, "");

    const status = hostSupervisionStatus(options(home, {
        run: () => {
            throw new Error("Could not find service");
        },
    }));

    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(false);
    expect(status.pid).toBeUndefined();
});

// Shared setup for desktop e2e runs: a throwaway VERA_HOME and a launcher for the
// built app. Stopping only ever signals the host recorded under that home.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const require = createRequire(join(root, "clients", "desktop", "package.json"));
const { _electron: electron } = require("playwright-core");
const electronPath = require("electron");

export const OUT_OF_SIGHT = ["-r", join(root, "clients", "desktop", "test", "out-of-sight.cjs")];

export function startTrial() {
    const trialRoot = mkdtempSync(join(tmpdir(), "vera-desktop-e2e-"));
    const home = join(trialRoot, ".vera");
    const bun = process.env.VERA_DESKTOP_BUN
        || execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    const apps = [];

    // The tour and the bench pass visible: true; every other run stays out of sight.
    // `env` adds to the app's environment, such as a HOME that holds a fixture of VS Code extensions.
    async function launch({ visible = false, cwd = root, env = {} } = {}) {
        const app = await electron.launch({
            executablePath: electronPath,
            args: [...(visible ? [] : OUT_OF_SIGHT), join(root, "clients", "desktop")],
            cwd,
            env: {
                ...process.env,
                VERA_HOME: home,
                // Without it the CLI boots the installed release host, not this checkout's source.
                VERA_DEV_INSTANCE: `${basename(root)} e2e`,
                VERA_DESKTOP_DEV_CLI: join(root, "clients", "cli", "main.ts"),
                VERA_DESKTOP_BUN: bun,
                ...env,
            },
            timeout: 60_000,
        });
        apps.push(app);
        if (!visible) {
            await app.firstWindow();
            const hidden = await app.evaluate(({ app: electronApp, BrowserWindow }) => electronApp.dock?.isVisible() !== true
                && BrowserWindow.getAllWindows().every((window) => window.getOpacity() === 0));
            if (!hidden) throw new Error("A trial window is visible; out-of-sight.cjs did not load.");
        }
        return app;
    }

    function hostPid() {
        try {
            const record = JSON.parse(readFileSync(join(home, "runtime", "host.json"), "utf8"));
            const ours = typeof record.pid === "number" && record.pid > 0
                && typeof record.socket_path === "string" && record.socket_path.startsWith(home);
            if (!ours) return undefined;
            // The lock outlives a host that exited, so only a live pid counts.
            process.kill(record.pid, 0);
            return record.pid;
        } catch {
            return undefined;
        }
    }

    // A host that is still starting when the test ends would outlive it, so tests wait first.
    async function waitForHost() {
        for (let attempt = 0; attempt < 450; attempt += 1) {
            const pid = hostPid();
            if (pid !== undefined) return pid;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("The trial host never appeared in the lock.");
    }

    async function cleanup() {
        for (const app of apps) await app.close().catch(() => {});
        const pid = hostPid();
        if (pid !== undefined) await stopProcess(pid);
        rmSync(trialRoot, { recursive: true, force: true });
    }

    return { root, trialRoot, home, launch, hostPid, waitForHost, cleanup };
}

// Goes through the same path as a key typed on the keyboard: the main process's
// before-input-event first, then the page. Playwright's keyboard skips the main process.
export async function press(app, key, modifiers = []) {
    await app.evaluate(({ BrowserWindow }, { key, modifiers }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    }, { key, modifiers });
}

export const MODIFIER = process.platform === "darwin" ? "meta" : "control";

async function stopProcess(pid) {
    try {
        process.kill(pid, "SIGTERM");
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
        return;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    process.kill(pid, "SIGKILL");
}

// Shared setup for desktop e2e runs: a throwaway VERA_HOME and a launcher for the
// built app. The host is stopped through its identity-checked protocol.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

import { sourceTestHome } from "../../../test/support/source-test-home.mjs";

const root = new URL("../../..", import.meta.url).pathname;
const require = createRequire(join(root, "clients", "desktop", "package.json"));
const { _electron: electron } = require("playwright-core");
const electronPath = require("electron");

export const OUT_OF_SIGHT = ["-r", join(root, "clients", "desktop", "test", "out-of-sight.cjs")];
// Counts utility processes by service name from the start of main; see globalThis.utilityStarts.
export const COUNT_PROCESSES = ["-r", join(root, "clients", "desktop", "test", "count-processes.cjs")];

export function startTrial() {
    const trialRoot = mkdtempSync(join(tmpdir(), "vera-desktop-e2e-"));
    const home = join(trialRoot, ".vera");
    const userHome = sourceTestHome(join(trialRoot, "user"));
    const bun = process.env.VERA_DESKTOP_BUN
        || execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    const apps = [];

    // The tour and the bench pass visible: true; every other run stays out of sight.
    // `env` adds to the app's environment, such as a HOME that holds a fixture of VS Code extensions.
    // `appDir` launches another build; `args` are node options before the app.
    async function launch({ visible = false, cwd = root, env = {}, appDir = join(root, "clients", "desktop"), args = [] } = {}) {
        const launchHome = env.HOME ?? userHome;
        const homeRelative = relative(trialRoot, launchHome);
        if (homeRelative.startsWith("..") || isAbsolute(homeRelative)) throw new Error("Trial HOME must be inside the trial root.");
        sourceTestHome(launchHome);
        const app = await electron.launch({
            executablePath: electronPath,
            args: [...(visible ? [] : OUT_OF_SIGHT), ...args, appDir],
            cwd,
            env: {
                ...process.env,
                HOME: launchHome,
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
        // A window with a watched session raises a beforeunload prompt on close. Without a listener,
        // Playwright answers it itself and the rejected reply crashes the script after it passed.
        const answerUnloadPrompt = (page) => page.on("dialog", (dialog) => { dialog.accept().catch(() => {}); });
        app.windows().forEach(answerUnloadPrompt);
        app.on("window", answerUnloadPrompt);
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

    // Writes the desktop's flags file into the trial home, as a person's choices in Settings do.
    function writeFlags(flags) {
        const folder = join(home, "machine", "desktop");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "flags.json"), `${JSON.stringify(flags)}\n`);
    }

    async function cleanup() {
        for (const app of apps) await closeApp(app);
        if (hostPid() !== undefined) await stopTrialHost(home);
        if (hostPid() !== undefined) throw new Error("Trial host remains alive; retaining its home.");
        rmSync(trialRoot, { recursive: true, force: true });
    }

    return { root, trialRoot, home, userHome, launch, hostPid, waitForHost, writeFlags, cleanup };
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

export async function waitForAnnexPages(page, app) {
    await press(app, "K", [MODIFIER]);
    await page.getByRole("textbox", { name: "Command palette" }).fill("Artifacts");
    await page.locator('[data-command="page.extension.%2Fx%2Fvera.artifacts%2Fartifacts"]').waitFor({ timeout: 45_000 });
    await page.keyboard.press("Escape");
}

// Playwright's close waits for the app's exit event, which a quit occasionally never delivers.
const CLOSE_LIMIT_MS = 15_000;

async function closeApp(app) {
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_LIMIT_MS, "limit"); });
    const outcome = await Promise.race([app.close().then(() => "closed", () => "closed"), limit]);
    clearTimeout(timer);
    if (outcome === "closed") return;
    console.error(`${basename(process.argv[1])}: close timed out after ${CLOSE_LIMIT_MS / 1000} s`);
    throw new Error("Trial app did not exit; refusing to signal an unverified process group.");
}

function hostRequest(socketPath, request, terminal, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        let buffer = "";
        const timer = setTimeout(() => finish(new Error("Host request timed out")), timeout);
        const finish = (error, result) => {
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error); else resolve(result);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk) => {
            buffer += chunk;
            if (buffer.length > 4096) return finish(new Error("Host reply too large"));
            for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    const result = JSON.parse(line);
                    if (terminal(result)) return finish(undefined, result);
                } catch (error) { return finish(error); }
            }
        });
        socket.once("error", (error) => finish(error));
        socket.once("end", () => finish(new Error("Host closed before reply")));
    });
}

async function stopTrialHost(home) {
    const record = JSON.parse(readFileSync(join(home, "runtime", "host.json"), "utf8"));
    const path = typeof record.socket_path === "string" ? relative(home, record.socket_path) : "";
    if (!Number.isInteger(record.pid) || record.pid <= 0 || typeof record.started_at !== "string" || Number.isNaN(Date.parse(record.started_at)) || !path || path.startsWith("..") || isAbsolute(path)) throw new Error("Invalid trial host lock");
    const identity = await hostRequest(record.socket_path, { type: "host_identity" }, (result) => result.type === "host_identity");
    if (identity.pid !== record.pid || identity.started_at !== record.started_at || !Number.isInteger(identity.protocol_version)) throw new Error("Trial host identity mismatch");
    const response = await hostRequest(record.socket_path, { type: "shutdown_if_idle", pid: identity.pid, started_at: identity.started_at, requester_protocol_version: identity.protocol_version }, () => true);
    if (response.type !== "shutdown_if_idle_accepted") {
        const stopped = await hostRequest(record.socket_path, { type: "stop_host", pid: identity.pid, started_at: identity.started_at }, (result) => result.type !== "stop_host_waiting", 15000);
        if (stopped.type !== "stop_host_stopped") throw new Error(`Graceful stop refused: ${JSON.stringify(stopped)}`);
    }
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try { process.kill(record.pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Trial host did not exit after graceful shutdown.");
}

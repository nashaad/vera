// Attach test for the desktop shell. Run with: node clients/desktop/test/attach.e2e.mjs
// It uses a throwaway VERA_HOME and stops only the host recorded under that home.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OUT_OF_SIGHT } from "./trial.mjs";

const root = new URL("../../..", import.meta.url).pathname;
const require = createRequire(join(root, "clients", "desktop", "package.json"));
const { _electron: electron } = require("playwright-core");
const electronPath = require("electron");

const trialRoot = mkdtempSync(join(tmpdir(), "vera-desktop-e2e-"));
const home = join(trialRoot, ".vera");
const bun = process.env.VERA_DESKTOP_BUN
    || execFileSync("which", ["bun"], { encoding: "utf8" }).trim();

let app;
let stoppedPid;
const startedPids = [];

function lockRecord() {
    return JSON.parse(readFileSync(join(home, "runtime", "host.json"), "utf8"));
}

function assertOurHost(record) {
    if (typeof record.pid !== "number" || record.pid <= 0) {
        throw new Error("The host lock has no pid.");
    }
    if (typeof record.socket_path !== "string" || !record.socket_path.startsWith(home)) {
        throw new Error(`Refusing to signal a host outside the trial home: ${record.socket_path}`);
    }
    return record.pid;
}

async function waitForPid() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const pid = assertOurHost(lockRecord());
            if (pid !== stoppedPid) return pid;
        } catch {
            // The lock may not exist yet, or may still name the stopped host.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The trial host never appeared in the lock.");
}

async function stopHost(pid) {
    if (pid === undefined) return;
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

// The app root carries the session count whatever the layout, unlike the views, which can be closed.
const SESSIONS = ".app[data-sessions]";

async function waitForSessions(page) {
    await page.waitForSelector(SESSIONS, { timeout: 45_000 });
    return page.getAttribute(SESSIONS, "data-sessions");
}

// The View menu is native, so the test clicks its items from the main process.
async function chooseTheme(command) {
    await app.evaluate(({ Menu }, id) => {
        Menu.getApplicationMenu().getMenuItemById(id).click();
    }, command);
}

// The page reports the theme to the shell, which rebuilds the menu with that item checked.
async function waitForCheckedTheme(command) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const checked = await app.evaluate(({ Menu }, id) => (
            Menu.getApplicationMenu().getMenuItemById(id).checked
        ), command);
        if (checked) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`The View menu never checked ${command}.`);
}

async function surfaceColor(page) {
    const value = await page.evaluate(() => (
        getComputedStyle(document.documentElement).getPropertyValue("--vera-surface").trim()
    ));
    return value.toLowerCase();
}

// The window background is set over IPC after the theme applies, so poll for it.
async function waitForWindowBackground(page, expected) {
    let actual = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
        actual = (await app.evaluate(({ BrowserWindow }) => (
            BrowserWindow.getAllWindows()[0].getBackgroundColor()
        ))).toLowerCase();
        if (actual === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Window background is ${actual}, expected the page surface ${expected}`);
}

async function missingCliCase() {
    const missing = join(trialRoot, "missing-cli.ts");
    const probe = await electron.launch({
        executablePath: electronPath,
        args: [...OUT_OF_SIGHT, join(root, "clients", "desktop")],
        cwd: root,
        env: {
            ...process.env,
            VERA_HOME: home,
            VERA_DESKTOP_DEV_CLI: missing,
            VERA_DESKTOP_BUN: bun,
        },
        timeout: 30_000,
    });
    try {
        const page = await probe.firstWindow();
        await page.waitForSelector(".banner", { timeout: 15_000 });
        const body = await page.textContent("body");
        if (!body.includes("Vera is not installed")) {
            throw new Error(`Expected the missing-install banner, saw: ${body}`);
        }
        if (!body.includes(missing)) {
            throw new Error("The banner does not name the path it checked.");
        }
    } finally {
        await probe.close();
    }
}

try {
    await missingCliCase();
    app = await electron.launch({
        executablePath: electronPath,
        args: [...OUT_OF_SIGHT, join(root, "clients", "desktop")],
        cwd: root,
        env: {
            ...process.env,
            VERA_HOME: home,
            VERA_DESKTOP_DEV_CLI: join(root, "clients", "cli", "main.ts"),
            VERA_DESKTOP_BUN: bun,
        },
        timeout: 60_000,
    });
    const page = await app.firstWindow();
    const violations = [];
    page.on("console", (message) => {
        if (/content security policy/i.test(message.text())) violations.push(message.text());
    });
    const count = await waitForSessions(page);
    if (count !== "0") throw new Error(`Expected 0 sessions, saw ${count}`);

    const state = page.locator(".sidebar-foot [data-item=\"state\"]");
    const stateText = await state.textContent();
    if (!/^Attached · \S+$/.test(stateText)) throw new Error(`Unexpected sidebar footer: ${stateText}`);
    const stateTitle = await state.getAttribute("title");
    if (!/Protocol v\d+/.test(stateTitle) || !stateTitle.includes(home)) {
        throw new Error(`The footer tooltip lacks the protocol or home: ${stateTitle}`);
    }
    if (await page.getByRole("button", { name: /^(Dark|Light|High contrast)$/ }).count() > 0) {
        throw new Error("The window still has theme buttons.");
    }
    await waitForCheckedTheme("theme.dark");
    const stored = await page.evaluate(() => (
        document.documentElement.style.getPropertyValue("--vera-surface")
    ));
    if (stored.length === 0) throw new Error("The theme tokens were not applied to the page.");
    const darkSurface = await surfaceColor(page);
    await waitForWindowBackground(page, darkSurface);

    const firstPid = await waitForPid();
    startedPids.push(firstPid);
    await stopHost(firstPid);
    stoppedPid = firstPid;
    await page.waitForSelector(".banner", { timeout: 15_000 });
    const banner = await page.textContent(".banner");
    if (!banner.includes("Connection to Vera lost")) {
        throw new Error(`Expected the lost-connection banner, saw: ${banner}`);
    }

    await page.getByRole("button", { name: "Reconnect" }).click();
    const reconnected = await waitForSessions(page);
    if (reconnected !== "0") {
        throw new Error(`Expected 0 sessions after reconnect, saw ${reconnected}`);
    }
    const secondPid = await waitForPid();
    startedPids.push(secondPid);
    if (secondPid === firstPid) throw new Error("Reconnect reused the stopped host pid.");

    await chooseTheme("theme.light");
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    if (theme !== "light") throw new Error(`Theme did not switch, saw ${theme}`);
    const lightSurface = await surfaceColor(page);
    if (lightSurface === darkSurface) throw new Error("The light theme has the same surface as dark.");
    await waitForWindowBackground(page, lightSurface);
    await waitForCheckedTheme("theme.light");

    await chooseTheme("theme.highContrast");
    const contrastSurface = await surfaceColor(page);
    if (contrastSurface === lightSurface) throw new Error("High contrast has the same surface as light.");
    await waitForWindowBackground(page, contrastSurface);
    await waitForCheckedTheme("theme.highContrast");

    if (violations.length > 0) throw new Error(`Content security policy violations: ${violations.join("; ")}`);

    console.log(`attach e2e passed: host ${firstPid}, reconnect ${secondPid}, ${home}`);
} finally {
    if (app !== undefined) await app.close().catch(() => {});
    const lastPid = lockRecordSafe();
    if (lastPid !== undefined && !startedPids.includes(lastPid)) await stopHost(lastPid);
    for (const pid of startedPids) await stopHost(pid);
    rmSync(trialRoot, { recursive: true, force: true });
}

function lockRecordSafe() {
    try {
        return assertOurHost(lockRecord());
    } catch {
        return undefined;
    }
}

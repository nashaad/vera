import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { press, startTrial } from "./trial.mjs";

const trial = startTrial();
const electronPids = [];
let hostPid;
let app;
let page;

function exited(pid) {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
    }
}

async function launch() {
    app = await trial.launch();
    electronPids.push(app.process().pid);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    hostPid = await trial.waitForHost();
}

async function openSheet() {
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("theme.choose").click());
    await page.locator('[data-overlay="themes"]').waitFor();
}

async function highlight(index) {
    await page.waitForFunction((expected) => {
        const button = document.querySelector('[data-overlay="themes"] [data-highlighted="true"]');
        return button?.getAttribute("data-theme-index") === String(expected) && document.activeElement === button;
    }, index);
}

async function selected(name) {
    await page.waitForFunction((expected) => document.documentElement.getAttribute("data-theme") === expected, name);
    assert.equal(await page.locator(`[data-overlay="themes"] [data-theme-name="${name}"]`).getAttribute("aria-pressed"), "true");
}

async function writes() {
    return page.evaluate(() => globalThis.themeWrites.slice());
}

async function capture(name) {
    const directory = process.env.VERA_THEME_PICKER_SHOTS;
    if (directory === undefined) return;
    mkdirSync(directory, { recursive: true });
    await page.locator('[data-overlay="themes"]').screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
}

try {
    const extension = join(trial.home, "machine", "desktop", "extensions", "crow");
    mkdirSync(join(extension, "themes"), { recursive: true });
    writeFileSync(join(extension, "vera.desktop.json"), JSON.stringify({
        id: "crow", version: "1.0.0", engine: "vera-gui@^1",
        contributes: { themes: [{ label: "Crow Night", path: "themes/night.json" }] },
    }));
    writeFileSync(join(extension, "themes", "night.json"), JSON.stringify({
        version: 1, slug: "night", name: "Crow Night", type: "dark", source: "Crow",
        colors: {
            surface: "#101820", "surface-sidebar": "#152637", "surface-panel": "#203040",
            border: "#334455", accent: "#cc9922", text: "#e0e5eb",
        },
        values: {}, tokenColors: [], semanticTokenColors: {},
    }));
    await launch();
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        globalThis.themeWrites = [];
        Storage.prototype.setItem = function (key, value) {
            if (key === "vera.theme") globalThis.themeWrites.push(value);
            return original.call(this, key, value);
        };
    });
    await openSheet();
    const sheet = page.locator('[data-overlay="themes"]');
    const rows = sheet.locator("[data-theme-index]");
    await rows.last().waitFor();
    const names = await rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-theme-name")));
    assert.equal(names[0], "dark");
    assert.equal(names[1], "light");
    assert.equal(names.at(-1), "imported:crow.night");
    assert.equal(await sheet.getByRole("button", { name: "List view" }).getAttribute("aria-pressed"), "true");
    assert.equal(await rows.nth(0).locator(".theme-swatches span").count(), 3);
    assert.equal(await rows.nth(1).locator(".theme-row-key").innerText(), "2");
    await highlight(0);
    const listHeight = await sheet.evaluate((element) => element.getBoundingClientRect().height);
    await capture("list");

    await press(app, "Down");
    await highlight(1);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
    assert.deepEqual(await writes(), []);
    await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        contents.sendInputEvent({ type: "char", keyCode: "\r" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    });
    await selected("light");
    assert.deepEqual(await writes(), ["light"]);
    await rows.nth(4).click();
    await highlight(4);
    await selected(names[4]);
    assert.deepEqual(await writes(), ["light", names[4]]);
    await page.keyboard.press("Enter");
    assert.deepEqual(await writes(), ["light", names[4], names[4]]);
    await page.keyboard.press("ArrowUp");
    await highlight(3);
    await page.keyboard.press("Enter");
    await selected(names[3]);
    assert.deepEqual(await writes(), ["light", names[4], names[4], names[3]]);
    await page.keyboard.press("9");
    await highlight(8);
    await selected(names[8]);
    assert.equal((await writes()).at(-1), names[8]);
    const beforeNavigation = (await writes()).length;
    await page.keyboard.press("Home");
    await highlight(0);
    await page.keyboard.press("ArrowUp");
    await highlight(0);
    await page.keyboard.press("End");
    await highlight(names.length - 1);
    await page.keyboard.press("ArrowDown");
    await highlight(names.length - 1);
    assert.equal((await writes()).length, beforeNavigation);
    const inView = await rows.last().evaluate((button) => {
        const body = button.closest(".overlay-sheet-body").getBoundingClientRect();
        const row = button.getBoundingClientRect();
        return row.top >= body.top && row.bottom <= body.bottom;
    });
    assert.equal(inView, true);
    const swatch = await rows.last().locator(".theme-swatches span").first().evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(swatch, "rgb(16, 24, 32)");
    await page.keyboard.press("1");
    await highlight(0);
    await selected("dark");

    await sheet.getByRole("button", { name: "Tile view" }).click();
    await highlight(0);
    assert.equal(await sheet.evaluate((element) => element.getBoundingClientRect().height), listHeight);
    assert.equal(await sheet.getByRole("button", { name: "Tile view" }).getAttribute("aria-pressed"), "true");
    assert.equal(await rows.nth(0).locator(".theme-preview-check").count(), 1);
    assert.equal(await rows.nth(0).locator(".theme-row-description").count(), 0);
    assert.ok((await rows.last().getAttribute("aria-label")).includes("Crow"));
    assert.ok((await rows.last().getAttribute("title")).includes("Crow"));
    const preview = await rows.last().locator(".theme-preview").evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.getPropertyValue("--theme-sidebar").trim(), style.getPropertyValue("--theme-accent").trim()];
    });
    assert.deepEqual(preview, ["rgb(16, 24, 32)", "#152637", "#cc9922"]);
    await capture("tile");
    const beforeGridNavigation = (await writes()).length;
    await page.keyboard.press("ArrowRight");
    await highlight(1);
    await page.keyboard.press("ArrowDown");
    await highlight(3);
    await page.keyboard.press("ArrowLeft");
    await highlight(2);
    await page.keyboard.press("ArrowUp");
    await highlight(0);
    await page.keyboard.press("ArrowLeft");
    await highlight(0);
    await page.keyboard.press("End");
    await highlight(names.length - 1);
    await page.keyboard.press("ArrowRight");
    await highlight(names.length - 1);
    assert.equal((await writes()).length, beforeGridNavigation);
    await page.keyboard.press("Enter");
    await selected(names.at(-1));
    assert.equal((await writes()).length, beforeGridNavigation + 1);
    await page.keyboard.press("2");
    await highlight(1);
    await selected("light");
    assert.equal((await writes()).length, beforeGridNavigation + 2);
    await sheet.locator(".session-sheet-foot").click({ position: { x: 2, y: 2 } });
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BODY");
    await page.keyboard.press("Enter");
    await selected("light");
    assert.equal((await writes()).length, beforeGridNavigation + 3);
    await capture("tile-light");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await openSheet();
    assert.equal(await sheet.getByRole("button", { name: "Tile view" }).getAttribute("aria-pressed"), "true");
    await highlight(1);
    await page.reload();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await openSheet();
    assert.equal(await sheet.getByRole("button", { name: "Tile view" }).getAttribute("aria-pressed"), "true");
    await selected("light");
    await page.keyboard.press("Escape");
    await app.close();
    await launch();
    await openSheet();
    assert.equal(await page.locator('[data-overlay="themes"] button[aria-label="Tile view"]').getAttribute("aria-pressed"), "true");
    await selected("light");
    await page.locator('[data-overlay="themes"] button[aria-label="List view"]').click();
    assert.equal(await page.locator('[data-overlay="themes"] button[aria-label="List view"]').getAttribute("aria-pressed"), "true");
    await capture("list-light");
    console.log("theme picker e2e passed: navigation, single application, imported colors and persisted views");
} finally {
    await trial.cleanup();
    for (const pid of [...electronPids, hostPid]) {
        if (pid === undefined) continue;
        for (let attempt = 0; attempt < 100 && !exited(pid); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(exited(pid), `Trial process ${pid} is still running`);
    }
    assert(!existsSync(trial.trialRoot), "Trial home was not removed");
    console.log("trial cleanup verified: Electron and host exited; trial home removed");
}

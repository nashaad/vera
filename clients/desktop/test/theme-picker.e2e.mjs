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
        return button?.getAttribute("data-theme-index") === String(expected);
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
    const search = sheet.getByRole("textbox", { name: "Search themes" });
    await rows.last().waitFor();
    const names = await rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-theme-name")));
    assert.equal(names[0], "dark");
    assert.equal(names[1], "light");
    assert.equal(names.at(-1), "imported:crow.night");
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    assert.equal(await sheet.getByRole("button", { name: "Tile view" }).getAttribute("aria-pressed"), "true");
    await sheet.getByRole("button", { name: "List view" }).click();
    assert.equal(await sheet.getByRole("button", { name: "List view" }).getAttribute("aria-pressed"), "true");
    assert.equal(await rows.nth(0).locator(".theme-swatches span").count(), 3);
    assert.equal(await rows.nth(0).locator(".theme-row-check").count(), 1);
    await highlight(0);
    const listHeight = await sheet.evaluate((element) => element.getBoundingClientRect().height);
    await capture("list");

    await search.focus();
    await page.keyboard.type("l");
    await highlight(0);
    assert.equal(await rows.nth(0).getAttribute("data-theme-name"), "light");
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light");
    await page.keyboard.type("ight");
    assert.deepEqual(await rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-theme-name"))), [
        "light", "github-light", "gruvbox-light-hard", "dark",
    ]);
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(await writes(), []);
    await search.fill("");
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
    await page.keyboard.type("gruv");
    assert.deepEqual(await rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-theme-name"))), [
        "gruvbox-dark-hard", "gruvbox-light-hard",
    ]);
    await highlight(0);
    assert.equal(await search.getAttribute("aria-activedescendant"), await rows.nth(0).getAttribute("id"));
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "gruvbox-dark-hard");
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await press(app, "Down");
    await highlight(1);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "gruvbox-light-hard");
    await page.keyboard.type(" light");
    await highlight(0);
    assert.equal(await rows.count(), 1);
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Home");
    assert.equal(await search.evaluate((element) => element.selectionStart), 0);
    await page.keyboard.press("End");
    assert.equal(await search.evaluate((element) => element.selectionStart), "gruv light".length);
    await highlight(0);
    assert.deepEqual(await writes(), []);

    await search.fill("zzz");
    assert.equal(await sheet.getByText("No themes match").count(), 1);
    assert.equal(await rows.count(), 0);
    assert.equal(await search.getAttribute("aria-activedescendant"), null);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
    await page.keyboard.press("Enter");
    assert.deepEqual(await writes(), []);
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "");
    await highlight(0);
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.type("1");
    assert.equal(await search.inputValue(), "1");
    assert.deepEqual(await writes(), []);
    await page.keyboard.press("Escape");
    assert.equal(await search.inputValue(), "");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    await openSheet();
    assert.equal(await search.inputValue(), "");
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("ArrowDown");
    await highlight(1);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "light");
    await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        contents.sendInputEvent({ type: "char", keyCode: "\r" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    });
    await selected("light");
    assert.deepEqual(await writes(), ["light"]);
    await page.keyboard.press("ArrowUp");
    await highlight(0);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");

    await openSheet();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await sheet.getByRole("button", { name: "Tile view" }).evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Space");
    assert.equal(await sheet.getByRole("button", { name: "Tile view" }).getAttribute("aria-pressed"), "true");
    assert.equal(await sheet.evaluate((element) => element.getBoundingClientRect().height), listHeight);
    await search.focus();
    await search.fill("light");
    assert.deepEqual(await rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-theme-name"))), [
        "light", "github-light", "gruvbox-light-hard", "dark",
    ]);
    await highlight(0);
    await search.fill("gruv");
    await highlight(0);
    await page.keyboard.press("ArrowRight");
    await highlight(1);
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Enter");
    await selected("gruvbox-light-hard");
    assert.deepEqual(await writes(), ["light", "gruvbox-light-hard"]);
    await search.fill("zzz");
    assert.equal(await sheet.getByText("No themes match").count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "gruvbox-light-hard");
    await search.fill("");
    await highlight(names.indexOf("gruvbox-light-hard"));
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "gruvbox-light-hard");
    await page.keyboard.press("Tab");
    assert.equal(await rows.nth(names.indexOf("gruvbox-light-hard")).evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Space");
    await selected("gruvbox-light-hard");
    await page.keyboard.press("Enter");
    await selected("gruvbox-light-hard");
    assert.deepEqual(await writes(), ["light", "gruvbox-light-hard", "gruvbox-light-hard", "gruvbox-light-hard"]);

    await search.focus();
    await search.fill("imported crow");
    await highlight(0);
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.nth(0).getAttribute("data-theme-name"), "imported:crow.night");
    assert.ok((await rows.nth(0).getAttribute("aria-label")).includes("Crow"));
    assert.ok((await rows.nth(0).getAttribute("title")).includes("Crow"));
    const preview = await rows.nth(0).locator(".theme-preview").evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.getPropertyValue("--theme-sidebar").trim(), style.getPropertyValue("--theme-accent").trim()];
    });
    assert.deepEqual(preview, ["rgb(16, 24, 32)", "#152637", "#cc9922"]);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "imported:crow.night");
    await sheet.getByRole("button", { name: "Close" }).click();
    await sheet.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "gruvbox-light-hard");

    await openSheet();
    await highlight(names.indexOf("gruvbox-light-hard"));
    await page.keyboard.press("Home");
    await highlight(0);
    await page.keyboard.press("ArrowRight");
    await highlight(1);
    await page.keyboard.press("ArrowDown");
    await highlight(3);
    await page.keyboard.press("ArrowLeft");
    await highlight(2);
    await page.keyboard.press("ArrowUp");
    await highlight(0);
    await page.keyboard.press("End");
    await highlight(names.length - 1);
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), names.at(-1));
    assert.equal(await page.evaluate(() => localStorage.getItem("vera.theme")), "gruvbox-light-hard");
    const inView = await rows.last().evaluate((button) => {
        const body = button.closest(".themes-results").getBoundingClientRect();
        const row = button.getBoundingClientRect();
        return row.top >= body.top && row.bottom <= body.bottom;
    });
    assert.equal(inView, true);
    await rows.nth(1).click();
    await selected("light");
    await capture("tile-light");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
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
    console.log("theme picker e2e passed: search, navigation, preview, commit and persisted views");
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

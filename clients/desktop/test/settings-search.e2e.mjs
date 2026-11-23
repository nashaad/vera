// Settings search finds rows inside a section, lists them in a floating dropdown, picks one with the keyboard,
// centers it, keeps its highlight until another section is picked, and replays or clears it as specified.
// Run with: node clients/desktop/test/settings-search.e2e.mjs

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { MODIFIER, press, startTrial } from "./trial.mjs";

const proof = process.env.VERA_SETTINGS_SEARCH_SHOTS;
if (proof) mkdirSync(proof, { recursive: true });

const trial = startTrial();

async function openSettings(app, page) {
    await press(app, ",", [MODIFIER]);
    await page.waitForSelector('main[data-page="settings"]', { timeout: 10_000 });
    await page.locator('input[aria-label="Search settings"]').waitFor({ timeout: 10_000 });
}

async function expectCleared(page, search) {
    if (await search.inputValue() !== "") throw new Error("The pick left text in the search box.");
    if (await page.locator("[data-settings-results]").count() !== 0) throw new Error("The results list stayed open after a pick.");
}

async function chooseTheme(app, command) {
    await app.evaluate(({ Menu }, id) => {
        Menu.getApplicationMenu().getMenuItemById(id).click();
    }, command);
}

async function sheenOf(row) {
    return row.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return {
            content: style.content,
            animationName: style.animationName,
            backgroundImage: style.backgroundImage,
            pointerEvents: style.pointerEvents,
        };
    });
}

function expectSheen(style, where) {
    if (style.content === "none" || style.content === "normal") throw new Error(`${where}: the row has no sheen pseudo-element.`);
    if (style.animationName !== "settings-sheen-a" && style.animationName !== "settings-sheen-b") {
        throw new Error(`${where}: the sheen animation is ${style.animationName}.`);
    }
    if (style.backgroundImage === "none") throw new Error(`${where}: the sheen has no background.`);
    if (style.pointerEvents !== "none") throw new Error(`${where}: the sheen takes pointer events.`);
}

async function waitForSheen(page, rowId) {
    await page.waitForSelector(`[data-setting-id="${rowId}"][data-sheen]`, { timeout: 10_000 });
}

async function waitForNewSheen(page, rowId, before) {
    await page.waitForFunction(({ rowId, before }) => {
        const sheen = document.querySelector(`[data-setting-id="${rowId}"]`)?.getAttribute("data-sheen");
        return sheen !== null && sheen !== undefined && sheen !== before;
    }, { rowId, before }, { timeout: 10_000 });
}

try {
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await openSettings(app, page);

    const search = page.locator('input[aria-label="Search settings"]');
    const railGroup = page.locator(".settings-rail .rail-group").first();
    const groupBefore = await railGroup.boundingBox();
    if (groupBefore === null) throw new Error("The rail has no group heading.");

    await search.fill("blocks");
    const results = page.locator("[data-settings-results]");
    await results.waitFor({ timeout: 10_000 });
    const groupAfter = await railGroup.boundingBox();
    if (groupAfter === null || Math.abs(groupAfter.y - groupBefore.y) > 1) {
        throw new Error(`The results list moved the rail from ${groupBefore.y} to ${groupAfter?.y}.`);
    }
    const searchBox = await page.locator(".rail-search").boundingBox();
    const resultsBox = await results.boundingBox();
    if (searchBox === null || resultsBox === null) throw new Error("The search box or the results list has no box.");
    if (Math.abs(resultsBox.width - searchBox.width) > 1) {
        throw new Error(`The results are ${resultsBox.width}px wide, the search box ${searchBox.width}px.`);
    }
    if (resultsBox.y < searchBox.y + searchBox.height) throw new Error("The results list is not below the search box.");
    const options = results.getByRole("option");
    if (await options.count() !== 1) throw new Error(`blocks found ${await options.count()} results, expected the one Code size row.`);
    const text = await options.first().innerText();
    if (!text.includes("Code size") || !text.includes("Appearance")) throw new Error(`The result reads "${text}".`);
    if (await options.first().locator("svg").count() !== 1) throw new Error("The setting result has no section icon.");
    if (proof) await page.screenshot({ path: join(proof, "settings-search-results.png") });

    // Arrow keys move through the results; Enter picks the active one.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const pickedAt = Date.now();
    await results.waitFor({ state: "detached", timeout: 10_000 });
    await expectCleared(page, search);
    const selected = await page.locator('.settings-rail .rail-row[aria-current="page"]').innerText();
    if (!selected.includes("Appearance")) throw new Error(`Picking the row selected "${selected}".`);
    const row = page.locator('[data-setting-id="appearance.code-size"]');
    await row.waitFor({ timeout: 10_000 });
    // The outline shows at once; the sheen starts after the row has been placed and the layout is still.
    if (await row.getAttribute("data-search-hit") !== "true") throw new Error("The picked row is not marked as the search hit.");
    await waitForSheen(page, "appearance.code-size");
    if (!["a", "b"].includes(await row.getAttribute("data-sheen"))) throw new Error("The picked row has no sheen run.");
    if (await page.locator(".settings-highlight").count() !== 0) throw new Error("An old highlight overlay is still present.");
    expectSheen(await sheenOf(row), "picked row");

    // The row sits near the middle of the scrolling column.
    const rowBox = await row.boundingBox();
    const mainBox = await page.locator(".settings-main").boundingBox();
    if (rowBox === null || mainBox === null) throw new Error("The row or the settings column has no box.");
    const distance = Math.abs((rowBox.y + rowBox.height / 2) - (mainBox.y + mainBox.height / 2));
    if (distance > mainBox.height * 0.4) throw new Error(`The row is ${Math.round(distance)}px from the middle of the view.`);

    // Mid-sheen, then still highlighted well after any drawing would have finished.
    await page.waitForTimeout(Math.max(0, 350 - (Date.now() - pickedAt)));
    if (proof) await page.screenshot({ path: join(proof, "settings-search-sheen.png") });
    await page.waitForTimeout(Math.max(0, 3_000 - (Date.now() - pickedAt)));
    if (await row.getAttribute("data-search-hit") !== "true") throw new Error("The highlight left before three seconds.");
    if (proof) await page.screenshot({ path: join(proof, "settings-search-still.png") });

    // The same row keeps its highlight in the light theme.
    await chooseTheme(app, "theme.light");
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light", null, { timeout: 10_000 });
    await page.waitForTimeout(200);
    if (await row.getAttribute("data-search-hit") !== "true") throw new Error("The light theme removed the highlight.");
    expectSheen(await sheenOf(row), "light theme row");
    if (proof) await page.screenshot({ path: join(proof, "settings-search-still-light.png") });

    // Picking the same row again replays the sheen and keeps the highlight.
    const sheenBefore = await row.getAttribute("data-sheen");
    await search.fill("blocks");
    await results.waitFor({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await results.waitFor({ state: "detached", timeout: 10_000 });
    await expectCleared(page, search);
    await row.waitFor({ timeout: 10_000 });
    if (await row.getAttribute("data-search-hit") !== "true") throw new Error("The repeat pick cleared the row highlight.");
    await waitForNewSheen(page, "appearance.code-size", sheenBefore);
    expectSheen(await sheenOf(row), "repeat pick");

    // A new search and Escape close the list without clearing the highlight.
    await search.fill("blocks");
    await results.waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expectCleared(page, search);
    if (await row.getAttribute("data-search-hit") !== "true") throw new Error("Escape cleared the row highlight.");

    // Another section from the rail clears it; coming back shows no stale highlight.
    await page.locator('.settings-rail .rail-row', { hasText: "Data" }).click();
    await page.locator('[data-setting-id="data.sessions"]').waitFor({ timeout: 10_000 });
    if (await page.locator("[data-search-hit]").count() !== 0) throw new Error("A rail pick left the search highlight behind.");
    await page.locator('.settings-rail .rail-row', { hasText: "Appearance" }).click();
    await row.waitFor({ timeout: 10_000 });
    if (await row.getAttribute("data-search-hit") !== null) throw new Error("The old row came back highlighted.");

    // A picked row stays centered while its section loads content after it opens.
    await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get("vera:provider-list");
        ipcMain.removeHandler("vera:provider-list");
        ipcMain.handle("vera:provider-list", async (...args) => {
            globalThis.settingsSearchProviderListWaiting = true;
            await new Promise((resolve) => setTimeout(resolve, 800));
            ipcMain.removeHandler("vera:provider-list");
            ipcMain.handle("vera:provider-list", original);
            return original(...args);
        });
    });
    await search.fill("fallback");
    await results.waitFor({ timeout: 10_000 });
    const fallbackOption = results.getByRole("option", { name: /Fall back after failures/ });
    if (await fallbackOption.count() !== 1) throw new Error(`fallback found ${await fallbackOption.count()} results, expected the Fall back row.`);
    await fallbackOption.click();
    await results.waitFor({ state: "detached", timeout: 10_000 });
    await expectCleared(page, search);
    const fallback = page.locator('[data-setting-id="providers.fallback"]');
    await fallback.waitFor({ timeout: 10_000 });
    if (await fallback.getAttribute("data-search-hit") !== "true") throw new Error("The picked Fall back row is not highlighted.");
    await page.locator(".provider-cards").waitFor({ timeout: 10_000 });
    if (await app.evaluate(() => globalThis.settingsSearchProviderListWaiting !== true)) {
        throw new Error("The provider list did not wait, so the late layout was not exercised.");
    }
    await page.waitForTimeout(1_200);
    const inView = await fallback.evaluate((element) => {
        const main = element.closest(".settings-main");
        if (!(main instanceof HTMLElement)) return false;
        const rowBox = element.getBoundingClientRect();
        const mainBox = main.getBoundingClientRect();
        return rowBox.top >= mainBox.top && rowBox.bottom <= mainBox.bottom;
    });
    if (!inView) throw new Error("The Fall back row ended up outside the visible settings column.");
    if (await fallback.getAttribute("data-search-hit") !== "true") throw new Error("The Fall back row lost its highlight after the provider list loaded.");
    await waitForSheen(page, "providers.fallback");
    if (proof) await page.screenshot({ path: join(proof, "settings-search-fallback.png") });

    // The narrow rail: the same box-width list floats under the box and the section rows stay put.
    await page.setViewportSize({ width: 560, height: 800 });
    await page.locator('.settings-split[data-rail="icons"]').waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Search settings" }).click();
    const narrowSearch = page.locator('input[aria-label="Search settings"]');
    await narrowSearch.waitFor({ timeout: 10_000 });
    const narrowRow = page.locator(".settings-rail .rail-row").first();
    const narrowBefore = await narrowRow.boundingBox();
    if (narrowBefore === null) throw new Error("The narrow rail has no section row.");
    await narrowSearch.fill("blocks");
    const narrowResults = page.locator("[data-settings-results]");
    await narrowResults.waitFor({ timeout: 10_000 });
    const narrowAfter = await narrowRow.boundingBox();
    if (narrowAfter === null || Math.abs(narrowAfter.y - narrowBefore.y) > 1) {
        throw new Error(`The narrow results list moved the rail from ${narrowBefore.y} to ${narrowAfter?.y}.`);
    }
    const narrowBox = await page.locator(".rail-search").boundingBox();
    const narrowResultsBox = await narrowResults.boundingBox();
    if (narrowBox === null || narrowResultsBox === null) throw new Error("The narrow search box or results list has no box.");
    if (Math.abs(narrowResultsBox.width - narrowBox.width) > 1) {
        throw new Error(`The narrow results are ${narrowResultsBox.width}px wide, the search box ${narrowBox.width}px.`);
    }
    if (narrowResultsBox.y < narrowBox.y + narrowBox.height) throw new Error("The narrow results list is not below the search box.");

    console.log("settings-search e2e passed");
} finally {
    await trial.cleanup();
}

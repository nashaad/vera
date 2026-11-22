import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});

const trial = startTrial();
let app;
let page;
let failed = false;

async function openPalette(query) {
    await press(app, "K", [MODIFIER]);
    const input = page.getByRole("textbox", { name: "Command palette" });
    await input.fill(query);
    return input;
}

async function assertGenericPage(expectedLabel) {
    const pane = page.locator('[data-location="rightPane"]');
    const tab = pane.locator('[data-tab][data-container="page.generic"][data-active="true"]');
    await tab.waitFor({ timeout: 15_000 });
    await until(`${expectedLabel} selected in the right pane`, async () => await tab.getAttribute("aria-label") === expectedLabel);
    await pane.locator("iframe:visible").waitFor({ timeout: 15_000 });
    if (await pane.locator('input[aria-label="Address"]:visible').count() !== 0) {
        throw new Error(`${expectedLabel} opened in the Browser instead of a PageFrame tab.`);
    }
    await page.frameLocator('[data-location="rightPane"] iframe:visible').getByText("Crow page content").waitFor({ timeout: 30_000 });
    const browserState = await page.evaluate(() => window.veraDesktop.browser("state"));
    if (browserState.tabs.length !== 0) throw new Error(`${expectedLabel} created a Browser tab.`);
    const externalOpens = await app.evaluate(() => globalThis.externalOpenRequests);
    if (externalOpens.length !== 0) throw new Error(`${expectedLabel} requested an external open: ${externalOpens.join(", ")}.`);
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const extension = join(trial.home, "test-pages");
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.pages", version: "1.0.0", sdk: "1", entrypoint: "extension.ts", capabilities: [],
        contributes: { pages: [{ id: "loot", label: "Plain page", server: "server.ts", browser: "page.ts" }] },
    }));
    writeFileSync(join(extension, "extension.ts"), "export function activate() {}\n");
    writeFileSync(join(extension, "server.ts"), "export function activatePage() {}\n");
    writeFileSync(join(extension, "page.ts"), 'export function mount(root) { root.textContent = "Crow page content"; }\n');
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.extensions = [{ path: extension, enabled: true, config: {} }];
    writeFileSync(configPath, JSON.stringify(config));
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    console.log(`Trial home: ${trial.home}; desktop: ${app.process().pid}; host: ${trial.hostPid()}`);

    await app.evaluate(({ shell }) => {
        globalThis.externalOpenRequests = [];
        shell.openExternal = async (url) => { globalThis.externalOpenRequests.push(url); };
    });

    await openPalette("Plain page");
    await page.locator('[data-command="page.extension.%2Fx%2Ftest.pages%2Floot"]').waitFor({ timeout: 45_000 });
    await page.keyboard.press("Escape");
    await press(app, "B", [MODIFIER, "alt"]);
    const pane = page.locator('[data-location="rightPane"]');
    await pane.locator("[data-pane-tiles]").waitFor({ timeout: 15_000 });
    if (await pane.locator('[data-pane-tile="page.generic"]').count() !== 0) throw new Error("Generic pages appeared as a pane tile.");
    await pane.locator('[data-pane-tile="core.browser"]').click();
    await page.locator("[data-pane-launcher]").click();
    await page.locator('[role="listbox"] input').waitFor({ timeout: 15_000 });
    if (await page.locator('[data-pane-option="page.generic"]').count() !== 0) throw new Error("Generic pages appeared in the pane launcher.");
    await page.keyboard.press("Escape");
    await press(app, "W", [MODIFIER]);
    await pane.locator("[data-pane-tiles]").waitFor({ timeout: 15_000 });
    const palette = await openPalette("Vera's Pages");
    await palette.press("Enter");
    const pagesPicker = page.getByRole("dialog", { name: "Vera's Pages" });
    await pagesPicker.waitFor();
    await pagesPicker.getByRole("textbox", { name: "Vera's Pages" }).fill("Plain page");
    await pagesPicker.locator(".palette-row", { hasText: "Plain page" }).click();
    await assertGenericPage("Plain page");
    await pane.locator('[data-page-reload]').click();
    await page.frameLocator('[data-location="rightPane"] iframe:visible').getByText("Crow page content").waitFor({ timeout: 30_000 });
    await pane.getByRole("button", { name: "Open in your browser" }).click();
    await until("explicit external page open", async () => (await app.evaluate(() => globalThis.externalOpenRequests)).length === 1);
    await app.evaluate(() => { globalThis.externalOpenRequests = []; });

    if (await page.locator('[data-location="sidebar"] [data-container="page.generic"]').count() !== 0) throw new Error("Generic pages appeared in the sidebar.");
    const browserCommand = await openPalette("Open a web page");
    await browserCommand.press("Enter");
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.waitFor();
    const annex = await page.evaluate(() => window.veraDesktop.readAnnexPages());
    if (!annex.ok) throw new Error(`The annex page list is unavailable: ${annex.reason}`);
    await address.fill(new URL("/x/test.pages/loot?from=browser", annex.url).href);
    await address.press("Enter");
    await assertGenericPage("Plain page");
    await pane.getByRole("tab", { name: "Browser" }).click();
    if (await address.inputValue() !== "") throw new Error("The Browser navigated to the annex address.");
    await address.fill(new URL("/unlisted?crow=1", annex.url).href);
    await address.press("Enter");
    const unlisted = pane.locator('[data-tab][data-container="page.generic"][data-active="true"]');
    await until("unlisted page tab title", async () => await unlisted.getAttribute("aria-label") === "/unlisted?crow=1");
    await pane.locator('iframe[title="/unlisted?crow=1"]').waitFor({ timeout: 15_000 });
    if (await app.evaluate(() => globalThis.externalOpenRequests.length) !== 0) throw new Error("An unlisted annex address requested an external open.");

    await pane.getByRole("tab", { name: "Browser" }).click();
    await address.fill("/api/pages");
    await address.press("Enter");
    const listing = pane.locator('[data-tab][data-container="page.generic"][data-active="true"]');
    await until("annex page listing tab", async () => await listing.getAttribute("aria-label") === "/api/pages");
    const listingBody = page.frameLocator('[data-location="rightPane"] iframe:visible').locator("body");
    await until("annex page listing content", async () => (await listingBody.textContent())?.includes("test.pages") === true);
    const genericCount = await pane.locator('[data-tab][data-container="page.generic"]').count();
    await pane.getByRole("tab", { name: "Browser" }).click();
    await address.fill("/api/pages");
    await address.press("Enter");
    await until("existing annex page listing selected", async () => await listing.getAttribute("aria-label") === "/api/pages");
    if (await pane.locator('[data-tab][data-container="page.generic"]').count() !== genericCount) throw new Error("Reopening an annex address added another tab.");

    await openPalette("Usage");
    await page.locator('[data-command="page.usage"]').waitFor({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    await pane.locator('[data-tab][data-container="page:/usage"]').waitFor({ timeout: 15_000 });
    await app.close();
    app = undefined;
    const saved = JSON.parse(readFileSync(join(trial.home, "machine/desktop/layout.json"), "utf8"));
    if (saved.tabs.some((tab) => tab.container === "page.generic")) throw new Error("The saved layout included a generic page tab.");
    if (!saved.tabs.some((tab) => tab.container === "page:/usage")) throw new Error("The saved layout lost its dedicated page tab.");
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    console.log(`Relaunched desktop: ${app.process().pid}; host: ${trial.hostPid()}`);
    await page.locator('[data-location="rightPane"] [data-tab][data-container="page:/usage"]').waitFor({ timeout: 30_000 });
    if (await page.locator('[data-tab][data-container="page.generic"]').count() !== 0) throw new Error("A generic page tab returned after restart.");

    console.log("generic page frame e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) {
        console.error("Pane text:", await page.locator('[data-location="rightPane"]').first().innerText().catch(() => "unreadable"));
        console.error("Browser state:", await page.evaluate(() => window.veraDesktop.browser("state")).catch(() => undefined));
        console.error("Annex pages:", await page.evaluate(() => window.veraDesktop.readAnnexPages()).catch(() => undefined));
        console.error("Picker text:", await page.locator('[data-overlay="picker"]').innerText({ timeout: 1_000 }).catch(() => "unreadable"));
    }
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);

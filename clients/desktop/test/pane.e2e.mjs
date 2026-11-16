// Right pane test for the desktop shell: tiles while there is no tab, the "+" launcher, duplicate tabs,
// closing, a web address opening a Browser tab, the Browser limit, and the tab list surviving a relaunch.
// Needs the built annex page: bun run pack:web. Run with: node clients/desktop/test/pane.e2e.mjs
// Set VERA_PANE_SHOTS to a folder to save screenshots of the tiles and the launcher there.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});
const site = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url?.startsWith("/other")
        ? "<title>Other page</title><p>other</p>"
        : "<title>Crow page</title><p>crow</p>");
});

const trial = startTrial();
// Under Auto these parts wait for a session or for something to report; the pane is what is under test.
trial.writeFlags({ work: "on", output: "on", review: "on", plan: "on", files: "on" });
let failed = false;
let page;
let app;

const strip = '[data-switcher="rightPane"]';
const tabs = () => page.locator(`${strip} [data-tab]`);
const tabsOf = (container) => page.locator(`${strip} [data-tab][data-container="${container}"]`);
const containers = async () => (await tabs().evaluateAll((nodes) => nodes.map((node) => node.dataset.container)));
const tiles = () => page.locator("[data-pane-tile]");
const options = () => page.locator("[data-pane-option]");
const launcherInput = () => page.locator('[role="listbox"] input');

async function boot() {
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
}

async function shoot(name) {
    const folder = process.env.VERA_PANE_SHOTS;
    if (folder === undefined || folder === "") return;
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: join(folder, name) });
}

async function openLauncher() {
    await page.locator("[data-pane-launcher]").click();
    await launcherInput().waitFor({ timeout: 5_000 });
}

async function openKind(container) {
    await openLauncher();
    await page.locator(`[data-pane-option="${container}"]`).click();
    await launcherInput().waitFor({ state: "detached", timeout: 5_000 });
}

// The pages the shell holds, shown or not.
async function webPages() {
    return app.evaluate(({ webContents }, port) => webContents.getAllWebContents()
        .filter((contents) => !contents.isDestroyed() && contents.getURL().startsWith(`http://127.0.0.1:${port}`)).length, site.address().port);
}

async function savedTabs() {
    const path = join(trial.home, "machine", "desktop", "layout.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const address = `http://127.0.0.1:${site.address().port}/site`;
    await boot();

    // With no tab, the pane shows one tile per kind and nothing else.
    await press(app, "B", [MODIFIER, "alt"]);
    await page.waitForSelector("[data-pane-tiles]", { timeout: 10_000 });
    const tileKinds = await tiles().evaluateAll((nodes) => nodes.map((node) => node.dataset.paneTile));
    if (tileKinds.join() !== "core.review,core.plan,core.files,core.browser,core.chat") throw new Error(`The tiles are ${tileKinds.join()}.`);
    if (await tabs().count() !== 0) throw new Error("The pane has a tab before one was opened.");
    if ((await page.locator('[data-pane-tile="core.chat"]').innerText()).trim() !== "Help") throw new Error("The Chat tile is not labelled Help.");
    await shoot("pane-tiles.png");

    // A tile opens a new tab of its kind and the tiles give way to it.
    await page.locator('[data-pane-tile="core.plan"]').click();
    await tabsOf("core.plan").first().waitFor({ timeout: 5_000 });
    if (await page.locator("[data-pane-tiles]").count() !== 0) throw new Error("The tiles stay beside an open tab.");

    // The "+" lists the kinds, filters them, and opens a new tab for each pick, so a kind can be open twice.
    await openLauncher();
    if ((await options().evaluateAll((nodes) => nodes.map((node) => node.dataset.paneOption))).join() !== "core.review,core.plan,core.files,core.browser,core.chat") {
        throw new Error("The launcher does not list every kind.");
    }
    if ((await page.locator('[data-pane-option="core.chat"] .pane-launcher-title').innerText()).trim() !== "Help") throw new Error("The Chat entry is not labelled Help.");
    await shoot("pane-launcher.png");
    await launcherInput().fill("fi");
    await until("the filter to narrow to Files", async () => (await options().evaluateAll((nodes) => nodes.map((node) => node.dataset.paneOption))).join() === "core.files");
    await launcherInput().fill("zzz");
    await page.getByText("No pane matches").waitFor({ timeout: 5_000 });
    await launcherInput().fill("");
    await page.keyboard.press("ArrowDown");
    await until("the second row focused", async () => (await page.locator('[data-pane-option][data-focused="true"]').getAttribute("data-pane-option")) === "core.plan");
    await page.keyboard.press("Escape");
    await launcherInput().waitFor({ state: "detached", timeout: 5_000 });
    await openLauncher();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await until("a second Plan tab", async () => (await tabsOf("core.plan").count()) === 2);
    await openKind("core.files");
    if ((await containers()).join() !== "core.plan,core.plan,core.files") throw new Error(`The strip is ${(await containers()).join()}.`);
    if ((await tabs().last().getAttribute("data-active")) !== "true") throw new Error("The new tab is not the active one.");

    // Closing a tab takes it off the strip; the last one closed brings the tiles back.
    await tabs().first().hover();
    await page.locator(`${strip} .switcher-close`).first().click();
    await until("one Plan tab left", async () => (await containers()).join() === "core.plan,core.files");
    await page.locator(`${strip} .switcher-close`).last().click();
    await page.locator(`${strip} .switcher-close`).last().click();
    await page.waitForSelector("[data-pane-tiles]", { timeout: 5_000 });

    // A web address typed in the launcher comes first and opens a Browser tab on that page.
    await openLauncher();
    await launcherInput().fill(address);
    const first = await options().first().getAttribute("data-pane-option");
    if (first !== "address") throw new Error(`The first row for an address is ${first}.`);
    await page.keyboard.press("Enter");
    await until("the page in the pane", async () => (await webPages()) === 1);
    await until("the page's title on the tab", async () => (await tabsOf("core.browser").first().innerText()).includes("Crow page"));
    if (await tabsOf("core.browser").count() !== 1) throw new Error("The address opened more than one tab.");

    // A tile or a pick of Browser opens a tab with no page; a page of Vera's own reuses it.
    await openKind("core.browser");
    await until("two Browser tabs", async () => (await tabsOf("core.browser").count()) === 2);
    await press(app, "K", [MODIFIER]);
    await page.waitForSelector('.palette[data-overlay="palette"]');
    await page.keyboard.type("Usage");
    await until("Usage under Pages", async () => (await page.locator(".palette-row", { hasText: "Usage" }).count()) > 0);
    await page.keyboard.press("Enter");
    await page.locator("[data-location=\"rightPane\"] iframe.browser-frame").waitFor({ timeout: 30_000 });
    if (await tabsOf("core.browser").count() !== 2) throw new Error("A page of Vera's own opened a third Browser tab.");
    if (await webPages() !== 1) throw new Error("A page of Vera's own closed the web page.");

    // Closing the tab that holds a page closes the page.
    await tabsOf("core.browser").first().hover();
    await page.locator(`${strip} .switcher-pill:has([data-container="core.browser"]) .switcher-close`).first().click();
    await until("the page closed", async () => (await webPages()) === 0);
    await until("one Browser tab left", async () => (await tabsOf("core.browser").count()) === 1);

    // Browser stops at its limit in the launcher while the other kinds stay open.
    while (await tabsOf("core.browser").count() < 12) {
        const count = await tabsOf("core.browser").count();
        await openKind("core.browser");
        await until("another Browser tab", async () => (await tabsOf("core.browser").count()) === count + 1);
    }
    await openLauncher();
    if ((await page.locator('[data-pane-option="core.browser"]').getAttribute("aria-disabled")) !== "true") throw new Error("Browser is open past its limit.");
    if ((await page.locator('[data-pane-option="core.plan"]').getAttribute("aria-disabled")) !== "false") throw new Error("Plan is closed at the Browser limit.");
    await page.locator('[data-pane-option="core.browser"]').click({ force: true });
    await page.keyboard.press("Escape");
    if (await tabsOf("core.browser").count() !== 12) throw new Error("A pick of Browser at its limit opened a tab.");

    // Dragging a tab to the panel moves its kind there and closes that kind's tabs in the pane.
    await openKind("core.plan");
    await openKind("core.plan");
    await tabsOf("core.plan").first().waitFor();
    const source = await tabsOf("core.plan").first().boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2 + 12, { steps: 4 });
    await page.waitForSelector('[data-drop-zone="panel"]', { timeout: 5_000 });
    const strip2 = await page.locator('[data-drop-zone="panel"]').boundingBox();
    await page.mouse.move(strip2.x + strip2.width / 2, strip2.y + strip2.height / 2, { steps: 8 });
    await page.mouse.up();
    await until("the Plan tabs gone from the pane", async () => (await tabsOf("core.plan").count()) === 0);
    await page.waitForSelector('[data-location="panel"] [data-container="core.plan"]', { timeout: 10_000 });
    if ((await page.locator('[data-pane-tile], [data-pane-option="core.plan"]').count()) !== 0) throw new Error("A kind moved out of the pane is still offered there.");
    // The same kind dragged back comes in as one tab.
    await page.locator('[data-location="panel"] [data-container="core.plan"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Right Pane" }).click();
    await until("one Plan tab back", async () => (await tabsOf("core.plan").count()) === 1);

    // Tabs are saved in order, Browser tabs are not, and a relaunch brings the rest back.
    await openKind("core.files");
    await tabsOf("core.files").first().click();
    await until("the tab list on disk", async () => {
        const saved = await savedTabs();
        return saved !== undefined && Array.isArray(saved.tabs) && saved.tabs.length > 0 && saved.tabs.every((tab) => tab.container !== "core.browser");
    });
    const before = await savedTabs();
    const expected = before.tabs.map((tab) => tab.container).join();
    if (!expected.includes("core.files") || !expected.includes("core.plan")) throw new Error(`The saved tabs are ${expected}.`);
    await app.close();
    await boot();
    await tabs().first().waitFor({ timeout: 15_000 });
    if ((await containers()).join() !== expected) throw new Error(`After the relaunch the strip is ${(await containers()).join()}, not ${expected}.`);
    if ((await tabs().evaluateAll((nodes) => nodes.filter((node) => node.dataset.active === "true").map((node) => node.dataset.container))).join() !== "core.files") {
        throw new Error("The active tab was not remembered.");
    }
    if (await tabsOf("core.browser").count() !== 0) throw new Error("A Browser tab came back after the relaunch.");

    console.log("pane e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Tabs:", await tabs().allInnerTexts().catch(() => "unreadable"));
    if (page !== undefined) console.error("Pane text:", await page.locator('[data-location="rightPane"]').first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await new Promise((resolve) => site.close(resolve));
}
process.exit(failed ? 1 : 0);

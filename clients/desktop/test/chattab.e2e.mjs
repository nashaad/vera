// Chat tab test for the desktop shell. Run with: node clients/desktop/test/chattab.e2e.mjs
// Help opens a Chat tab in the right pane while the main pane stays on New Chat. The tile, the "+" launcher
// and the command palette start Help chats too, the kind stops at its limit, and its tabs are not saved.

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const FULL = "Close a Chat tab to open another.";
const LIMIT = 6;

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});

const trial = startTrial();
let failed = false;
let page;
let app;

const pane = '[data-location="rightPane"]';
const strip = `${pane} [data-switcher="rightPane"]`;
const chatTabs = () => page.locator(`${strip} [data-tab][data-container="core.chat"]`);
const activeBody = () => page.locator(`${pane} [data-tab-body]:not([hidden])`);
const savedLayout = () => {
    const path = join(trial.home, "machine", "desktop", "layout.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};

async function boot() {
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
}

async function attached(body) {
    await body.locator('[data-session][data-phase="attached"]').waitFor({ timeout: 45_000 });
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    await boot();

    const help = page.locator(".help-button");
    await until("the Help button to enable", async () => !(await help.isDisabled()), 45_000);
    if ((await help.innerText()).trim() !== "Help") throw new Error("The Help button has no label.");
    if (await page.locator(".home-composer").count() !== 1) throw new Error("The window did not start on New Chat.");
    if (await page.locator(pane).count() !== 0) throw new Error("The right pane is open before Help was pressed.");

    // Help on New Chat opens the pane on a Chat tab holding the chat, and leaves the main pane alone.
    await help.click();
    await chatTabs().first().waitFor({ timeout: 10_000 });
    if ((await chatTabs().first().getAttribute("data-active")) !== "true") throw new Error("The Chat tab is not the active one.");
    const body = activeBody();
    await body.locator('.chat-view[data-chat="help"]').waitFor({ timeout: 10_000 });
    await attached(body);
    await body.locator(".composer-input").waitFor();
    if (await page.locator(".home-composer").count() !== 1) throw new Error("Help took over the main pane.");
    if (await page.locator("main [data-session]").count() !== 0) throw new Error("A session opened in the main pane.");
    if (!/Help/.test(await chatTabs().first().innerText())) throw new Error("The Chat tab is not titled Help.");
    if ((await body.locator(".session-page").getAttribute("data-pane")) === "main") throw new Error("The Chat tab reads the main pane.");

    // The main pane's composer still starts its own chat while a Chat tab is open.
    await page.locator(".home-composer .composer-input").fill("A line for later");
    await page.locator(".home-composer .composer-input").fill("");

    // Closing the last tab brings the tiles back; the Help tile and the launcher's Help row each start a new chat.
    await chatTabs().first().hover();
    await page.locator(`${strip} .switcher-close`).first().click();
    await page.waitForSelector("[data-pane-tiles]", { timeout: 5_000 });
    await page.locator('[data-pane-tile="core.chat"]').click();
    await chatTabs().first().waitFor({ timeout: 10_000 });
    await attached(activeBody());
    await page.locator("[data-pane-launcher]").click();
    await page.locator('[data-pane-option="core.chat"]').click();
    await until("a second Chat tab", async () => (await chatTabs().count()) === 2);
    await attached(activeBody());
    const ids = await page.locator(`${pane} [data-tab-body] [data-session]`).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session")));
    if (new Set(ids).size !== 2) throw new Error(`The two Chat tabs show ${ids.join()}.`);

    // The command the Help menu runs opens a third.
    await press(app, "K", [MODIFIER]);
    const palette = page.locator('input[aria-label="Command palette"]');
    await palette.waitFor({ timeout: 10_000 });
    await palette.fill("help chat");
    await page.locator('.palette-row[data-command="chat.help"]').waitFor({ timeout: 10_000 });
    await palette.press("Enter");
    await until("a third Chat tab", async () => (await chatTabs().count()) === 3);

    // Tabs hidden with the pane come back with it, and the chats reattach.
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator(pane).waitFor({ state: "detached", timeout: 5_000 });
    await press(app, "B", [MODIFIER, "alt"]);
    await until("the three tabs back", async () => (await chatTabs().count()) === 3);
    await attached(activeBody());

    // At the limit Help says so and creates no chat.
    while (await chatTabs().count() < LIMIT) {
        const count = await chatTabs().count();
        await help.click();
        await until("another Chat tab", async () => (await chatTabs().count()) === count + 1);
    }
    const sessions = await page.locator(".app").getAttribute("data-sessions");
    await help.click();
    await page.waitForSelector(`.toast-text:has-text("${FULL}")`, { timeout: 5_000 });
    if ((await chatTabs().count()) !== LIMIT) throw new Error("Help opened a tab past the limit.");
    if ((await page.locator('[data-pane-launcher]').getAttribute("aria-disabled")) === "true") throw new Error("The launcher is disabled while other kinds can open.");
    await page.locator("[data-pane-launcher]").click();
    if ((await page.locator('[data-pane-option="core.chat"]').getAttribute("aria-disabled")) !== "true") throw new Error("Help is offered past the Chat limit.");
    await page.keyboard.press("Escape");
    if ((await page.locator(".app").getAttribute("data-sessions")) !== sessions) throw new Error("Help at the limit created a session.");

    // The saved layout has no Chat tab, and a relaunch brings none back.
    await until("the layout on disk", async () => {
        const saved = savedLayout();
        return saved !== undefined && Array.isArray(saved.tabs);
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (savedLayout().tabs.some((tab) => tab.container === "core.chat")) throw new Error("A Chat tab was saved with the layout.");
    await app.close();
    await boot();
    await page.waitForSelector("[data-pane-tiles]", { timeout: 15_000 });
    if (await chatTabs().count() !== 0) throw new Error("A Chat tab came back after the relaunch.");

    console.log("chat tab e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);

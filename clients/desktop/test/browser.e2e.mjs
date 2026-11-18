// Browser test for the desktop right pane: Vera's pages load from the annex under one tab row,
// the annex drops its own menu there, and the palette and /usage open pages in it.
// Needs the built annex page: bun run pack:web. Run with: node clients/desktop/test/browser.e2e.mjs

import { createServer } from "node:http";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});

let siteLoads = 0;
const site = createServer((request, response) => {
    if (request.url !== "/") { response.writeHead(204); response.end(); return; }
    siteLoads += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>Reload fixture</title><p>Load ${siteLoads}</p>`);
});

const trial = startTrial();
let failed = false;
let page;

try {
    await Promise.all([
        new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve)),
        new Promise((resolve) => site.listen(0, "127.0.0.1", resolve)),
    ]);
    configureFauxHome(trial.home, provider.address().port);

    const app = await trial.launch();
    // Open in your browser must not reach the real browser during a test.
    await app.evaluate(({ shell }) => {
        globalThis.openedExternally = [];
        shell.openExternal = async (url) => {
            globalThis.openedExternally.push(url);
        };
    });
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();
    await app.evaluate(({ BrowserWindow }) => {
        globalThis.shellNavigations = 0;
        BrowserWindow.getAllWindows()[0].webContents.on("did-start-navigation", (_event, _url, _inPlace, main) => { if (main) globalThis.shellNavigations += 1; });
    });
    const composer = page.locator(".composer-input");
    await composer.fill("draft survives reload");
    await press(app, "R", [MODIFIER]);
    await press(app, "R", [MODIFIER, "shift"]);
    if (await composer.inputValue() !== "draft survives reload") throw new Error("No-page shortcut lost the draft.");

    const pane = page.locator("[data-location=\"rightPane\"]");
    const frame = pane.locator("iframe.browser-frame");
    const address = pane.getByRole("textbox", { name: "Address" });
    const back = pane.getByRole("button", { name: "Back" });
    const forward = pane.getByRole("button", { name: "Forward" });
    const inFrame = page.frameLocator("[data-location=\"rightPane\"] iframe.browser-frame");
    const showing = async (label) => {
        await until(`the ${label} page in the browser`, async () => (await frame.count()) === 1 && (await frame.getAttribute("title")) === label);
    };

    await press(app, "K", [MODIFIER]);
    await page.getByRole("textbox", { name: "Command palette" }).fill("internet");
    await page.locator('[data-command="page.openBrowser"]').click();
    await until("new Browser address focused", async () => address.evaluate((input) => document.activeElement === input));

    // The palette lists Vera's pages in their own group and opens one in the right pane.
    await press(app, "K", [MODIFIER]);
    await page.waitForSelector(".palette[data-overlay=\"palette\"]");
    await page.keyboard.type("Usage");
    await until("Usage under Pages", async () => (await page.locator(".palette-row", { hasText: "Usage" }).count()) > 0);
    await page.keyboard.press("Enter");
    await pane.waitFor({ timeout: 10_000 });
    await showing("Usage");
    const src = await frame.getAttribute("src");
    if (!/^http:\/\/127\.0\.0\.1:\d+\/usage$/.test(src ?? "")) throw new Error(`The Usage frame loads ${src}.`);
    const host = new URL(src).host;
    await until("the address bar", async () => (await address.inputValue()) === `${host}/usage`);

    await press(app, "K", [MODIFIER]);
    await page.getByRole("textbox", { name: "Command palette" }).fill("browser");
    await page.locator('[data-command="page.openBrowser"]').click();
    await until("existing Browser address selected", async () => address.evaluate((input) => document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length));
    await showing("Usage");

    // The annex page renders inside the frame without its own menu.
    await inFrame.locator(".page .toolbar .seg").first().waitFor({ timeout: 30_000 });
    await inFrame.locator("body").evaluate(() => { window.reloadSentinel = true; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("vera:event", { type: "command", id: "page.reload.native" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!await inFrame.locator("body").evaluate(() => window.reloadSentinel === true)) throw new Error("Stale native reload targeted the annex.");
    await composer.focus();
    await press(app, "R", [MODIFIER]);
    await until("annex shortcut reload", async () => await inFrame.locator("body").evaluate(() => window.reloadSentinel !== true).catch(() => false));
    if (await composer.inputValue() !== "draft survives reload") throw new Error("Annex shortcut lost the draft.");
    if (await inFrame.locator(".nav-toggle").count() !== 0) throw new Error("The framed annex page still shows its menu.");
    const tabs = await pane.locator("nav[aria-label=\"Vera's pages\"] .browser-tab").allInnerTexts();
    // The included artifacts extension adds a page after the built-in ones.
    if (tabs.slice(1).join() !== "Usage,Runs,Artifacts") throw new Error(`The tab row shows ${tabs.join(", ")}.`);
    if ((await pane.locator("nav[aria-label=\"Vera's pages\"] .browser-tab[aria-current=\"page\"]").innerText()) !== "Usage") throw new Error("The Usage tab is not marked current.");

    // The frame stays on the annex.
    const frameUrls = () => page.frames().slice(1).map((candidate) => candidate.url());
    await inFrame.locator("body").evaluate(() => window.location.assign("http://127.0.0.1:1/"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (frameUrls().join() !== `http://${host}/usage`) throw new Error(`The frame left the annex for another loopback port: ${frameUrls().join(", ")}`);
    // The window's frame-src refuses addresses off loopback before the guard sees them, so the
    // frame shows an error page and Reload brings the page back.
    await inFrame.locator("body").evaluate(() => window.location.assign("http://example.com/"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (frameUrls().some((url) => url.includes("example.com"))) throw new Error(`The frame loaded another site: ${frameUrls().join(", ")}`);
    await pane.getByRole("button", { name: "Reload" }).click();
    await until("the Usage page back after Reload", async () => frameUrls().join() === `http://${host}/usage`);
    await inFrame.locator(".page .toolbar .seg").first().waitFor({ timeout: 30_000 });

    // Open in your browser hands the page to the system browser.
    await pane.getByRole("button", { name: "Open in your browser" }).click();
    await until("the page handed to the system browser", async () => (await app.evaluate(() => globalThis.openedExternally)).join() === `http://${host}/usage`);

    // Home lists the built-in pages, then extension pages.
    await pane.getByRole("button", { name: "All of Vera's pages" }).click();
    await pane.locator(".browser-start").waitFor();
    const start = await pane.locator(".browser-start").innerText();
    for (const expected of ["Vera", "Usage", "Runs", "From extensions", "Artifacts", "/x/", `Served on this machine at ${host}`]) {
        if (!start.includes(expected)) throw new Error(`The start page does not say ${expected}: ${start}`);
    }
    if (await pane.getByRole("button", { name: "Open in your browser" }).isEnabled()) throw new Error("Open in your browser is on for the start page.");
    await pane.locator(".browser-link", { hasText: "Runs" }).click();
    await showing("Runs");
    await inFrame.locator(".page").first().waitFor({ timeout: 30_000 });
    if (await inFrame.locator(".nav-toggle").count() !== 0) throw new Error("The framed Runs page still shows its menu.");

    // An extension page loads in the same frame.
    await pane.locator(".browser-tab", { hasText: "Artifacts" }).click();
    await showing("Artifacts");
    if (!/\/x\/[^/]+\/artifacts$/.test(await frame.getAttribute("src") ?? "")) throw new Error(`The Artifacts frame loads ${await frame.getAttribute("src")}.`);
    await inFrame.locator("body *").first().waitFor({ timeout: 30_000 });
    await back.click();
    await showing("Runs");

    // Back and forward walk Usage, Home, Runs and Artifacts.
    await back.click();
    await pane.locator(".browser-start").waitFor();
    await back.click();
    await showing("Usage");
    await forward.click();
    await pane.locator(".browser-start").waitFor();
    await forward.click();
    await showing("Runs");
    await forward.click();
    await showing("Artifacts");
    if (await forward.isEnabled()) throw new Error("Forward is on at the newest page.");

    // The address bar takes a page's name.
    await address.fill("usage");
    await address.press("Enter");
    await showing("Usage");
    await address.fill("/nowhere");
    await address.press("Enter");
    await pane.getByText("The annex serves nothing at /nowhere").waitFor();

    // /usage in the composer opens the page in the browser.
    await pane.getByRole("button", { name: "All of Vera's pages" }).click();
    await pane.locator(".browser-start").waitFor();
    const input = page.locator(".composer-input");
    await input.fill("/usage");
    await input.press("Enter");
    await showing("Usage");
    if ((await input.inputValue()) !== "") throw new Error("/usage left its text in the box.");

    await address.fill(`http://127.0.0.1:${site.address().port}/`);
    await address.press("Enter");
    await until("native page", () => siteLoads === 1);
    let targetId;
    await until("native page navigation", async () => {
        targetId = await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().includes(`:${port}/`))?.webContents.id, site.address().port);
        return targetId !== undefined;
    });
    await composer.fill("native reload draft");
    await press(app, "R", [MODIFIER]);
    await until("native reload from composer", () => siteLoads === 2);
    await app.evaluate(({ webContents }, { id, modifier }) => {
        const contents = webContents.fromId(id);
        contents.sendInputEvent({ type: "keyDown", keyCode: "R", modifiers: [modifier] });
        contents.sendInputEvent({ type: "keyUp", keyCode: "R", modifiers: [modifier] });
    }, { id: targetId, modifier: MODIFIER });
    await until("native reload from site", () => siteLoads === 3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (siteLoads !== 3) throw new Error(`Native shortcut fired more than once: ${siteLoads}`);
    if (await composer.inputValue() !== "native reload draft") throw new Error("Native shortcut lost the draft.");
    if (await app.evaluate(() => globalThis.shellNavigations) !== 0) throw new Error("Shortcut navigated the shell.");
    console.log("browser e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Pane text:", await page.locator("[data-location=\"rightPane\"]").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => site.close(resolve))]);
}
process.exit(failed ? 1 : 0);

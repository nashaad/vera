import { createServer } from "node:http";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});

const site = createServer((request, response) => {
    if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://localhost:${annexPort}/usage?from=redirect` });
        response.end();
        return;
    }
    if (request.url === "/embed") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<iframe src="http://[::1]:${annexPort}/runs"></iframe>`);
        return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>Allowed website</title><a href="/redirect">redirect</a><a id="annex-link" href="http://localhost:${annexPort}/usage">annex</a><button id="annex-popup" onclick="window.open('http://localhost:${annexPort}/runs')">popup</button>`);
});
let annexPort;

const trial = startTrial();
let failed = false;
let app;
let page;

async function openPalette(page, app, query) {
    await press(app, "K", [MODIFIER]);
    const palette = page.getByRole("textbox", { name: "Command palette" });
    await palette.fill(query);
    return palette;
}

async function openNative(url, page, app) {
    const pane = page.locator('[data-location="rightPane"]');
    const tab = pane.locator('[role="tab"][data-container="core.browser"]').first();
    if (await tab.count() > 0) {
        await tab.click();
        await until("Browser tab selected", async () => await tab.getAttribute("data-active") === "true");
    } else {
        await openPalette(page, app, "Open a web page");
        await page.locator('[data-command="page.openBrowser"]').click();
    }
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.waitFor();
    await address.fill(url);
    await address.press("Enter");
    return pane;
}

try {
    await Promise.all([
        new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve)),
        new Promise((resolve) => site.listen(0, "127.0.0.1", resolve)),
    ]);
    configureFauxHome(trial.home, provider.address().port);
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    let discovered;
    await until("annex available for the trial", async () => {
        discovered = await page.evaluate(() => window.veraDesktop.readAnnexPages());
        return discovered.ok;
    });
    await app.evaluate(({ ipcMain }) => {
        const handler = ipcMain._invokeHandlers.get("vera:annex-pages");
        if (handler === undefined) throw new Error("The annex page handler is not registered.");
        const waiting = [];
        let released = false;
        ipcMain.removeHandler("vera:annex-pages");
        ipcMain.handle("vera:annex-pages", async (event) => {
            const answer = await handler(event);
            if (released) return answer;
            return new Promise((resolve) => waiting.push(() => resolve(answer)));
        });
        globalThis.pendingAnnexReads = () => waiting.length;
        globalThis.holdAnnexReads = () => { released = false; };
        globalThis.releaseAnnexReads = () => {
            released = true;
            for (const resolve of waiting.splice(0)) resolve();
        };
    });
    await page.reload();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await until("annex read held", async () => await app.evaluate(() => globalThis.pendingAnnexReads() > 0));

    const pane = page.locator('[data-location="rightPane"]');
    const earlyUsageUrl = new URL("/usage?attempt=early", discovered.url).href;
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    await press(app, "B", [MODIFIER, "alt"]);
    const tileSearch = pane.locator('[data-pane-tiles] input[aria-label="Search panes"]');
    await tileSearch.waitFor();
    await tileSearch.fill(earlyUsageUrl);
    await tileSearch.press("Enter");
    await openNative(earlyUsageUrl, page, app);
    await page.locator("[data-pane-launcher]").click();
    const launcherSearch = page.locator('[role="listbox"][aria-label="New tab"] input[aria-label="Search panes"]');
    await launcherSearch.fill(siteUrl);
    await launcherSearch.press("Enter");
    await page.waitForTimeout(250);
    const earlyState = await page.evaluate(() => window.veraDesktop.browser("state"));
    if (earlyState.tabs.length !== 0) throw new Error("An unknown-origin loopback address created a native Browser tab.");
    await app.evaluate(() => globalThis.releaseAnnexReads());
    await waitForAnnexPages(page, app);
    if ((await page.evaluate(() => window.veraDesktop.browser("state"))).tabs.length !== 0) throw new Error("An early loopback address opened after the annex was read.");
    if (await pane.locator("iframe:visible").count() !== 0) throw new Error("An early annex address opened without being retried.");
    await openNative(earlyUsageUrl, page, app);
    await pane.locator('iframe[title="Usage"]:visible').waitFor({ timeout: 15_000 });
    const retriedUrl = await pane.locator('iframe[title="Usage"]:visible').getAttribute("src");
    if (!retriedUrl?.includes("attempt=early")) throw new Error(`The retried annex address loaded ${retriedUrl}.`);

    await app.evaluate(() => globalThis.holdAnnexReads());
    await page.evaluate(() => window.veraDesktop.reconnect());
    await until("annex read held after reconnect", async () => await app.evaluate(() => globalThis.pendingAnnexReads() > 0));
    await openPalette(page, app, "Artifacts");
    await until("old annex command removed after reconnect", async () => await page.locator('[data-command="page.extension.%2Fx%2Fvera.artifacts%2Fartifacts"]').count() === 0);
    await page.keyboard.press("Escape");
    await openNative(earlyUsageUrl, page, app);
    await openNative(siteUrl, page, app);
    if ((await page.evaluate(() => window.veraDesktop.browser("state"))).tabs.length !== 0) throw new Error("A loopback address opened while the annex was being rediscovered.");
    if (await pane.locator('iframe[title="Usage"]:visible').count() !== 0) throw new Error("The stale annex page opened during reconnect.");
    await app.evaluate(() => globalThis.releaseAnnexReads());
    await waitForAnnexPages(page, app);
    if ((await page.evaluate(() => window.veraDesktop.browser("state"))).tabs.length !== 0) throw new Error("A reconnect address opened without being retried.");
    await openNative(earlyUsageUrl, page, app);
    await pane.locator('iframe[title="Usage"]:visible').waitFor({ timeout: 15_000 });

    const openPage = async (label, expectedPath) => {
        await openPalette(page, app, label);
        await page.locator(".palette-row", { hasText: label }).first().click();
        const frame = pane.locator("iframe:visible").first();
        await frame.waitFor({ timeout: 15_000 });
        await pane.getByRole("button", { name: "Reload" }).waitFor();
        if (await pane.getByRole("textbox", { name: "Address" }).count() !== 0) throw new Error(`${label} opened in the Browser instead of as a Vera page.`);
        if (await pane.getByRole("button", { name: "Select element" }).count() !== 0) throw new Error(`${label} offers Browser annotation controls.`);
        const source = await frame.getAttribute("src");
        if (new URL(source ?? "about:blank").pathname !== expectedPath) throw new Error(`${label} loaded ${source}, expected ${expectedPath}.`);
    };

    await openPage("Usage", "/usage");
    const usageFrame = pane.locator("iframe:visible").first();
    await usageFrame.evaluate((frame) => { frame.dataset.reloadProof = "before"; });
    await press(app, "R", [MODIFIER]);
    await until("shortcut reloads the active app page", async () => await usageFrame.getAttribute("data-reload-proof") === null);
    const usageUrl = await usageFrame.getAttribute("src");
    if (usageUrl === null) throw new Error("The Usage page has no frame URL.");
    const usage = new URL(usageUrl);
    annexPort = Number(usage.port);

    await openPage("Workflow runs", "/runs");
    await openPage("Artifacts", "/x/vera.artifacts/artifacts");

    const directUrl = `http://127.0.0.1:${annexPort}/usage?session=fixture&artifact=example`;
    const browserPane = await openNative(directUrl, page, app);
    await until("typed Vera URL returned to the app page", async () => await browserPane.locator("iframe:visible").count() === 1);
    const appPageUrl = await browserPane.locator("iframe:visible").getAttribute("src");
    if (!appPageUrl?.includes("session=fixture") || !appPageUrl.includes("artifact=example")) throw new Error(`The typed app URL lost its query: ${appPageUrl}`);
    if (await browserPane.getByRole("textbox", { name: "Address" }).count() !== 0) throw new Error("A typed Vera URL remained in the Browser.");
    if (await browserPane.getByRole("button", { name: "Select element" }).count() !== 0) throw new Error("A Vera page offers annotation controls.");

    const childUrls = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
        .map((child) => child.webContents?.getURL()).filter(Boolean));
    await app.evaluate(({ session }) => {
        globalThis.blockedAnnexRequests = [];
        globalThis.completedBrowserRequests = [];
        const requests = session.fromPartition("vera-browser").webRequest;
        requests.onErrorOccurred((details) => {
            if (details.error.includes("BLOCKED")) globalThis.blockedAnnexRequests.push(details.url);
        });
        requests.onCompleted((details) => globalThis.completedBrowserRequests.push(details.url));
    });
    const wasBlocked = (path) => app.evaluate((_electron, value) => globalThis.blockedAnnexRequests.some((url) => url.includes(value)), path);
    const wasCompleted = (path) => app.evaluate((_electron, value) => globalThis.completedBrowserRequests.some((url) => url.includes(value)), path);
    for (const url of [
        `http://127.0.0.1:${annexPort}/usage`,
        `http://localhost:${annexPort}/runs`,
        `http://[::1]:${annexPort}/usage`,
    ]) {
        await openNative(url, page, app);
        await page.waitForTimeout(400);
        if ((await childUrls()).some((candidate) => candidate.includes(new URL(url).host))) throw new Error(`The native Browser loaded an annex alias: ${url}`);
    }
    await openNative(siteUrl, page, app);
    let siteId;
    await until("unrelated loopback site in the Browser", async () => {
        siteId = await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/`))?.webContents.id, site.address().port);
        return siteId !== undefined;
    });
    const nativeText = (expression) => app.evaluate(({ webContents }, args) => webContents.fromId(args.id)?.executeJavaScript(args.expression), { id: siteId, expression });
    await until("website document loaded", async () => await nativeText("document.title") === "Allowed website");
    await nativeText("document.querySelector('#annex-link').click()");
    await until("link request blocked", () => wasBlocked("/usage"));
    if (await wasCompleted("/usage")) throw new Error("A website link completed an annex request.");

    await openNative(siteUrl, page, app);
    await until("website restored for redirect coverage", async () => app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child.webContents?.getURL().includes(`:${port}/`)), site.address().port), 5_000);
    siteId = await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/`))?.webContents.id, site.address().port);
    await nativeText("location.href = '/redirect'");
    await until("redirect request blocked", () => wasBlocked("/usage?from=redirect"));
    if (await wasCompleted("/usage?from=redirect")) throw new Error("A redirected annex request completed.");

    await openNative(siteUrl, page, app);
    await until("website restored for popup coverage", async () => app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child.webContents?.getURL().includes(`:${port}/`)), site.address().port));
    siteId = await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/`))?.webContents.id, site.address().port);
    await nativeText("document.querySelector('#annex-popup').click()");
    await until("popup request blocked", () => wasBlocked("/runs"));
    await until("popup tab reconciled", async () => await pane.locator('[role="tab"][data-container="core.browser"]').count() === 2);
    if (await wasCompleted("/runs")) throw new Error("A popup completed an annex request.");

    await openNative(siteUrl, page, app);
    await until("website restored for embedded coverage", async () => app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child.webContents?.getURL().includes(`:${port}/`)), site.address().port));
    siteId = await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/`))?.webContents.id, site.address().port);
    await app.evaluate(() => { globalThis.blockedAnnexRequests = []; });
    await nativeText("location.href = '/embed'");
    await until("embedded site document", async () => await nativeText("document.querySelector('iframe') !== null").catch(() => false));
    await until("embedded request blocked", () => wasBlocked("/runs"));
    if (await wasCompleted("/runs")) throw new Error("An embedded annex request completed.");
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.browser-history") ?? "[]"));
    if (history.some((entry) => new URL(entry.url).port === String(annexPort))) throw new Error("A blocked annex request entered Browser history.");

    const pagesCommand = await openPalette(page, app, "Vera's Pages");
    await pagesCommand.press("Enter");
    const picker = page.getByRole("dialog", { name: "Vera's Pages" });
    await picker.waitFor();
    const filter = picker.getByRole("textbox", { name: "Vera's Pages" });
    for (const label of ["Usage", "Workflow runs", "Artifacts"]) {
        await filter.fill(label);
        if (await picker.locator(".palette-row", { hasText: label }).count() === 0) throw new Error(`Vera's Pages picker does not include ${label}.`);
    }
    await page.keyboard.press("Escape");
    await press(app, "B", [MODIFIER, "alt"]);
    await until("right pane closes", async () => await page.locator('[data-location="rightPane"]').count() === 0);
    for (const label of ["Usage", "Workflow runs", "Artifacts"]) {
        if (await page.locator(`iframe[title="${label}"]`).count() !== 0) throw new Error(`${label} remained loaded after closing the pane.`);
    }
    console.log("browser e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) {
        console.error("Pane text:", await page.locator('[data-location="rightPane"]').first().innerText().catch(() => "unreadable"));
        console.error("Browser state:", await page.evaluate(() => window.veraDesktop.browser("state")).catch(() => undefined));
        console.error("Address:", await page.getByRole("textbox", { name: "Address" }).inputValue().catch(() => undefined));
    }
    if (app !== undefined) console.error("Views:", await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((child) => ({ url: child.webContents?.getURL(), visible: child.getVisible() }))).catch(() => undefined));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => site.close(resolve))]);
}
process.exit(failed ? 1 : 0);

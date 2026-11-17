import { createServer } from "node:http";
import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const toolResults = [];
const provider = createServer((request, response) => {
    if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Ready." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
            return;
        }
        const results = (body.messages ?? []).filter((message) => message.role === "tool");
        toolResults.push(...results.map((message) => String(message.content)));
        const input = results.length === 0
            ? { action: "open", url: process.env.BROWSER_HISTORY_TOOL_URL }
            : undefined;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (input === undefined) response.write(streamChunk(body.model, { role: "assistant", content: "Browser history check complete." }, "stop"));
        else response.write(streamChunk(body.model, { role: "assistant", tool_calls: [{ index: 0, id: "history-open", type: "function", function: { name: "desktop_browser", arguments: JSON.stringify(input) } }] }, "tool_calls"));
        response.end("data: [DONE]\n\n");
    });
});
const site = createServer((request, response) => {
    const title = request.url?.startsWith("/tool") ? "Tool opened page" : "History journey page";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>${title}</title><h1>${title}</h1><script>document.cookie='history-trial=preserved; max-age=3600';localStorage.setItem('history-trial','preserved')</script>`);
});
const trial = startTrial();
let page;
let failed = false;
try {
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
    const base = `http://127.0.0.1:${site.address().port}`;
    process.env.BROWSER_HISTORY_TOOL_URL = `${base}/tool?from=tool#open`;
    configureFauxHome(trial.home, provider.address().port, "ask");
    let app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();

    await press(app, "K", [MODIFIER]);
    const palette = page.locator('input[aria-label="Command palette"]');
    await palette.fill("Usage");
    await palette.press("Enter");
    const pane = page.locator('[data-location="rightPane"]');
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.waitFor();
    await until("Vera page recent recorded", async () => {
        const recents = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
        return recents.some((item) => item.kind === "annex" && item.target === "/usage");
    });
    const browserTools = pane.getByRole("switch", { name: "Browser tools" });
    await until("browser tools ready", async () => await browserTools.isEnabled());
    if (await browserTools.isChecked()) throw new Error("Browser tools started enabled.");
    await browserTools.click();
    await until("browser tools enabled", async () => await browserTools.isChecked());

    const historySeed = Array.from({ length: 51 }, (_, index) => ({
        url: `${base}/seed/${index}?source=seed#entry`,
        title: `Seed title ${index}`,
        visitedAt: Date.now() - index * 1000,
    }));
    await page.evaluate((entries) => localStorage.setItem("vera.desktop.browser-history", JSON.stringify(entries)), historySeed);
    const recentPage = `${base}/current?keep=yes#section`;
    await address.fill(recentPage);
    await address.press("Enter");
    const view = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(new URL(process.env.BROWSER_HISTORY_TOOL_URL).host))?.webContents.id);
    const readSite = async (expression) => app.evaluate(async ({ webContents }, arg) => webContents.fromId(arg.id)?.executeJavaScript(arg.expression), { id: await view(), expression });
    await until("local page loaded", async () => (await readSite("document.title").catch(() => "")) === "History journey page");
    await until("browser recent exists", async () => {
        const recents = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
        return recents.some((item) => item.kind === "browser" && item.target === recentPage);
    });
    if (!(await readSite("document.cookie")).includes("history-trial=preserved") || (await readSite("localStorage.getItem('history-trial')")) !== "preserved") throw new Error("Local page storage was not initialized.");

    const historyButton = pane.getByRole("button", { name: "History", exact: true });
    await historyButton.click();
    const history = pane.getByRole("region", { name: "History" });
    await history.waitFor();
    const search = history.getByRole("searchbox", { name: "Search history" });
    const entries = history.locator("button.browser-history-entry");
    if (await entries.count() !== 50) throw new Error("History did not show the initial 50 entries.");
    if (await history.getByRole("button", { name: "Show more" }).count() !== 1) throw new Error("Show more was not available.");
    await search.fill("seed/50");
    await until("history URL search result", async () => await entries.count() === 1 && (await entries.first().innerText()).includes("Seed title 50"));
    await search.fill("Seed title 49");
    await until("history title search result", async () => await entries.count() === 1 && (await entries.first().innerText()).includes("Seed title 49"));
    await search.fill("");
    await history.getByRole("button", { name: "Show more" }).click();
    await until("older history shown", async () => await entries.count() === 52);
    await entries.filter({ hasText: recentPage }).click();
    await until("history row navigated current tab", async () => (await readSite("location.href").catch(() => "")) === recentPage);
    await until("history closed after row navigation", async () => await history.count() === 0);

    const composer = page.locator(".composer-input");
    await composer.fill("Open the requested page with the browser tool");
    await composer.press("Enter");
    const approval = page.locator('.request-card[data-kind="approval"]');
    await approval.waitFor({ timeout: 30_000 });
    await approval.locator('[data-choice="allow_similar"]').click();
    await approval.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("Browser history check complete.").waitFor({ timeout: 30_000 });
    await until("tool page opened", async () => (await readSite("location.href").catch(() => "")) === process.env.BROWSER_HISTORY_TOOL_URL);
    if (!toolResults.some((result) => result.includes("Opened"))) throw new Error("The browser tool result did not reach the model.");
    await historyButton.click();
    await history.waitFor();
    await search.fill("from=tool#open");
    await until("tool URL in history", async () => await entries.count() === 1 && (await entries.first().innerText()).includes("Tool opened page"));
    await search.fill("");

    await app.close();
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions]', { timeout: 45_000 });
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Usage");
    await page.locator('input[aria-label="Command palette"]').press("Enter");
    const relaunchedPane = page.locator('[data-location="rightPane"]');
    const relaunchedAddress = relaunchedPane.getByRole("textbox", { name: "Address" });
    await relaunchedAddress.waitFor();
    await relaunchedAddress.fill(recentPage);
    await relaunchedAddress.press("Enter");
    const relaunchedView = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(new URL(process.env.BROWSER_HISTORY_TOOL_URL).host))?.webContents.id);
    const relaunchedRead = async (expression) => app.evaluate(async ({ webContents }, arg) => webContents.fromId(arg.id)?.executeJavaScript(arg.expression), { id: await relaunchedView(), expression });
    await until("same site open after relaunch", async () => (await relaunchedRead("document.title").catch(() => "")) === "History journey page");
    if (!(await relaunchedRead("document.cookie")).includes("history-trial=preserved") || (await relaunchedRead("localStorage.getItem('history-trial')")) !== "preserved") throw new Error("The site data did not survive relaunch.");
    const relaunchedHistoryButton = relaunchedPane.getByRole("button", { name: "History", exact: true });
    await relaunchedHistoryButton.click();
    const relaunchedHistory = relaunchedPane.getByRole("region", { name: "History" });
    await relaunchedHistory.waitFor();
    const relaunchedEntries = relaunchedHistory.locator("button.browser-history-entry");
    const shortcutSearch = relaunchedHistory.getByRole("searchbox", { name: "Search history" });
    await shortcutSearch.fill("Tool opened page");
    await until("tool history survived relaunch", async () => await relaunchedEntries.count() === 1 && (await relaunchedEntries.first().innerText()).includes("Tool opened page"));
    await shortcutSearch.fill("");
    await until("browser and Vera page recents exist before clear", async () => {
        const recents = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
        return recents.some((item) => item.kind === "annex" && item.target === "/usage")
            && recents.some((item) => item.kind === "browser" && item.target === recentPage);
    });
    const clear = relaunchedHistory.getByRole("button", { name: "Clear", exact: true });
    await relaunchedHistoryButton.click();
    await until("history closed before native shortcut", async () => await relaunchedHistory.count() === 0);
    const nativeViewId = await relaunchedView();
    await until("native page visible before shortcut", async () => app.evaluate(({ BrowserWindow }, id) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.id === id);
        if (view === undefined || !view.getVisible()) return false;
        const bounds = view.getBounds();
        return bounds.width > 0 && bounds.height > 0;
    }, nativeViewId));
    await app.evaluate(({ webContents }, args) => {
        const contents = webContents.fromId(args.id);
        if (contents === undefined) throw new Error("The native browser page is unavailable.");
        contents.sendInputEvent({ type: "keyDown", keyCode: "Delete", modifiers: [args.modifier, "shift"] });
        contents.sendInputEvent({ type: "keyUp", keyCode: "Delete", modifiers: [args.modifier, "shift"] });
    }, { id: nativeViewId, modifier: MODIFIER });
    await until("native page shortcut opened History", async () => await relaunchedHistory.count() === 1);
    await until("native page shortcut focused Clear", async () => await clear.evaluate((button) => button === document.activeElement));
    await page.keyboard.press("Enter");
    await until("history removed from storage", async () => await page.evaluate(() => localStorage.getItem("vera.desktop.browser-history") === null));
    await until("browser recent removed and annex recent retained", async () => {
        const recents = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
        return recents.some((item) => item.kind === "annex") && recents.every((item) => item.kind !== "browser");
    });
    await until("cleared history shown", async () => await relaunchedHistory.locator("button.browser-history-entry").count() === 0
        && await relaunchedHistory.getByText("No history found.").count() === 1);
    const persistedViewId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(new URL(process.env.BROWSER_HISTORY_TOOL_URL).host))?.webContents.id);
    if (persistedViewId === undefined) throw new Error("Clearing history closed the browser tab.");
    const persistedSite = await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript("document.cookie + '|' + localStorage.getItem('history-trial')"), persistedViewId);
    if (persistedSite !== "history-trial=preserved|preserved") throw new Error("Clearing history removed the site's cookie or local storage.");
    console.log("browser history e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Tool results:", toolResults);
    if (page !== undefined) console.error(await page.locator(".app").innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    for (const server of [provider, site]) server.closeAllConnections();
    await Promise.all([provider, site].map((server) => new Promise((resolve) => server.close(resolve))));
}
process.exit(failed ? 1 : 0);

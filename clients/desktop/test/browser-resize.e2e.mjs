import { createServer } from "node:http";

import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Crow page</title><p>crow</p>");
});
const trial = startTrial();
let app;
let page;
let host;

async function sample(label) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    let dom;
    let native;
    try {
        await until(label, async () => {
            dom = await page.locator('[data-location="rightPane"] div.browser-frame').boundingBox();
            native = await app.evaluate(({ BrowserWindow }, port) => {
                const window = BrowserWindow.getAllWindows()[0];
                const view = window.contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/site`));
                return view === undefined ? null : { bounds: view.getBounds(), visible: view.getVisible(), zoom: window.webContents.getZoomFactor() };
            }, server.address().port);
            return dom !== null && native !== null && native.visible && Object.keys(native.bounds).every((key) => Math.abs(native.bounds[key] - dom[key] * native.zoom) <= 1);
        }, 5000);
    } catch {
        throw new Error(`${label}: DOM ${JSON.stringify(dom)}, native ${JSON.stringify(native)}`);
    }
    console.log(`${label}: DOM ${JSON.stringify(dom)}, native ${JSON.stringify(native)}`);
}

try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, server.address().port);
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions]', { timeout: 45_000 });
    host = await trial.waitForHost();
    await waitForAnnexPages(page, app);
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator('[data-pane-tile="core.browser"]').click();
    const address = page.getByRole("textbox", { name: "Address" });
    await address.fill(`http://127.0.0.1:${server.address().port}/site`);
    await address.press("Enter");
    await until("native page", async () => await app.evaluate(({ BrowserWindow }, port) => BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child.webContents?.getURL().includes(`:${port}/site`)), server.address().port));
    await sample("initial");
    for (const [width, height] of [[1000, 700], [720, 600], [1400, 900], [1100, 750]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
        await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [width, height]);
        await sample(`${width}x${height}`);
    }
    await press(app, "B", [MODIFIER]);
    await page.locator('[data-location="sidebar"]').waitFor({ state: "detached" });
    await sample("sidebar closed");
    await press(app, "B", [MODIFIER]);
    await page.locator('[data-location="sidebar"]').waitFor();
    await sample("sidebar reopened");
    await page.getByRole("separator", { name: "Resize sidebar" }).press("ArrowRight");
    await sample("sidebar widened");
    await page.getByRole("separator", { name: "Resize sidebar" }).press("ArrowLeft");
    await sample("sidebar narrowed");
    await page.getByRole("separator", { name: "Resize rightPane" }).press("ArrowLeft");
    await sample("pane widened");
    await page.getByRole("separator", { name: "Resize rightPane" }).press("ArrowRight");
    await sample("pane narrowed");
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator('[data-location="rightPane"]').waitFor({ state: "detached" });
    await until("page hidden with pane", async () => await app.evaluate(({ BrowserWindow }, port) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/site`));
        return view === undefined || !view.getVisible();
    }, server.address().port));
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator('[data-location="rightPane"] div.browser-frame').waitFor();
    await sample("pane reopened");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await until("maximized", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()));
    await sample("maximized");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await until("restored", async () => !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())));
    await sample("restored");
    for (const bounds of [{ x: 40, y: 80, width: 1000, height: 700 }, { x: 300, y: 180, width: 1100, height: 750 }]) {
        await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].setBounds(next), bounds);
        await page.waitForFunction(({ width, height }) => window.innerWidth === width && window.innerHeight === height, bounds);
        await sample(`moved and resized to ${bounds.width}x${bounds.height}`);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.2));
    await until("zoomed", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() === 1.2));
    await sample("zoomed");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await sample("zoomed and resized");
    await press(app, "B", [MODIFIER]);
    await page.locator('[data-location="sidebar"]').waitFor({ state: "detached" });
    await sample("sidebar closed at 120% zoom");
    await press(app, "B", [MODIFIER]);
    await page.locator('[data-location="sidebar"]').waitFor();
    await page.getByRole("separator", { name: "Resize rightPane" }).press("ArrowLeft");
    await sample("pane widened at 120% zoom");
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator('[data-location="rightPane"]').waitFor({ state: "detached" });
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator('[data-location="rightPane"] div.browser-frame').waitFor();
    await sample("pane reopened at 120% zoom");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await until("maximized at 120% zoom", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()));
    await sample("maximized at 120% zoom");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await until("restored at 120% zoom", async () => !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())));
    await sample("restored at 120% zoom");
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').waitFor();
    await until("page hidden under palette", async () => await app.evaluate(({ BrowserWindow }, port) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/site`));
        return view !== undefined && !view.getVisible();
    }, server.address().port));
    await page.keyboard.press("Escape");
    await sample("palette closed at 120% zoom");
    await page.locator('[data-pane-launcher]').click();
    await page.locator('[data-pane-option="core.browser"]').click();
    const browserTabs = page.locator('[data-switcher="rightPane"] [data-tab][data-container="core.browser"]');
    await until("second browser tab", async () => await browserTabs.count() === 2);
    await until("page hidden on another tab", async () => await app.evaluate(({ BrowserWindow }, port) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().includes(`:${port}/site`));
        return view === undefined || !view.getVisible();
    }, server.address().port));
    await browserTabs.first().click();
    await sample("page tab reopened at 120% zoom");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(0.8));
    await sample("80% zoom");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await sample("zoom reset");
    await page.locator('[data-location="rightPane"] div.browser-frame').evaluate((element) => {
        element.style.cssText = "position: fixed; left: 500px; top: 150px; width: 200px; height: 200px";
    });
    await sample("fixed CSS rectangle");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.2));
    await sample("fixed CSS rectangle after zoom");
    console.log("browser resize e2e passed");
} finally {
    const pid = app?.process().pid;
    await trial.cleanup();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const value of [pid, host]) {
        if (value === undefined) continue;
        try { process.kill(value, 0); throw new Error(`Trial process ${value} is still running`); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
}

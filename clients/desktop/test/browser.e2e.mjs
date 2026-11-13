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

const trial = startTrial();
let failed = false;
let page;

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
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

    const pane = page.locator("[data-location=\"rightPane\"]");
    const frame = pane.locator("iframe.browser-frame");
    const address = pane.getByRole("textbox", { name: "Address" });
    const back = pane.getByRole("button", { name: "Back" });
    const forward = pane.getByRole("button", { name: "Forward" });
    const inFrame = page.frameLocator("[data-location=\"rightPane\"] iframe.browser-frame");
    const showing = async (label) => {
        await until(`the ${label} page in the browser`, async () => (await frame.count()) === 1 && (await frame.getAttribute("title")) === label);
    };

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

    // The annex page renders inside the frame without its own menu.
    await inFrame.locator(".page .toolbar .seg").first().waitFor({ timeout: 30_000 });
    if (await inFrame.locator(".nav-toggle").count() !== 0) throw new Error("The framed annex page still shows its menu.");
    const tabs = await pane.locator(".browser-tabs .browser-tab").allInnerTexts();
    // The included artifacts extension adds a page after the built-in ones.
    if (tabs.slice(1).join() !== "Usage,Runs,Artifacts") throw new Error(`The tab row shows ${tabs.join(", ")}.`);
    if ((await pane.locator(".browser-tab[aria-current=\"page\"]").innerText()) !== "Usage") throw new Error("The Usage tab is not marked current.");

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

    // The address bar takes a page's name, and anything off the annex opens nothing.
    await address.fill("usage");
    await address.press("Enter");
    await showing("Usage");
    await address.fill("example.com");
    await address.press("Enter");
    await pane.getByText("Only the pages Vera serves on this machine open here").waitFor();
    if (await frame.count() !== 0) throw new Error("An address off the annex loaded a frame.");
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

    console.log("browser e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Pane text:", await page.locator("[data-location=\"rightPane\"]").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);

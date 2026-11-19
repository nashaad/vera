import { createServer } from "node:http";
import { configureFauxHome, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
});
const site = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>${request.url === "/first" ? "First crow" : "Second crow"}</title>`);
});
const trial = startTrial();
trial.writeFlags({ plan: "on" });
let failed = false;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    let app = await trial.launch();
    let page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
    await waitForAnnexPages(page, app);
    const base = `http://127.0.0.1:${site.address().port}`;
    await page.evaluate((baseUrl) => localStorage.setItem("vera.desktop.pane-recents", JSON.stringify([
        { kind: "annex", target: "/x/vera.artifacts/artifacts", title: "Artifacts" },
        { kind: "annex", target: "/x/missing/page", title: "Missing page" },
        { kind: "browser", target: `${baseUrl}/first`, title: "First crow" },
        { kind: "browser", target: `${baseUrl}/second`, title: "Second crow" },
    ])), base);
    await press(app, "B", [MODIFIER, "alt"]);
    const input = page.locator('[data-pane-tiles] input');
    await input.waitFor({ timeout: 10_000 });
    await input.click();
    await input.fill("Missing page");
    if (await page.locator('.pane-new-results [role="option"]').count() !== 0) throw new Error("Unavailable extension page was offered.");
    await input.fill("Plan");
    if (await page.locator('[data-pane-tile="core.plan"]').count() !== 1 || await page.locator('[data-pane-tile="core.browser"]').count() !== 0) throw new Error("Pane tiles did not filter.");
    await input.fill("not a url");
    await input.press("Enter");
    if (await page.locator('[data-switcher="rightPane"] [data-tab]').count() !== 0) throw new Error("Filter text opened a tab.");
    await input.fill("");
    await input.press("ArrowUp");
    await until("last recent selected", async () => (await page.locator('.pane-new-results [aria-selected="true"]').innerText()) === "Second crow");
    await input.fill("First");
    if (await page.locator('.pane-new-results [aria-selected="true"]').count() !== 0) throw new Error("Query retained a selection.");
    await input.press("Escape");
    if (await page.locator('.pane-new-results').count() !== 0) throw new Error("Escape did not close recent results.");
    await input.click();
    if (await page.locator('.pane-new-results [role="option"]').count() !== 1) throw new Error("Click did not reopen recent results.");
    await input.press("ArrowDown");
    await input.press("Enter");
    await until("selected page opened", async () => (await page.locator('[data-switcher="rightPane"] [data-container="core.browser"]').innerText()).includes("First crow"));
    await until("successful navigation recorded", async () => {
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
        return saved[0]?.target === `${base}/first` && saved[0]?.title === "First crow";
    });
    await page.locator('[data-switcher="rightPane"] .switcher-pill:has([data-container="core.browser"]) .switcher-close').click();
    const search = page.locator('[data-pane-tiles] input');
    await search.fill("Artifacts");
    await until("available extension recent", async () => (await page.locator('.pane-new-results [role="option"]').count()) === 1);
    await search.press("ArrowDown");
    await search.press("Enter");
    await until("extension page reopened", async () => await page.locator('[data-switcher="rightPane"] [data-container="page:/x/vera.artifacts/artifacts"]').count() === 1);
    await until("extension page recorded", async () => {
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
        return saved[0]?.kind === "annex" && saved[0]?.target === "/x/vera.artifacts/artifacts";
    });
    await page.locator('[data-switcher="rightPane"] .switcher-pill:has([data-container="page:/x/vera.artifacts/artifacts"]) .switcher-close').click();
    const address = page.locator('[data-pane-tiles] input');
    await address.fill(`${base}/second`);
    await address.press("Enter");
    await until("typed address opened", async () => (await page.locator('[data-switcher="rightPane"] [data-container="core.browser"]').innerText()).includes("Second crow"));
    await app.close();
    app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("vera.desktop.pane-recents") ?? "[]"));
    if (!persisted.some((item) => item.target === `${base}/first`) || !persisted.some((item) => item.target === "/x/vera.artifacts/artifacts")) throw new Error("Recent pages did not survive restart.");
    console.log("new-tab e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    site.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await new Promise((resolve) => site.close(resolve));
}
process.exit(failed ? 1 : 0);

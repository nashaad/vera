import { createServer } from "node:http";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial, waitForAnnexPages } from "./trial.mjs";

const results = [];
let call = 0;
const server = createServer((request, response) => {
    if (request.url === "/site") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<title>Crow page</title><h1>Complete the crow check</h1>");
        return;
    }
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
        const messages = body.messages ?? [];
        const user = messages.findLastIndex((message) => message.role === "user" && JSON.stringify(message.content).includes("Crow handoff"));
        const toolResults = messages.slice(user + 1).filter((message) => message.role === "tool");
        results.push(...toolResults.map((message) => String(message.content)));
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (user < 0 || toolResults.length > 0) {
            response.write(streamChunk(body.model, { role: "assistant", content: "Crow turn complete." }, "stop"));
        } else {
            const tool = { index: 0, id: `handoff-${++call}`, type: "function", function: { name: "builtin_browser", arguments: JSON.stringify({ action: "handoff", reason: "Complete the crow check" }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [tool] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, server.address().port, "ask");
    const app = await trial.launch();
    const page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    await trial.waitForHost();
    await until("annex page list", async () => (await page.evaluate(() => window.veraDesktop.readAnnexPages())).ok);
    await waitForAnnexPages(page, app);
    await press(app, "K", [MODIFIER]);
    await page.locator('input[aria-label="Command palette"]').fill("Open a web page");
    await page.locator('[data-command="page.openBrowser"]').click();
    const pane = page.locator('[data-location="rightPane"]');
    const tools = pane.getByRole("switch", { name: "Browser tools" });
    await until("Browser tools available", () => tools.isEnabled());
    await tools.click();
    await until("Browser tools on", () => tools.isChecked());
    const address = pane.getByRole("textbox", { name: "Address" });
    await address.fill(`http://127.0.0.1:${server.address().port}/site`);
    await address.press("Enter");
    try {
        await until("page opened", async () => await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some((child) => child.webContents?.getURL().endsWith("/site"))), 10_000);
    } catch (error) {
        const state = await page.evaluate(() => window.veraDesktop.browser("state"));
        throw new Error(`Browser page did not open: ${JSON.stringify(state)}`, { cause: error });
    }

    const composer = page.locator(".composer-input");
    const banner = pane.locator(".browser-handoff");
    const send = async (text) => {
        await composer.fill(text);
        await composer.press("Enter");
        const approval = page.locator('.request-card[data-kind="approval"]');
        await until("handoff or approval", async () => await banner.isVisible() || await approval.isVisible());
        if (await approval.isVisible()) await approval.locator('[data-choice="allow_similar"]').click();
        await banner.waitFor({ timeout: 45_000 });
        if (!await banner.getByText("Vera needs you: Complete the crow check", { exact: true }).isVisible()) throw new Error("Handoff reason missing");
        if (await page.evaluate(() => Boolean(document.activeElement?.closest(".browser-handoff")))) throw new Error("Handoff took focus");
    };
    await send("Crow handoff one");
    await until("page below banner", async () => {
        const bottom = await banner.evaluate((element) => element.getBoundingClientRect().bottom);
        const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().endsWith("/site"))?.getBounds());
        return bounds && bounds.y >= bottom - 1 && bounds.height > 0;
    });
    await banner.getByRole("button", { name: "Done", exact: true }).click();
    await banner.waitFor({ state: "hidden" });
    await until("done result", () => results.some((result) => result.includes("The user finished. Read the page again.")));
    await page.getByText("Crow turn complete.").last().waitFor({ timeout: 45_000 });

    await send("Crow handoff two");
    await banner.getByRole("button", { name: "Skip", exact: true }).click();
    await banner.waitFor({ state: "hidden" });
    await until("skip result", () => results.some((result) => result.includes("The user skipped it.")));
    await until("second turn complete", async () => await page.getByText("Crow turn complete.").count() >= 2);

    await send("Crow handoff three");
    await tools.click();
    await banner.waitFor({ state: "hidden" });
    await until("cancelled result", () => results.some((result) => result.includes("Handoff cancelled.")));
    await until("third turn complete", async () => await page.getByText("Crow turn complete.").count() >= 3);

    await tools.click();
    await until("Browser tools back on", () => tools.isChecked());
    await send("Crow handoff four");
    await composer.press("Escape");
    await banner.waitFor({ state: "hidden", timeout: 30_000 });
    console.log("Browser handoff banner, layout, Done, Skip, switch-off and stop passed");
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    try { await trial.cleanup(); } catch (error) { failed = true; console.error(`Trial retained at ${trial.trialRoot}:`, error); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}
process.exit(failed ? 1 : 0);

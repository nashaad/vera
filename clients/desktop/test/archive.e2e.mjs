import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const REPLY = "The crow has counted the doubloons.";
const FINISHED = "The crow sailed safely into port.";
let turns = 0;
let finishTurn;
const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply", model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }], usage,
            }));
            return;
        }
        turns += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { content: turns === 1 ? REPLY : "The crow " }));
        const finish = () => {
            if (turns > 1) response.write(streamChunk(body.model, { content: "sailed safely into port." }));
            response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
            response.end("data: [DONE]\n\n");
        };
        if (turns === 1) finish();
        else finishTurn = finish;
    });
});

const trial = startTrial();
let failed = false;
let page;
let hostPid;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    const app = await trial.launch();
    page = await app.firstWindow();
    await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
    hostPid = await trial.waitForHost();
    const input = page.locator(".composer-input");
    await input.fill("Count the doubloons");
    await input.press("Enter");
    await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 30_000 });
    const id = await page.locator(".transcript-scroll").getAttribute("data-session");
    const row = page.locator(`.session-row[data-session="${id}"]`);
    const group = (key) => page.locator(`.session-group[data-group="${key}"]`);
    const menu = async (label) => {
        const item = page.locator(`.session-item:has(.session-row[data-session="${id}"])`);
        await item.hover();
        await item.locator(".session-more").click();
        await page.getByRole("menuitem", { name: label, exact: true }).click();
    };
    const inGroup = async (key) => (await group(key).locator(`[data-session="${id}"]`).count()) === 1;
    const checkFirstHeader = async (key) => {
        for (const width of [1200, 800]) {
            await page.setViewportSize({ width, height: 800 });
            const geometry = await page.evaluate(() => {
                const head = document.querySelector('.sessions-view > .session-group:first-child .group-head')?.getBoundingClientRect();
                const action = document.querySelector('[data-view="core.sessions"] > .view-header .view-actions')?.getBoundingClientRect();
                return head && action ? { offset: Math.abs((head.top + head.bottom - action.top - action.bottom) / 2) } : undefined;
            });
            if (!geometry || geometry.offset > 2) throw new Error(`${key} header is misaligned at ${width}: ${JSON.stringify(geometry)}`);
        }
        await page.setViewportSize({ width: 1200, height: 800 });
    };
    await until("the chat row", () => inGroup("chats"), 10_000);
    await checkFirstHeader('Chats');
    if (process.env.ARCHIVE_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.ARCHIVE_EVIDENCE_DIR, "archive-before.png"), fullPage: true });
    const secondApp = await trial.launch();
    const second = await secondApp.firstWindow();
    await second.locator(`.session-row[data-session="${id}"]`).waitFor({ timeout: 15_000 });
    const metadata = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                const found = metadata(path);
                if (found !== undefined) return found;
            } else if (entry.name === `${id}.jsonl.metadata.json`) return path;
        }
    };
    await menu("Archive Session");
    await until("durable archive metadata", () => {
        const path = metadata(trial.home);
        return path !== undefined && JSON.parse(readFileSync(path, "utf8")).archived === true;
    }, 10_000);
    const savedAt = Date.now();
    await Promise.all([page, second].map((window) => window.locator('.session-group[data-group="archived"]').waitFor({ timeout: 5_000 })));
    console.log(`archive e2e: both windows observed durable archive in ${Date.now() - savedAt} ms`);
    await group("archived").waitFor({ timeout: 10_000 });
    await checkFirstHeader('Archived');
    if ((await group("archived").getAttribute("data-open")) !== "false") throw new Error("Archived did not start collapsed");
    if (await group("chats").count()) throw new Error("The archived chat remained in Chats");
    if ((await page.locator(".transcript-scroll").getAttribute("data-session")) !== id) throw new Error("Archive closed the conversation");
    await page.getByRole("button", { name: "Expand Archived", exact: true }).click();
    await until("the archived row", () => inGroup("archived"), 10_000);
    if (process.env.ARCHIVE_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.ARCHIVE_EVIDENCE_DIR, "archive-after.png"), fullPage: true });
    await menu("Unarchive Session");
    await until("durable unarchive metadata", () => JSON.parse(readFileSync(metadata(trial.home), "utf8")).archived === false, 10_000);
    const unarchivedAt = Date.now();
    await Promise.all([page, second].map((window) => window.locator(`.session-group[data-group="chats"] [data-session="${id}"]`).waitFor({ timeout: 5_000 })));
    console.log(`archive e2e: both windows observed durable unarchive in ${Date.now() - unarchivedAt} ms`);
    await until("the row restored to Chats", () => inGroup("chats"), 10_000);
    console.log("archive e2e: row menu round trip passed");

    await menu("Pin Session");
    await until("the pinned row", () => inGroup("pinned"), 10_000);
    await checkFirstHeader('Pinned');
    await menu("Archive Session");
    await group("archived").waitFor();
    await page.getByRole("button", { name: "Expand Archived", exact: true }).click();
    await menu("Unarchive Session");
    await until("the restored pin", () => inGroup("pinned"), 10_000);
    await menu("Unpin Session");
    await until("the unpinned chat", () => inGroup("chats"), 10_000);
    console.log("archive e2e: pin restored passed");

    await input.fill("Sail to port slowly");
    await input.press("Enter");
    await until("the held streamed turn", () => finishTurn !== undefined, 10_000);
    await until("the working row", async () => (await row.getAttribute("data-status")) === "working", 10_000);
    await menu("Archive Session");
    await group("archived").waitFor();
    if ((await page.locator(".transcript-scroll").getAttribute("data-session")) !== id) throw new Error("Archiving a running session closed its page");
    finishTurn();
    await page.getByText(FINISHED, { exact: true }).waitFor({ timeout: 30_000 });
    await until("the turn to finish", async () => (await input.getAttribute("placeholder")) === "Reply to Vera", 10_000);
    console.log("archive e2e: running turn finished passed");

    await press(app, "N", [MODIFIER]);
    await page.waitForSelector('main[data-page="home"]', { timeout: 10_000 });
    await press(app, "P", [MODIFIER]);
    await page.locator('input[aria-label="Go to session"]').waitFor({ timeout: 10_000 });
    await page.locator(".palette-row[data-session]").first().click();
    await page.waitForSelector(`.transcript-scroll[data-session="${id}"]`, { timeout: 15_000 });
    if ((await group("archived").getAttribute("data-open")) !== "false") throw new Error("Opening through the palette expanded Archived");
    await page.getByRole("button", { name: "Expand Archived", exact: true }).click();
    await until("the palette-opened session to stay archived", () => inGroup("archived"), 10_000);
    await row.click();
    await menu("Unarchive Session");
    await until("the final unarchive", () => inGroup("chats"), 10_000);
    console.log("archive e2e: opening stays archived passed");
    console.log("archive e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    if (hostPid !== undefined) {
        try {
            process.kill(hostPid, 0);
            console.error(`Trial host ${hostPid} is still running`);
            failed = true;
        } catch (error) {
            if (error.code !== "ESRCH") throw error;
            console.log(`archive e2e: trial host ${hostPid} exited`);
        }
    }
}
process.exit(failed ? 1 : 0);

// Artifact pane test for the desktop shell. Run with: node clients/desktop/test/artifact-pane.e2e.mjs
// Needs the built annex page: bun run pack:web.
// The Artifacts page has a sidebar entry that opens it in the main area. An artifact written in the shown
// session adds the page's tab to the right pane without switching tabs or opening a hidden pane, marks the
// tab (and the pane's toggle while the pane is hidden) until it is viewed, and draws a card under the tool run
// that opens the artifact in that tab.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { MODIFIER, press, startTrial } from "./trial.mjs";

const PATH = "/x/vera.artifacts/artifacts";
const KIND = `page:${PATH}`;
const ARTIFACT_URL = /Artifact page: (http:\/\/127\.0\.0\.1:\d+\/x\/vera\.artifacts\/artifacts\?[^\s"\\]+)/;
const requests = [];

function lastUser(messages) {
    const index = messages.findLastIndex((message) => message.role === "user");
    return { index, text: JSON.stringify(messages[index]?.content ?? "") };
}

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
        const messages = body.messages ?? [];
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Artifact notes" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const { index, text } = lastUser(messages);
        const name = /WRITE (\w+)/.exec(text)?.[1];
        const results = messages.slice(index + 1).filter((message) => message.role === "tool");
        if (name !== undefined && results.length === 0) {
            requests.push(name);
            const input = { name, markdown: `# ${name}\n\n- Find the ${name} map\n` };
            const call = { index: 0, id: `call-${requests.length}`, type: "function", function: { name: "artifact_write", arguments: JSON.stringify(input) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            const url = ARTIFACT_URL.exec(JSON.stringify(results.at(-1)?.content ?? ""))?.[1];
            const reply = url === undefined ? "Nothing written." : `Written, see [the ${name} page](${url}).`;
            response.write(streamChunk(body.model, { role: "assistant", content: reply }, "stop"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

const strip = '[data-switcher="rightPane"]';
const tabs = () => page.locator(`${strip} [data-tab][data-container="${KIND}"]`);
const pill = () => page.locator(`${strip} .switcher-pill:has([data-tab][data-container="${KIND}"])`).first();
// A tab that is not shown keeps its frame hidden, so only the shown tab's frame counts.
const FRAME = '[data-location="rightPane"] iframe.browser-frame:visible';
const frame = () => page.locator(FRAME);
const inFrame = () => page.frameLocator(FRAME);
// The pane's own header has a second toggle while the pane is open; the title bar's is the one that stays.
const toggle = () => page.getByRole("banner").locator('[data-header-toggle="rightPane"]');
const entry = () => page.locator(`[data-extension-page="${PATH}"]`);

function check(condition, message) {
    if (!condition) throw new Error(message);
}

async function say(input, send, text, reply) {
    await input.fill(text);
    await input.press("Enter");
    await page.locator(".assistant-text", { hasText: reply }).last().waitFor({ timeout: 45_000 });
    await until("the turn to end", async () => (await send.getAttribute("data-mode")) === "send");
}

async function activeContainer() {
    return await page.locator(`${strip} .switcher-pill[data-active="true"] [data-tab]`).first().getAttribute("data-container");
}

async function expectFrameOn(artifact) {
    await frame().first().waitFor({ timeout: 15_000 });
    await until(`the frame to show ${artifact}`, async () => (await frame().first().getAttribute("src") ?? "").includes(`artifact=${artifact}`));
    check(await frame().first().getAttribute("title") === "Artifacts", "The pane's frame is not titled Artifacts.");
    await inFrame().getByText(`Find the ${artifact} map`).first().waitFor({ timeout: 30_000 });
}

async function expectMarked(marked, what) {
    await until(`${what} to be ${marked ? "marked" : "unmarked"}`, async () => (await pill().getAttribute("data-changed")) === String(marked));
    check(await pill().locator(".change-dot").count() === (marked ? 1 : 0), `The tab's dot is ${marked ? "missing" : "still there"}.`);
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "nest");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    // The page has its own entry in the sidebar, which opens it full size without a query.
    await entry().waitFor({ timeout: 30_000 });
    check((await entry().innerText()).trim() === "Artifacts", "The sidebar entry is not labelled Artifacts.");
    await entry().click();
    await page.locator('main[data-page="extension"] iframe.browser-frame').waitFor({ timeout: 15_000 });
    const mainSrc = await page.locator('main[data-page="extension"] iframe.browser-frame').getAttribute("src");
    check(mainSrc !== null && mainSrc.endsWith(PATH) && !mainSrc.includes("?"), `The main area frame loads ${mainSrc}.`);
    check(await entry().getAttribute("data-active") === "true", "The entry is not marked as the page shown.");
    await page.frameLocator('main[data-page="extension"] iframe.browser-frame').getByText("No artifacts yet").waitFor({ timeout: 30_000 });
    const mainFrame = page.locator('main[data-page="extension"] iframe.browser-frame');
    await mainFrame.evaluate((element) => { element.dataset.reloadProof = "before"; });
    await page.locator('main[data-page="extension"] button[data-page-reload]').focus();
    await press(app, "R", [MODIFIER]);
    await until("main page shortcut reload", async () => await mainFrame.getAttribute("data-reload-proof") === null);
    check(await page.locator('[data-switcher="rightPane"] [data-tab]').count() === 0, "Opening the page from the sidebar opened a pane tab.");
    await page.locator('[data-page="home"]').click();

    // The page has its own entry in the pane's launcher and its own tile, before any artifact exists.
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator(`[data-pane-tile="${KIND}"]`).waitFor({ timeout: 30_000 });
    check((await page.locator(`[data-pane-tile="${KIND}"]`).innerText()).trim().includes("Artifacts"), "The Artifacts tile is not labelled Artifacts.");
    await page.locator("[data-pane-launcher]").click();
    const option = page.locator(`[data-pane-option="${KIND}"] .pane-launcher-title`);
    await option.waitFor({ timeout: 5_000 });
    check((await option.innerText()).trim() === "Artifacts", "The launcher entry is not labelled Artifacts.");
    // Another tab is open and shown when the first artifact arrives.
    await page.locator('[data-pane-option="core.browser"]').click();
    await page.locator(`${strip} [data-tab][data-container="core.browser"]`).waitFor({ timeout: 10_000 });

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"nest\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");

    // The first artifact adds the tab behind the shown one, marks it, and leaves the keyboard where it was.
    await say(input, send, "Please WRITE raid", "the raid page");
    await tabs().first().waitFor({ timeout: 30_000 });
    check(await activeContainer() === "core.browser", `The shown tab is ${await activeContainer()}, not the Browser.`);
    await expectMarked(true, "the Artifacts tab");
    check(!(await page.evaluate(() => document.querySelector('[data-location="rightPane"]')?.contains(document.activeElement) === true)), "The pane took the keyboard focus.");
    check(await page.locator(".run-head[aria-expanded=\"false\"]").count() >= 1, "The tool run is not collapsed.");
    const card = page.locator(".page-card").first();
    check((await card.innerText()).trim() === "raid", `The card reads ${await card.innerText()}.`);
    check(await page.locator(".run-notice").count() === 0, "The notice's text shows beside its card.");
    check(await page.locator(`${strip} [data-tab][data-container="core.browser"]`).count() === 1, "The artifact opened in a Browser tab.");

    // Viewing the tab clears the mark, and the tab opened on the artifact the notice named.
    await tabs().first().click();
    await expectMarked(false, "the Artifacts tab");
    await expectFrameOn("raid");

    // A second artifact marks the tab again while another is shown, and does not move the tab off the first.
    await page.locator(`${strip} [data-tab][data-container="core.browser"]`).click();
    await say(input, send, "Now WRITE loot", "the loot page");
    await expectMarked(true, "the Artifacts tab");
    check(await tabs().count() === 1, "A second artifact added a second tab.");
    check(await activeContainer() === "core.browser", "A second artifact switched tabs.");
    // A request that is not a turn, such as a title, can repeat a prompt; only the names asked for matter.
    check([...new Set(requests)].join() === "raid,loot", `The provider wrote ${requests.join()}.`);

    // The card opens its artifact in a tab of the Artifacts pane, which shows that tab and clears the mark.
    await page.locator('.page-card[data-page-card*="artifact=loot"]').first().click();
    await expectFrameOn("loot");
    check(await activeContainer() === KIND, "The card did not show the Artifacts tab.");
    check(await tabs().count() === 2, `The card left ${await tabs().count()} Artifacts tabs, not 2.`);
    await expectMarked(false, "the Artifacts tab");

    // With the pane hidden, a new artifact marks the pane's button and opens nothing.
    check(await toggle().getAttribute("data-changed") === "false", "The toggle is marked before anything changed.");
    await press(app, "B", [MODIFIER, "alt"]);
    await page.locator(strip).waitFor({ state: "detached", timeout: 10_000 });
    await say(input, send, "Then WRITE moat", "the moat page");
    await until("the toggle to be marked", async () => (await toggle().getAttribute("data-changed")) === "true");
    check(await toggle().locator(".change-dot").count() === 1, "The toggle has no dot.");
    check(await page.locator(strip).count() === 0, "A new artifact opened the hidden pane.");

    // Opening the pane shows the Artifacts tab, which is viewing it.
    await toggle().click();
    await tabs().first().waitFor({ timeout: 10_000 });
    await until("the toggle's mark to clear", async () => (await toggle().getAttribute("data-changed")) === "false");
    await expectMarked(false, "the Artifacts tab");

    // A link in the reply shows the tab already on that artifact, not a new tab and not a Browser tab.
    await page.locator('.assistant-text a[data-page-link][href*="artifact=raid"]').first().click();
    await expectFrameOn("raid");
    check(await tabs().count() === 2, "A link added another Artifacts tab.");
    check(await page.locator(`${strip} [data-tab][data-container="core.browser"]`).count() === 1, "A link opened a second Browser tab.");

    // The sidebar entry now lists what was written, grouped under the session.
    await entry().click();
    const listing = page.frameLocator('main[data-page="extension"] iframe.browser-frame');
    await listing.getByText("moat").first().waitFor({ timeout: 30_000 });
    check(await listing.locator(".artifacts-group").count() === 1, "The listing is not one group for the one session.");
    check(await listing.locator(".artifacts-row").count() === 3, "The listing does not hold the three artifacts.");
    console.log("artifact pane e2e passed");
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

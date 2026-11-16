// Subagents test for the desktop window. Run with: node clients/desktop/test/subagents.e2e.mjs
// The provider's first reply to the main session starts an async subagent; the child and the follow-ups answer in text.
// The call shows as a card, the card and the Session menu open the Subagents tab, and the tab lists the child under Done.
// A message typed in the child's detail reaches the child, and its answer shows there without reaching the main session.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const DESCRIPTION = "Count the doubloons in the hold";
const CHILD_REPLY = "Forty doubloons lie in the hold.";
const MAIN_REPLY = "The crow is waiting on the count.";
const MESSAGE = "Recount the starboard chest";
const MESSAGE_REPLY = "Twelve more doubloons sit in the starboard chest.";

const requests = [];
let spawned = 0;

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
        const text = JSON.stringify(messages);
        const child = !text.includes("Hello crow");
        const last = messages.at(-1);
        requests.push({ child, text });
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: "reply", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }], usage }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (!child && last?.role === "user" && spawned === 0) {
            spawned += 1;
            const call = { index: 0, id: "call-1", type: "function", function: { name: "async_subagent", arguments: JSON.stringify({ description: DESCRIPTION }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            const asked = child && JSON.stringify(last ?? {}).includes(MESSAGE);
            response.write(streamChunk(body.model, { role: "assistant", content: asked ? MESSAGE_REPLY : child ? CHILD_REPLY : MAIN_REPLY }, "stop"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

const pane = '[data-location="rightPane"]';
const tabs = () => page.locator(`${pane} [data-switcher="rightPane"] [data-tab][data-container="core.subagents"]`);
const card = () => page.locator(".subagent-card");

async function sessionMenu(label) {
    await page.locator("[data-session-menu]").click();
    await page.locator(".menu-item", { hasText: label }).first().click();
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    // Without a subagent model the launch waits for setup. The child runs on the home's own model.
    const configPath = join(trial.home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.model_assignments.subagents = { ...config.model_assignments.snappy, allow_self: true };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);
    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();

    const input = page.locator(".home-composer .composer-input");
    await input.fill("Hello crow");
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(`.context-chips .chip-label:text-is("${folder.split("/").pop()}")`);
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });

    // The call is a card of its own, titled by its description, and the run line does not carry it.
    await card().waitFor({ timeout: 45_000 });
    if ((await card().count()) !== 1) throw new Error(`The transcript shows ${await card().count()} subagent cards.`);
    if (!(await card().innerText()).includes(DESCRIPTION)) throw new Error(`The card reads "${await card().innerText()}".`);
    await page.waitForSelector(`text=${MAIN_REPLY}`, { timeout: 45_000 }).catch(() => undefined);
    if ((await page.locator(".run-head").filter({ hasText: /subagent/i }).count()) !== 0) throw new Error("A run line still names the subagent call.");
    if ((await tabs().count()) !== 0) throw new Error("The Subagents tab was open before anything asked for it.");

    // The card opens the Subagents tab on the child, with its reply and a box to message it.
    await card().click();
    await tabs().first().waitFor({ timeout: 15_000 });
    const detail = page.locator(`${pane} .subagent-detail`);
    await detail.waitFor({ timeout: 15_000 });
    await detail.getByText(CHILD_REPLY).waitFor({ timeout: 45_000 });
    await until("the detail titled by the child", async () => (await detail.locator(".subagent-title").innerText()).includes(DESCRIPTION));
    const box = detail.locator(".subagent-message .composer-input");
    await until("the message box ready", async () => (await box.getAttribute("placeholder")) === "Message this subagent");
    if ((await detail.locator(".subagent-message .round-button").count()) !== 0) throw new Error("The message box offers to attach files.");
    if ((await tabs().count()) !== 1) throw new Error("Opening the child made a second Subagents tab.");
    const childRequests = requests.filter((entry) => entry.child);
    if (childRequests.length === 0 || !childRequests[0].text.includes(DESCRIPTION)) throw new Error("The child did not receive the description.");

    // A message to the finished child runs a turn of its own; the main session is not asked again.
    const mainBefore = requests.filter((entry) => !entry.child).length;
    await box.fill(MESSAGE);
    await box.press("Enter");
    await detail.getByText(MESSAGE_REPLY).waitFor({ timeout: 45_000 });
    if ((await box.inputValue()) !== "") throw new Error("The message box kept the sent text.");
    const asked = requests.filter((entry) => entry.child && entry.text.includes(MESSAGE));
    if (asked.length !== 1) throw new Error(`The child was asked ${asked.length} times.`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (requests.filter((entry) => !entry.child).length !== mainBefore) throw new Error("The child's answer reached the main session.");

    // The back arrow shows the list, with the finished child under Done.
    await detail.getByRole("button", { name: "Back to subagents" }).click();
    const list = page.locator(`${pane} .subagents`);
    await list.waitFor({ timeout: 15_000 });
    await until("the child under Done", async () => (await list.locator('section[aria-label="Finished subagents"] .subagents-row').count()) === 1);
    if (!(await list.locator('section[aria-label="Finished subagents"] .tasks-heading').innerText()).includes("Done · 1")) throw new Error("The Done heading does not count the child.");
    if (!(await list.locator('section[aria-label="Active subagents"]').innerText()).includes("No active subagents")) throw new Error("The Active list is not empty.");
    const row = list.locator(".subagents-row").first();
    if (!(await row.innerText()).includes(DESCRIPTION)) throw new Error(`The row reads "${await row.innerText()}".`);

    // A row opens the same detail again.
    await row.click();
    await detail.getByText(CHILD_REPLY).waitFor({ timeout: 15_000 });

    // Closing the tab and opening it from the Session menu shows the list, in the same single tab.
    await page.locator(`${pane} .switcher-close`).first().click();
    await tabs().first().waitFor({ state: "detached" });
    await sessionMenu("Subagents");
    await tabs().first().waitFor({ timeout: 15_000 });
    await list.waitFor({ timeout: 15_000 });
    if ((await list.locator(".subagents-row").count()) !== 1) throw new Error("The menu did not open the list.");
    await sessionMenu("Subagents");
    if ((await tabs().count()) !== 1) throw new Error("The menu opened a second Subagents tab.");

    // The card opens the detail through the same tab even while the list is showing.
    await card().click();
    await detail.getByText(CHILD_REPLY).waitFor({ timeout: 15_000 });
    if ((await tabs().count()) !== 1) throw new Error("The card opened a second Subagents tab.");

    console.log("subagents e2e passed");
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

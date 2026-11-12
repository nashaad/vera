// Session tools test for the desktop shell. Run with: node clients/desktop/test/tools.e2e.mjs
// The provider writes a scratch checklist, writes a file and edits it, then answers.
// The test reads the rollup, the Review and Plan views, rewinds one prompt and compacts.

import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { startTrial } from "./trial.mjs";

const BUILT = "The nest is built.";
const SECOND = "The crow is resting.";
const SUMMARY = "Built a nest and rested.";
const PLAN = "# Crow plan\n\n- [x] Write the nest\n- [ ] Line the nest\n";
const SCRATCH_ROOT = join(realpathSync(tmpdir()), "vera");
const requests = [];
let calls = 0;

// The session's scratch folder is named in the system prompt; a checklist written there becomes the plan.
function scratchIn(raw) {
    const escaped = SCRATCH_ROOT.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return new RegExp(`${escaped}/[A-Za-z0-9_-]+`).exec(raw)?.[0];
}

// One tool call per step of the EDIT prompt, chosen by how many tool results follow it.
function stepFor(messages, scratch) {
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const user = JSON.stringify(messages[lastUser]?.content ?? "");
    if (!user.includes("EDIT")) return undefined;
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (results === 0) return { name: "write", input: { path: join(scratch ?? "missing-scratch", "plan.md"), content: PLAN } };
    if (results === 1) return { name: "write", input: { path: "nest.txt", content: "twigs\nmud\n" } };
    if (results === 2) return { name: "edit", input: { path: "nest.txt", edits: [{ old_string: "twigs", new_string: "feathers" }] } };
    return undefined;
}

function replyText(messages) {
    const user = JSON.stringify([...messages].reverse().find((message) => message.role === "user")?.content ?? "");
    if (user.includes("EDIT")) return BUILT;
    if (user.includes("SECOND")) return SECOND;
    return SUMMARY;
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
        requests.push({ role: messages.at(-1)?.role, stream: body.stream });
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: SUMMARY }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const step = stepFor(messages, scratchIn(raw));
        if (step === undefined) {
            response.write(streamChunk(body.model, { role: "assistant", content: replyText(messages) }, "stop"));
        } else {
            calls += 1;
            const call = { index: 0, id: `call-${calls}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.input) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
let failed = false;
let page;

async function sessionMenu(label) {
    await page.locator("[data-session-menu]").click();
    await page.locator(".menu-item", { hasText: label }).first().click();
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "work");
    mkdirSync(folder, { recursive: true });

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill("Build the nest, EDIT it");
    await input.press("Enter");
    await page.waitForSelector("[data-session][data-phase=\"attached\"]", { timeout: 45_000 });
    await page.waitForSelector(`text=${BUILT}`, { timeout: 45_000 });
    await until("the first turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    if (readFileSync(join(folder, "nest.txt"), "utf8") !== "feathers\nmud\n") throw new Error("The edit did not land.");

    // The turn's edits roll up into one card; the scratch checklist is not a file change.
    const rollup = page.locator(".diff-rollup");
    await rollup.waitFor({ timeout: 15_000 });
    const title = await rollup.locator(".diff-rollup-title").innerText();
    if (!/Edited 1 file/.test(title)) throw new Error(`Rollup title was ${title}`);
    // Writes the rollup and the plan already name draw no line of their own.
    if (await page.locator(".run-head").count() !== 0) throw new Error("A run of landed writes drew a summary line.");
    await rollup.locator(".diff-file-head").first().click();
    await rollup.locator(".diff-line[data-kind=\"add\"]", { hasText: "feathers" }).waitFor({ timeout: 5_000 });

    // Review opens the right pane on the same change.
    await rollup.locator(".diff-review").click();
    await page.locator(".change-head", { hasText: "nest.txt" }).first().click();
    await page.locator(".review .diff-line[data-kind=\"del\"]", { hasText: "twigs" }).waitFor({ timeout: 10_000 });

    // The Plan view shows the checklist the provider wrote.
    await page.locator(".switcher-item[aria-label=\"Plan\"]").click();
    await page.locator(".plan-title", { hasText: "Crow plan" }).waitFor({ timeout: 10_000 });
    const progress = await page.locator(".plan-progress").innerText();
    if (progress !== "1 of 2 done") throw new Error(`Plan progress was ${progress}`);

    // The context pill fills in once the host measures the conversation.
    const pill = page.locator(".context-pill");
    await until("a context measurement", async () => (await pill.getAttribute("data-empty")) === "false");

    // Rewind the newest prompt: its text comes back to the composer.
    await input.fill("Say SECOND");
    await input.press("Enter");
    await page.waitForSelector(`text=${SECOND}`, { timeout: 30_000 });
    await until("the second turn to end", async () => (await send.getAttribute("data-mode")) === "send");
    await sessionMenu("Rewind or Fork");
    const rows = page.locator(".rewind-row");
    await until("two prompts to rewind to", async () => (await rows.count()) === 2);
    await rows.first().getByRole("button", { name: "Rewind here" }).click();
    await page.locator(".session-sheet").getByRole("button", { name: "Rewind", exact: true }).click();
    await page.locator(".session-sheet").waitFor({ state: "detached", timeout: 15_000 });
    await until("the prompt back in the composer", async () => (await input.inputValue()) === "Say SECOND");
    await page.locator(`text=${SECOND}`).waitFor({ state: "detached", timeout: 15_000 });

    // Compact from the session menu runs to a finished notice.
    await input.fill("");
    await sessionMenu("Compact");
    const action = page.locator(".session-sheet-action");
    await action.click();
    await until("compaction to finish", async () => (await action.innerText()) === "Done", 45_000);
    await action.click();
    await page.locator(".session-sheet").waitFor({ state: "detached", timeout: 5_000 });
    console.log("tools e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    console.error("Provider saw:", requests);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);

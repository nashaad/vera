// Session tools test for the desktop shell. Run with: node clients/desktop/test/tools.e2e.mjs
// The provider writes a scratch checklist, writes a file and edits it, then answers.
// The test reads the rollup, the Review, Plan and Files views, quotes a reply, rewinds one prompt and compacts,
// then works the sidebar row's menu.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { setSidebarGrouping } from "./sidebar.mjs";
import { startTrial } from "./trial.mjs";

const BUILT = "The nest is built.";
const BUILD_REPORT = Array.from({ length: 10 }, () =>
    "The crow checked every twig twice, packed mud into the gaps, lined the cup with feathers, and stepped back to look at the rim."
).join(" ");
const SECOND = "The crow is resting.";
const SUMMARY = "Built a nest and rested.";
const PLAN = "# Crow plan\n\n- [x] Write the nest\n- [ ] Line the nest\n";
// A first prompt longer than the summary note, so replacing it with the note shrinks the context.
const BRIEF = "Line the nest with feathers, keep the eggs warm, and watch the west wind. ".repeat(80);
const requests = [];
let calls = 0;

// The session's scratch folder is named in the system prompt; a checklist written there becomes the plan.
function scratchIn(raw) {
    return /scratch directory: ([^\\\s"]+)/.exec(raw)?.[1];
}

// The summarizer sends the transcript as its prompt, so it must not be taken for the EDIT turn.
function summarizerPrompt(messages) {
    return JSON.stringify(messages.at(-1)?.content ?? "").includes("<transcript>");
}

// One tool call per step of the EDIT prompt, chosen by how many tool results follow it.
function stepFor(messages, scratch) {
    if (summarizerPrompt(messages)) return undefined;
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const user = JSON.stringify(messages[lastUser]?.content ?? "");
    if (user.includes("Write the handover note") || user.includes("Produce the updated note")) return undefined;
    if (!user.includes("EDIT")) return undefined;
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (results === 0) return { name: "write", input: { path: join(scratch ?? "missing-scratch", "plan.md"), content: PLAN } };
    if (results === 1) return { name: "write", input: { path: "nest.txt", content: "twigs\nmud\n" } };
    if (results === 2) return { name: "edit", input: { path: "nest.txt", edits: [{ old_string: "twigs", new_string: "feathers" }] } };
    return undefined;
}

function replyText(messages) {
    if (summarizerPrompt(messages)) return SUMMARY;
    const user = JSON.stringify([...messages].reverse().find((message) => message.role === "user")?.content ?? "");
    if (user.includes("EDIT")) return `${BUILT}\n\n${BUILD_REPORT}`;
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

async function closeMenuInside(where) {
    const menu = page.locator(".menu").last();
    await menu.waitFor({ timeout: 5_000 });
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
        throw new Error(`${where} menu outside the viewport: ${JSON.stringify({ box, viewport })}`);
    }
    await page.keyboard.press("Escape");
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port, "auto");
    const folder = join(trial.home, "..", "work");
    mkdirSync(join(folder, "hold"), { recursive: true });
    writeFileSync(join(folder, "hold", "doubloon.txt"), "gold\n");

    const app = await trial.launch();
    await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, folder);

    page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions=\"0\"]", { timeout: 45_000 });
    await setSidebarGrouping(page, "folder");
    await trial.waitForHost();

    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(".context-chips .chip-label:text-is(\"work\")");
    const input = page.locator(".composer-input");
    const send = page.locator(".send-button");
    await input.fill(`Build the nest, EDIT it. ${BRIEF}`);
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
    // The file holds the creation run and the edit run, each its own Pierre diff.
    const editRuns = await rollup.locator(".diff-patch").first().evaluate(async (patch) => {
        const read = (container) => {
            const root = container.shadowRoot;
            return {
                lines: [...(root?.querySelectorAll("[data-line]") ?? [])].map((line) => ({
                    type: line.getAttribute("data-line-type"),
                    text: line.textContent?.trim() ?? "",
                })),
                text: root?.textContent ?? "",
            };
        };
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const containers = [...patch.querySelectorAll("diffs-container")];
            if (containers.length >= 2 && containers.every((container) => container.shadowRoot)) {
                const runs = containers.map(read);
                if (runs[0].text.includes("twigs") && runs[1].text.includes("feathers")) return runs;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return [...patch.querySelectorAll("diffs-container")].map(read);
    });
    if (editRuns.length !== 2) throw new Error(`The edit card rendered ${editRuns.length} runs, expected 2.`);
    const created = editRuns[0].lines.filter((line) => line.type === "change-addition").map((line) => line.text);
    if (!created.includes("twigs") || !created.includes("mud")) throw new Error(`The first run did not show the created lines: ${JSON.stringify(editRuns[0])}`);
    if (editRuns[0].lines.some((line) => line.type === "change-deletion")) throw new Error(`The first run held a deletion: ${JSON.stringify(editRuns[0])}`);
    const removed = editRuns[1].lines.filter((line) => line.type === "change-deletion").map((line) => line.text);
    const added = editRuns[1].lines.filter((line) => line.type === "change-addition").map((line) => line.text);
    if (!removed.includes("twigs") || !added.includes("feathers")) throw new Error(`The second run did not show twigs removed and feathers added: ${JSON.stringify(editRuns[1])}`);

    // The card header tally keeps a space between its counts, like the top line.
    const cardTallyGap = await page.evaluate(() => {
        const tally = document.querySelector(".diff-file-head .diff-tally");
        const add = tally?.querySelector(".add") ?? null;
        const del = tally?.querySelector(".del") ?? null;
        if (add === null || del === null) return null;
        return Math.round(del.getBoundingClientRect().left - add.getBoundingClientRect().right);
    });
    if (cardTallyGap === null || cardTallyGap < 4) throw new Error(`The card tally has no gap: ${cardTallyGap}`);

    // A card comment takes focus without changing an existing composer draft.
    await input.fill("");
    await input.click();
    await page.keyboard.type("x");
    const draft = await input.inputValue();
    if (draft !== "x" || !await input.evaluate((node) => node === document.activeElement)) {
        throw new Error(`The composer was not focused with its draft: ${JSON.stringify(draft)}`);
    }
    const cardLine = await page.evaluate(() => {
        for (const container of document.querySelectorAll(".diff-patch diffs-container")) {
            const shadow = container.shadowRoot;
            const line = shadow?.querySelector('[data-line][data-line-type="change-addition"]');
            if (!shadow || !line) continue;
            const rect = line.getBoundingClientRect();
            line.dispatchEvent(new PointerEvent("pointermove", {
                bubbles: true,
                composed: true,
                pointerType: "mouse",
                clientX: rect.x + 20,
                clientY: rect.y + rect.height / 2,
            }));
            return { x: rect.x + 20, y: rect.y + rect.height / 2 };
        }
        return undefined;
    });
    if (cardLine === undefined) throw new Error("No changed line in the edit card to comment on.");
    await page.waitForTimeout(300);
    const plus = await page.evaluate(() => {
        for (const container of document.querySelectorAll(".diff-patch diffs-container")) {
            const button = container.shadowRoot?.querySelector("[data-utility-button]");
            if (!button) continue;
            const rect = button.getBoundingClientRect();
            if (rect.width === 0) continue;
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
        return undefined;
    });
    if (plus === undefined) throw new Error("The card's gutter plus did not show on hover.");
    await page.mouse.click(plus.x, plus.y);
    const cardComment = page.locator(".diff-comment-box:not(.diff-comment-readonly) textarea");
    await cardComment.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(150);
    const focus = await page.evaluate(() => {
        const area = document.querySelector(".diff-comment-box:not(.diff-comment-readonly) textarea");
        const active = document.activeElement;
        return {
            focused: area !== null && area === active,
            active: active === null ? "none" : `${active.tagName}.${active.className}`,
        };
    });
    const draftAfterOpen = await input.inputValue();
    if (!focus.focused || draftAfterOpen !== draft) {
        throw new Error(`A card comment box did not take focus with its draft unchanged: ${JSON.stringify({ ...focus, draft, draftAfterOpen })}`);
    }
    await input.click();
    await page.waitForTimeout(350);
    if (!await input.evaluate((node) => node === document.activeElement)) {
        throw new Error("A card comment box took focus back after the composer was clicked.");
    }
    await cardComment.click();
    await page.keyboard.type("y");
    if (await cardComment.inputValue() !== "y" || await input.inputValue() !== draft) {
        throw new Error("Typing a card comment changed the composer draft.");
    }
    await page.keyboard.press("Escape");
    let closed = false;
    try {
        await page.locator(".diff-comment-box:not(.diff-comment-readonly)").waitFor({ state: "detached", timeout: 3_000 });
        closed = true;
    } catch {
        closed = false;
    }
    if (!closed) throw new Error("Escape did not close the card comment box.");
    if (await input.inputValue() !== draft) throw new Error("Escape changed the composer draft.");
    await input.fill("");

    // The edit-card file menu stays inside the window at each checked width.
    const patchMenu = rollup.locator(".diff-file-more").first();
    for (const width of [1500, 1150, 980]) {
        await page.setViewportSize({ width, height: 800 });
        await patchMenu.click();
        await closeMenuInside(`${width}px edit-card`);
    }

    // Review opens the right pane on the same change, one item per run.
    await rollup.locator(".diff-review").click();
    const reviewMenus = page.locator(".review-file-actions .diff-file-more");
    const reviewRuns = () => page.locator(".review diffs-container").evaluateAll((containers) => containers.map((container) => {
        const root = container.shadowRoot;
        return {
            title: root?.querySelector("[data-title]")?.textContent ?? "",
            text: root?.textContent ?? "",
            lines: root?.querySelectorAll("[data-line]").length ?? 0,
        };
    }));
    await until("both nest.txt runs in Review", async () => {
        const runs = await reviewRuns();
        return runs.filter((run) => run.title === "nest.txt").length === 2;
    });
    for (const width of [1500, 1150, 980]) {
        await page.setViewportSize({ width, height: 800 });
        await reviewMenus.first().click();
        await closeMenuInside(`${width}px Review`);
    }
    if (await reviewMenus.count() !== 2) throw new Error(`Review rendered ${await reviewMenus.count()} header menus for two runs.`);
    await page.setViewportSize({ width: 1200, height: 800 });
    await reviewMenus.nth(1).click();
    await page.getByRole("menuitem", { name: "Collapse file" }).click();
    await until("both nest.txt runs to collapse with both headers showing", async () => {
        const nests = (await reviewRuns()).filter((run) => run.title === "nest.txt");
        return nests.length === 2 && nests.every((run) => run.lines === 0);
    });
    // Collapsed Review content fits, so the sticky container must not clamp it below the top.
    const reviewGap = await page.evaluate(async () => {
        const diff = document.querySelector(".review-diffs");
        if (diff !== null) {
            diff.scrollTop = 0;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
        const container = document.querySelector(".review diffs-container");
        const header = container?.shadowRoot?.querySelector("[data-diffs-header], [data-header]") ?? container;
        const box = (node) => {
            const rect = node?.getBoundingClientRect();
            return rect === undefined ? null : { top: rect.top, bottom: rect.bottom };
        };
        return { diff: box(diff), header: box(header), scrollHeight: diff?.scrollHeight ?? null, clientHeight: diff?.clientHeight ?? null };
    });
    if (reviewGap.diff === null || reviewGap.header === null || reviewGap.header.top - reviewGap.diff.top >= 40) {
        throw new Error(`Review left a gap above the first collapsed file: ${JSON.stringify(reviewGap)}`);
    }
    await reviewMenus.nth(1).click();
    await page.getByRole("menuitem", { name: "Expand file" }).click();
    let nests = [];
    await until("both nest.txt runs to expand with feathers in the second", async () => {
        nests = (await reviewRuns()).filter((run) => run.title === "nest.txt");
        return nests.length === 2 && nests.every((run) => run.lines > 0) && nests[1].text.includes("feathers");
    });
    if (nests[0].text.includes("feathers")) throw new Error("Review's first run held the later edit.");

    // The Plan view shows the checklist the provider wrote; a pane opens from the right pane's "+".
    const openPane = async (title) => {
        await page.locator("[data-pane-launcher]").click();
        await page.locator(`[data-pane-option] .pane-launcher-title:text-is("${title}")`).click();
        await page.locator(`.switcher-item[aria-label="${title}"]`).waitFor({ timeout: 5_000 });
    };
    await openPane("Plan");
    await page.locator(".plan-title", { hasText: "Crow plan" }).waitFor({ timeout: 10_000 });
    const progress = await page.locator(".plan-progress").innerText();
    if (progress !== "1 of 2 done") throw new Error(`Plan progress was ${progress}`);
    if (await page.locator('.plan-item[data-just-done="true"]').count() !== 0) throw new Error('A completed turn kept a highlighted Plan row.');
    await app.evaluate(({ shell }) => {
        globalThis.openedPlan = undefined;
        globalThis.failPlan = true;
        shell.openPath = async (path) => { globalThis.openedPlan = path; return globalThis.failPlan ? 'failed' : ''; };
    });
    const planPath = page.getByRole('button', { name: 'Open plan file' });
    await planPath.focus();
    await page.keyboard.press('Enter');
    await page.getByText('The plan file could not be opened').waitFor();
    if (!(await app.evaluate(() => globalThis.openedPlan))?.endsWith('/plan.md')) throw new Error('Plan opened the wrong path.');
    await app.evaluate(() => { globalThis.failPlan = false; globalThis.openedPlan = undefined; });
    await planPath.click();
    await until('plan opened', async () => Boolean(await app.evaluate(() => globalThis.openedPlan)));
    await page.locator('.plan-title', { hasText: 'Crow plan' }).waitFor();
    await page.locator('.sessions-view .session-group .group-head').first().waitFor({ timeout: 15_000 });
    const layout = async () => page.evaluate(() => {
        const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
        const progress = box('.plan-progress');
        const action = box('[data-view="core.plan"] > .view-header .view-actions');
        const group = box('.sessions-view > .session-group:first-child .group-head');
        const groupAction = box('[data-view="core.sessions"] > .view-header .view-actions');
        return { progress: progress && { right: progress.right }, action: action && { left: action.left }, group: group && { center: (group.top + group.bottom) / 2 }, groupAction: groupAction && { center: (groupAction.top + groupAction.bottom) / 2 } };
    });
    for (const width of [1200, 800]) {
        await page.setViewportSize({ width, height: 800 });
        const positions = await layout();
        if (!positions.progress || !positions.action || positions.progress.right > positions.action.left) throw new Error(`Plan progress overlaps actions: ${JSON.stringify(positions)}`);
        if (!positions.group || !positions.groupAction || Math.abs(positions.group.center - positions.groupAction.center) > 2) throw new Error(`Group actions are misaligned: ${JSON.stringify(positions)}`);
    }
    await page.setViewportSize({ width: 1200, height: 800 });

    // The Files view reads the session's folder itself, one folder at a time.
    await openPane("Files");
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: /nest\.txt/ }).waitFor({ timeout: 10_000 });
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: 'hold' }).click();
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: /doubloon\.txt/ }).waitFor({ timeout: 10_000 });

    // A file opens in a preview tab with numbered source lines.
    const nestEntry = page.locator('.vera-file-tree').getByRole('treeitem', { name: /nest\.txt/ });
    await nestEntry.click();
    await page.locator(".files-code [data-line]", { hasText: "feathers" }).waitFor({ timeout: 10_000 });
    const gutter = await page.locator(".files-code [data-column-number]").allTextContents();
    if (gutter.slice(0, 2).join("\n") !== "1\n2") throw new Error(`The gutter numbered ${JSON.stringify(gutter)}`);
    const shownPath = async () => page.locator(".file-preview-path").innerText();
    if (await shownPath() !== "nest.txt") throw new Error(`The preview named ${await shownPath()}`);
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: /nest\.txt/, selected: true }).waitFor({ timeout: 5_000 });
    await nestEntry.dblclick();
    if (await page.locator(".file-tab--preview", { hasText: "nest.txt" }).count() !== 0) throw new Error("A double-click did not keep the tab.");

    // A second preview leaves the kept tab available, and Browse files hides and shows the tree.
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: /doubloon\.txt/ }).click();
    await until("doubloon.txt open", async () => (await shownPath()) === "hold/doubloon.txt");
    await page.getByRole("tab", { name: /nest.txt/ }).click();
    await until("nest.txt open again", async () => (await shownPath()) === "nest.txt");
    await page.getByRole("tab", { name: /doubloon.txt/ }).click();
    await until("doubloon.txt open again", async () => (await shownPath()) === "hold/doubloon.txt");
    const browse = page.getByRole("button", { name: "Browse files" });
    await browse.click();
    await page.locator(".files-tree").waitFor({ state: "hidden", timeout: 5_000 });
    await browse.click();
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: /doubloon\.txt/, selected: true }).waitFor({ timeout: 5_000 });

    // The context pill fills in once the host measures the conversation.
    const pill = page.locator(".context-pill");
    await until("a context measurement", async () => (await pill.getAttribute("data-empty")) === "false");

    // Rewind the newest prompt: its text comes back to the composer.
    await input.fill("Say SECOND");
    await input.press("Enter");
    await page.waitForSelector(`text=${SECOND}`, { timeout: 30_000 });
    await until("the second turn to end", async () => (await send.getAttribute("data-mode")) === "send");

    // The reply menu quotes the reply into the composer and leaves the caret there.
    const replyMenu = async (label) => {
        await page.locator(".turn-actions").last().getByRole("button", { name: "Reply menu" }).click();
        await page.getByRole("menuitem", { name: label }).click();
    };
    await replyMenu("Quote in Reply");
    await until("the quoted reply", async () => (await input.inputValue()).startsWith(`> ${SECOND}`));
    if (!await input.evaluate((box) => box === document.activeElement)) throw new Error("The composer lost focus after quoting.");
    await input.fill("");
    await replyMenu("Rewind or Fork");
    const rows = page.locator(".rewind-row");
    await until("two prompts to rewind to", async () => (await rows.count()) === 2);
    await rows.first().getByRole("button", { name: "Rewind here" }).click();
    await page.locator(".session-sheet").getByRole("button", { name: "Rewind", exact: true }).click();
    await page.locator(".session-sheet").waitFor({ state: "detached", timeout: 15_000 });
    await until("the prompt back in the composer", async () => (await input.inputValue()) === "Say SECOND");
    await page.locator(`text=${SECOND}`).waitFor({ state: "detached", timeout: 15_000 });

    // Compact from the session menu starts at once and ends in a transcript notice, with no sheet in the way.
    await input.fill("");
    await sessionMenu("Compact");
    const compactNotice = page.locator(".transcript-notice", { hasText: /Compacted the conversation|Nothing (older )?to (compact|summarize) yet/ });
    await compactNotice.first().waitFor({ timeout: 45_000 });
    const compactText = await compactNotice.first().innerText();
    if (!compactText.includes("Compacted the conversation")) throw new Error(`Compact did not summarize: ${compactText}`);
    if (await page.locator(".session-sheet").count() !== 0) throw new Error("Compact opened a sheet.");
    if (!await input.isEnabled()) throw new Error("The composer was not usable after compacting.");

    // Rename from the row menu while another page is open: the session opens with its rename sheet.
    const agentId = await page.locator(".session-row[data-active=\"true\"]").getAttribute("data-session");
    const rowItem = (id) => page.locator(`.session-item:has(.session-row[data-session="${id}"])`);
    const rowMenu = async (id, label) => {
        await rowItem(id).hover();
        await rowItem(id).locator(".session-more").click();
        await page.getByRole("menuitem", { name: label }).click();
    };
    await page.locator(".group-title", { hasText: "work" }).click();
    await page.waitForSelector("main[data-page=\"workspace\"]", { timeout: 10_000 });
    await rowMenu(agentId, "Rename…");
    await page.locator(".session-sheet").waitFor({ timeout: 10_000 });
    await page.locator(`.session-row[data-active="true"][data-session="${agentId}"]`).waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.locator(".session-sheet").waitFor({ state: "detached", timeout: 5_000 });

    // Pin moves the row into Pinned and saves it in the desktop's own file under the home.
    const pinsFile = join(trial.home, "machine", "desktop", "pins.json");
    const savedPins = () => {
        try {
            return JSON.parse(readFileSync(pinsFile, "utf8")).sessions;
        } catch {
            return undefined;
        }
    };
    await rowMenu(agentId, "Pin Session");
    await page.locator(`[data-group="pinned"] .session-row[data-session="${agentId}"]`).waitFor({ timeout: 5_000 });
    await until("the pin on disk", async () => savedPins()?.includes(agentId) === true);

    // Open Files Pane brings the right pane back to Files.
    await page.locator(".switcher-item[aria-label=\"Plan\"]").click();
    await page.locator(".plan-title").waitFor({ timeout: 5_000 });
    await rowMenu(agentId, "Open Files Pane");
    await page.locator('.vera-file-tree').getByRole('treeitem', { name: /nest\.txt/ }).waitFor({ timeout: 10_000 });

    // Right-click opens the same menu; Unpin puts the row back under its folder.
    await rowItem(agentId).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin Session" }).click();
    await page.locator("[data-group=\"pinned\"]").waitFor({ state: "detached", timeout: 5_000 });
    await until("the unpin on disk", async () => savedPins()?.length === 0);

    // Clone opens the copy; closing the open copy from its row returns to New Chat.
    await rowMenu(agentId, "Clone Session");
    const rowsInSidebar = page.locator(".session-row");
    await until("the clone in the sidebar", async () => (await rowsInSidebar.count()) === 2, 30_000);
    const cloneId = await page.locator(".session-row[data-active=\"true\"]").getAttribute("data-session");
    if (cloneId === agentId) throw new Error("Clone did not open the copy.");
    await until("the clone to run", async () => (await rowItem(cloneId).locator(".session-row").getAttribute("data-live")) === "true", 30_000);
    await rowMenu(cloneId, "Close Session");
    await page.waitForSelector("main[data-page=\"home\"]", { timeout: 15_000 });
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

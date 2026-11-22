// Sidebar test for the desktop window. Run with: node clients/desktop/test/sidebar.e2e.mjs
// Seeds the sample home, then checks the pinned row, folder grouping, a moved branch, a kept
// child conversation, unpinning, and restored settings on relaunch and on a second home.

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { setSidebarGrouping } from "./sidebar.mjs";
import { SAMPLE, seedSidebarSample } from "./sidebar-sample.mjs";
import { startTrial } from "./trial.mjs";

let calls = 0;
let outside = "";

const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crow-0" }] }));
        return;
    }
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
        response.writeHead(404);
        response.end();
        return;
    }
    let raw = "";
    request.on("data", (part) => { raw += part; });
    request.on("end", () => {
        const body = JSON.parse(raw);
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: "Crow" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
            return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const messages = body.messages ?? [];
        const last = messages.at(-1);
        const user = [...messages].reverse().find((message) => message.role === "user");
        const text = JSON.stringify(user?.content ?? "");
        if (last?.role === "user" && text.includes("ASK")) {
            calls += 1;
            const command = `touch ${join(outside, "ask.txt")}`;
            const call = { index: 0, id: `call-${calls}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } };
            response.write(streamChunk(body.model, { role: "assistant", tool_calls: [call] }, "tool_calls"));
        } else {
            response.write(streamChunk(body.model, { role: "assistant", content: "Crow" }, "stop"));
        }
        response.end("data: [DONE]\n\n");
    });
});

const trial = startTrial();
const other = startTrial();
let failed = false;
let page;

async function appOn(which) {
    const app = await which.launch();
    const window = await app.firstWindow();
    await window.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await which.waitForHost();
    return { app, page: window };
}

try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    configureFauxHome(trial.home, provider.address().port);
    outside = join(trial.home, "..", "outside");
    mkdirSync(outside, { recursive: true });
    seedSidebarSample(trial.home);
    const first = await appOn(trial);
    page = first.page;

    // 1. The pinned sample session sits at the top and the ordinary list still shows Trace.
    const usage = page.locator(`.session-row[data-session="${SAMPLE.usage}"]`);
    await usage.waitFor({ timeout: 45_000 });
    const pinned = page.locator('.session-group[data-group="pinned"]');
    await pinned.waitFor();
    if (!(await pinned.innerText()).includes("Usage audit")) throw new Error("Pinned does not list Usage audit.");
    if (await page.locator(`.session-row[data-session="${SAMPLE.trace}"]`).count() !== 1) throw new Error("Trace missing usage is not in the ordinary list.");
    if (await page.locator(".sidebar-foot-state").count() !== 1) throw new Error("The footer does not show one connection state.");

    // 2. Group by Folder writes the workspace name once; usechart keeps a heading for its two
    // top-level sessions, while a sole same-named session shares one folder row.
    await setSidebarGrouping(page, "folder");
    const usechartFolder = join(trial.home, "..", "sample", "usechart");
    const usechart = page.locator(`.session-group[data-workspace="${usechartFolder}"]`);
    await usechart.waitFor({ timeout: 15_000 });
    if (await usechart.locator('.group-title:text-is("usechart")').count() !== 1) throw new Error("usechart is not one folder heading.");
    if (await page.locator('.group-title:text-is("usechart")').count() !== 1) throw new Error("usechart is named more than once.");
    const stopFolder = join(trial.home, "..", "sample", "stopcard");
    const stop = page.locator(`.session-group[data-workspace="${stopFolder}"]`);
    await stop.waitFor({ timeout: 15_000 });
    if (await stop.locator(".group-head").count() !== 0) throw new Error("stopcard kept a separate folder heading.");
    if (await stop.locator('.session-row[data-session="stopcard"]').count() !== 1) throw new Error("stopcard is not one clickable row.");
    if (await stop.locator('.session-name[data-folder="true"]:text-is("stopcard")').count() !== 1) throw new Error("stopcard does not share its folder row.");
    const stopRoot = stop.locator(".session-item").first();
    if (await stopRoot.getAttribute("data-depth") !== "0") throw new Error("The shared folder row is indented as if it sat under a heading.");
    if (await stopRoot.locator(".session-branch").count() !== 0) throw new Error("The shared folder row draws a heading guide.");
    const [usechartIcon, stopIcon] = await Promise.all([
        usechart.locator(".group-folder-icon").first().boundingBox(),
        stop.locator(".session-folder-icon").first().boundingBox(),
    ]);
    if (usechartIcon === null || stopIcon === null || Math.abs(usechartIcon.x - stopIcon.x) > 0.5) throw new Error("The shared folder row's icon does not line up with the folder heading's icon.");
    await stop.locator(".session-fold").click();
    await until("stopcard's nine children", async () => await stop.locator('.session-item[data-nested="true"]').count() === 9, 15_000);
    if (await stop.locator('.session-name[data-folder="true"]').count() !== 1) throw new Error("A child row also drew the folder icon.");
    if (await stop.locator(".session-pin").count() !== 1) throw new Error("A nested row offered Pin.");
    await stop.locator(".session-fold").click();

    // 3. Expand Trace, open a child, then pin the parent: the branch moves whole and once.
    const traceItem = page.locator(`.session-item:has(.session-row[data-session="${SAMPLE.trace}"])`);
    await traceItem.locator(".session-fold").click();
    const child = page.locator(`.session-row[data-session="${SAMPLE.server}"]`);
    await child.waitFor({ timeout: 15_000 });
    await until("Trace's four direct children", async () => await usechart.locator('.session-item[data-nested="true"]').count() === 4, 15_000);
    await child.click();
    await page.waitForSelector(`.transcript-scroll[data-session="${SAMPLE.server}"]`, { timeout: 15_000 });
    await traceItem.locator(".session-pin").click();
    await page.locator(`.session-group[data-group="pinned"] .session-row[data-session="${SAMPLE.trace}"]`).waitFor({ timeout: 15_000 });
    if (await page.locator(`.session-row[data-session="${SAMPLE.server}"]`).count() !== 1) throw new Error("The pinned branch lists the child twice.");
    const childTitle = async () => (await page.locator(".titlebar-title").innerText()).trim();
    if (await childTitle() !== "Server-side buckets") throw new Error("Pinning closed the selected child.");

    // 4. Toggle grouping while the child is selected, then collapse its parent.
    await setSidebarGrouping(page, "none");
    if (await childTitle() !== "Server-side buckets") throw new Error("Toggling grouping closed the selected child.");
    const pinnedTrace = page.locator(`.session-item:has(.session-row[data-session="${SAMPLE.trace}"])`);
    await pinnedTrace.locator(".session-fold").click();
    if (await page.locator(`.session-row[data-session="${SAMPLE.server}"]`).count() !== 0) throw new Error("Collapsing left the child row visible.");
    if (await childTitle() !== "Server-side buckets") throw new Error("Collapsing closed the selected child.");
    const sidebar = await page.locator(".sessions-view").boundingBox();
    if (sidebar === null || sidebar.width <= 0) throw new Error("The sidebar is not visible.");

    // 5. A waiting root shows the question indicator; it focuses the reply field and a draft
    // survives grouping changes.
    await page.locator(`.session-row[data-session="${SAMPLE.usage}"]`).click();
    await page.waitForSelector(`[data-session="${SAMPLE.usage}"][data-phase="attached"]`, { timeout: 30_000 });
    const mode = page.locator(".approval-picker .pill-button");
    await page.waitForSelector(".approval-picker .pill-button[data-mode]", { timeout: 15_000 });
    if (await mode.getAttribute("data-mode") !== "ask") {
        await mode.click();
        await page.getByRole("menuitemradio", { name: /Ask for approval/ }).click();
        await page.waitForSelector('.approval-picker .pill-button[data-mode="ask"]', { timeout: 15_000 });
    }
    const input = page.locator(".composer-input");
    await input.fill("ASK for approval");
    await input.press("Enter");
    await page.locator('.request-card[data-kind="approval"]').waitFor({ timeout: 30_000 });
    const usageItem = page.locator(`.session-item:has(.session-row[data-session="${SAMPLE.usage}"])`);
    await usageItem.locator(".session-question").waitFor({ timeout: 15_000 });
    await input.fill("Draft stays");
    await usageItem.locator(".session-question").click();
    await until("the reply field to take focus", async () => await input.evaluate((element) => element === document.activeElement), 5_000);
    if (await input.inputValue() !== "Draft stays") throw new Error("The question indicator dropped the draft.");
    await setSidebarGrouping(page, "none");
    if (await input.inputValue() !== "Draft stays") throw new Error("Changing grouping dropped the draft.");
    await setSidebarGrouping(page, "folder");
    if (await input.inputValue() !== "Draft stays") throw new Error("Changing grouping back dropped the draft.");
    await page.locator('.request-card[data-kind="approval"]').getByRole("button", { name: "Deny", exact: true }).click();
    await usageItem.locator(".session-question").waitFor({ state: "detached", timeout: 15_000 });
    await input.fill("");

    // 6. Unpin the last pinned session: Pinned goes away and the row returns to its folder.
    await page.locator(`.session-group[data-group="pinned"] .session-pin[data-pin="${SAMPLE.usage}"]`).click();
    await page.locator(`.session-group[data-group="pinned"] .session-pin[data-pin="${SAMPLE.trace}"]`).click();
    if (await page.locator('.session-group[data-group="pinned"]').count() !== 0) throw new Error("Pinned stayed after the last unpin.");
    await page.locator(`.session-group[data-workspace="${usechartFolder}"] .session-row[data-session="${SAMPLE.trace}"]`).waitFor({ timeout: 15_000 });
    await setSidebarGrouping(page, "none");
    const firstGroup = page.locator(".sessions-view > .session-group").first();
    if (await firstGroup.getAttribute("data-group") !== "flat") throw new Error("The unpinned list does not start with the plain list.");
    const [headerBox, firstRowBox] = await Promise.all([
        page.locator(".view-header").boundingBox(),
        page.locator(".sessions-view > .session-group:first-child > .session-list > .session-item:first-child .session-line").boundingBox(),
    ]);
    if (headerBox === null || firstRowBox === null || firstRowBox.y < headerBox.y + headerBox.height - 0.5) throw new Error("The floating header overlaps the first flat row.");
    await setSidebarGrouping(page, "folder");

    // 7. Pin again, relaunch, and read the settings back; a second home has its own pins.
    const traceAgain = page.locator(`.session-item:has(.session-row[data-session="${SAMPLE.trace}"])`);
    await traceAgain.locator(".session-pin").click();
    await page.locator(`.session-group[data-group="pinned"] .session-row[data-session="${SAMPLE.trace}"]`).waitFor({ timeout: 15_000 });
    await first.app.close();
    const again = await appOn(trial);
    page = again.page;
    if (await page.locator('.sessions-view[data-grouping="folder"]').count() !== 1) throw new Error("Group by Folder did not survive relaunch.");
    await page.locator(`.session-group[data-group="pinned"] .session-row[data-session="${SAMPLE.trace}"]`).waitFor({ timeout: 15_000 });
    const usechartAfter = page.locator(`.session-group[data-workspace="${usechartFolder}"]`);
    await usechartAfter.waitFor({ timeout: 15_000 });
    if (await usechartAfter.locator(`.session-row[data-session="${SAMPLE.trace}"]`).count() !== 0) throw new Error("The pinned usechart root stayed in the ordinary list.");
    if (await usechartAfter.locator(`.session-row[data-session="${SAMPLE.usage}"]`).count() !== 1) throw new Error("The unpinned Usage audit did not return to usechart.");

    configureFauxHome(other.home, provider.address().port);
    seedSidebarSample(other.home, { pins: [], grouping: "none" });
    const second = await appOn(other);
    page = second.page;
    await page.locator(`.session-row[data-session="${SAMPLE.usage}"]`).waitFor({ timeout: 45_000 });
    if (await page.locator('.session-group[data-group="pinned"]').count() !== 0) throw new Error("The second home inherited the first home's pins.");
    if (await page.locator('.sessions-view[data-grouping="none"]').count() !== 1) throw new Error("The second home did not start with Group by None.");
    console.log("sidebar e2e passed");
} catch (error) {
    failed = true;
    console.error(error);
    if (page !== undefined) console.error("Page text:", await page.locator(".app").first().innerText().catch(() => "unreadable"));
} finally {
    await trial.cleanup().catch((error) => { failed = true; console.error(error); });
    await other.cleanup().catch((error) => { failed = true; console.error(error); });
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);

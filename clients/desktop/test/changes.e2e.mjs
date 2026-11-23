// Changes pane trial: branch and uncommitted git reads in Vera Git, process counts, the tree,
// one-file mode, comments, a Trusted Types sweep, and the screenshot states.
// Run: node clients/desktop/test/changes.e2e.mjs <shots dir>
// VERA_CHANGES_SHOTS names the folder when no argument is given.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { configureFauxHome, streamChunk, until } from "./faux-home.mjs";
import { COUNT_PROCESSES, MODIFIER, press, startTrial } from "./trial.mjs";

const REPLY = "The crow ledger is ready.";
const shots = process.argv[2] ?? process.env.VERA_CHANGES_SHOTS ?? join(tmpdir(), "vera-changes-shots");
mkdirSync(shots, { recursive: true });

let turns = 0;
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
        if (body.stream === false) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "reply",
                model: body.model,
                choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
            return;
        }
        turns += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(streamChunk(body.model, { role: "assistant", content: REPLY }, "stop"));
        response.end("data: [DONE]\n\n");
    });
});

function write(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

function git(folder, args) {
    return execFileSync("git", ["-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function init(folder) {
    mkdirSync(folder, { recursive: true });
    git(folder, ["init", "-q", "-b", "main"]);
    git(folder, ["config", "user.name", "Vera Trial"]);
    git(folder, ["config", "user.email", "trial@vera.invalid"]);
    git(folder, ["config", "commit.gpgsign", "false"]);
    git(folder, ["config", "tag.gpgsign", "false"]);
}

function commit(folder, message) {
    git(folder, ["add", "-A"]);
    git(folder, ["commit", "-q", "-m", message]);
}

function body(count) {
    return `${Array.from({ length: count }, (_, line) => `export const line${line} = ${line};`).join("\n")}\n`;
}

function editBody(count, index) {
    const lines = body(count).split("\n");
    lines[9] = `export const line9 = "Port Royal ${index}";`;
    lines[99] = `export const line99 = "Nassau ${index}";`;
    return `${lines.join("\n")}`;
}

// The 60-file repository: two hunks per file, an untracked and a staged change, and a release branch.
function sixtyRepository(root) {
    const folder = join(root, "sixty");
    init(folder);
    const paths = [];
    for (let index = 0; index < 60; index += 1) {
        const path = `src/group-${Math.floor(index / 10)}/file-${String(index).padStart(2, "0")}.ts`;
        paths.push(path);
        write(join(folder, path), body(120));
    }
    write(join(folder, "old/gone.txt"), "gone\n");
    write(join(folder, "old/name.ts"), body(20));
    write(join(folder, "big.ts"), body(600));
    writeFileSync(join(folder, "logo.bin"), Buffer.from([0, 1, 2, 3]));
    commit(folder, "base");
    git(folder, ["checkout", "-q", "-b", "release"]);
    write(join(folder, "release-notes.md"), "# Release\n");
    commit(folder, "release notes");
    git(folder, ["checkout", "-q", "main"]);
    git(folder, ["checkout", "-q", "-b", "feature"]);
    for (let index = 0; index < paths.length; index += 1) write(join(folder, paths[index]), editBody(120, index));
    rmSync(join(folder, "old/gone.txt"));
    mkdirSync(join(folder, "renamed"), { recursive: true });
    git(folder, ["mv", "old/name.ts", "renamed/name.ts"]);
    write(join(folder, "big.ts"), body(600).replaceAll("line", "large"));
    writeFileSync(join(folder, "logo.bin"), Buffer.from([0, 9, 9, 9, 0, 255, 254, 0, 7]));
    commit(folder, "feature changes");
    const first = join(folder, paths[0]);
    writeFileSync(first, `${readFileSync(first, "utf8")}uncommitted line\n`);
    write(join(folder, "notes/new.txt"), "untracked\n");
    write(join(folder, "notes/staged.txt"), "staged\n");
    write(join(folder, "solo/only.txt"), "alone\n");
    git(folder, ["add", "notes/staged.txt"]);
    return folder;
}

function fiveHundredRepository(root) {
    const folder = join(root, "fivehundred");
    init(folder);
    for (let index = 0; index < 500; index += 1) {
        write(join(folder, `packages/p${Math.floor(index / 50)}/module-${String(index).padStart(3, "0")}.ts`), body(30));
    }
    write(join(folder, "aaa.ts"), body(30));
    commit(folder, "base");
    git(folder, ["checkout", "-q", "-b", "feature"]);
    for (let index = 0; index < 500; index += 1) {
        const path = join(folder, `packages/p${Math.floor(index / 50)}/module-${String(index).padStart(3, "0")}.ts`);
        const lines = body(30).split("\n");
        lines[5] = `export const line5 = "Crow ${index}";`;
        writeFileSync(path, lines.join("\n"));
    }
    writeFileSync(join(folder, "aaa.ts"), editBody(30, 500));
    commit(folder, "five hundred changes");
    return folder;
}

function processes(app) {
    return app.evaluate(({ app: electronApp }) => ({
        started: globalThis.utilityStarts["Vera Git"] ?? 0,
        live: globalThis.utilityLive["Vera Git"] ?? 0,
        max: globalThis.utilityMax["Vera Git"] ?? 0,
        times: globalThis.utilityTimes["Vera Git"] ?? [],
        running: electronApp.getAppMetrics().filter((metric) => metric.name === "Vera Git").length,
    }));
}

async function idle(app, label, atLeast = 0) {
    await until(label, async () => {
        const counts = await processes(app);
        return counts.live === 0 && counts.running === 0 && counts.started >= atLeast;
    }, 60_000);
    return processes(app);
}

async function openFolder(app, page, folder, label) {
    await app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, folder);
    await page.getByRole("button", { name: /No folder/ }).click();
    await page.getByRole("menuitem", { name: /Open folder/ }).click();
    await page.waitForSelector(`.context-chips .chip-label:text-is("${label}")`, { timeout: 15_000 });
}

async function attach(page, label) {
    const input = page.locator(".composer-input");
    await input.fill(`Tell me about ${label}`);
    await input.press("Enter");
    await page.getByText(REPLY).waitFor({ timeout: 60_000 });
    await until("the turn to end", async () => (await page.locator(".send-button").getAttribute("data-mode")) === "send", 60_000);
}

async function waitForDiff(page) {
    await page.locator(".changes-file-header").first().waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".changes-diffs diffs-container")]
        .some((container) => container.shadowRoot?.querySelector("[data-line]") !== null), undefined, { timeout: 90_000 });
}

async function openChanges(page) {
    if (await page.locator(".changes-view").count() === 0) {
        await page.getByRole("button", { name: "Toggle Right Pane" }).click();
        await page.locator("[data-pane-launcher]").click();
        await page.locator('[data-pane-option="core.changes"]').click();
    }
    await page.locator(".changes-view").waitFor({ timeout: 15_000 });
}

async function setTheme(app, page, theme) {
    await app.evaluate(({ Menu }, name) => Menu.getApplicationMenu().getMenuItemById(`theme.${name}`).click(), theme);
    await until(`the ${theme} theme`, () => page.evaluate((name) => document.documentElement.getAttribute("data-theme") === name, theme));
    await page.waitForTimeout(400);
}

async function resize(app, page, width, height = 1000) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });
    await page.waitForTimeout(350);
}

async function shootDestination(app, page, theme, width) {
    await resize(app, page, width);
    await setTheme(app, page, theme);
    if (await page.locator(".changes-destination-pill").getAttribute("aria-expanded") !== "true") {
        await page.locator(".changes-destination-pill").click();
    }
    await page.locator('[role="listbox"][aria-label="Destination branch"]').waitFor({ timeout: 5_000 });
    await page.screenshot({ path: join(shots, `destination-${theme}-${width}.png`) });
    await page.keyboard.press("Escape");
}

function shadowTree(page) {
    return page.evaluate(() => {
        const hosts = [...document.querySelectorAll(".changes-tree *")].filter((node) => node.shadowRoot !== null);
        // The tree root is slotted light DOM, so read the host as well as its shadow.
        return hosts.map((host) => `${host.textContent ?? ""}\n${host.shadowRoot.textContent ?? ""}`.replaceAll("…", "")).join("\n");
    });
}

// Every header piece must stay inside its own box: counts inside the segment,
// the segment inside the scope control, and the control inside the toolbar.
async function headerBoxes(page, width) {
    return page.evaluate((label) => {
        const rect = (element) => {
            if (element === null) return null;
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const inside = (inner, outer) => inner !== null && outer !== null
            && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
            && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
        const toolbar = document.querySelector(".changes-toolbar");
        const scope = document.querySelector(".changes-scope");
        const active = document.querySelector('.changes-scope .right-seg-option[data-on="true"]');
        const counts = active?.querySelector(".changes-scope-counts") ?? null;
        const start = document.querySelector(".changes-toolbar-start");
        const actions = document.querySelector(".changes-toolbar-actions");
        return {
            width: label,
            toolbar: rect(toolbar),
            scope: rect(scope),
            active: rect(active),
            counts: rect(counts),
            countsText: (counts?.textContent ?? "").replace(/\s+/g, " ").trim(),
            countsInsideActive: inside(rect(counts), rect(active)),
            activeInsideScope: inside(rect(active), rect(scope)),
            scopeInsideToolbar: inside(rect(scope), rect(toolbar)),
            startInsideToolbar: inside(rect(start), rect(toolbar)),
            actionsInsideToolbar: inside(rect(actions), rect(toolbar)),
            overflow: toolbar === null ? 0 : toolbar.scrollWidth - toolbar.clientWidth,
        };
    }, width);
}

// The name, the counts and the status letter, read from inside the tree's shadow root.
async function treeRowBoxes(page, fileName) {
    return page.evaluate((name) => {
        const rect = (element) => {
            if (element === null) return null;
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const inside = (inner, outer) => inner !== null && outer !== null
            && inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
            && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
        const hosts = [...document.querySelectorAll(".changes-tree *")].filter((node) => node.shadowRoot !== null);
        for (const host of hosts) {
            for (const row of host.shadowRoot.querySelectorAll('[data-type="item"]')) {
                const path = row.dataset.itemPath ?? "";
                if (path !== name && !path.endsWith(`/${name}`)) continue;
                const content = row.querySelector('[data-item-section="content"]');
                const decoration = row.querySelector('[data-item-section="decoration"]');
                const git = row.querySelector('[data-item-section="git"]');
                const counts = decoration?.firstElementChild ?? null;
                const countsRange = counts === null ? 0 : (() => {
                    const range = document.createRange();
                    range.selectNodeContents(counts);
                    return range.getBoundingClientRect().width;
                })();
                const segments = [...(content?.querySelectorAll('[data-truncate-content="visible"]') ?? [])].map((node) => ({
                    text: node.textContent ?? "",
                    clientWidth: node.clientWidth,
                    scrollWidth: node.scrollWidth,
                }));
                const rowBox = rect(row);
                const contentBox = rect(content);
                const decorationBox = rect(decoration);
                const gitBox = rect(git);
                const decorationClientWidth = decoration?.clientWidth ?? 0;
                const countsContentWidth = counts === null ? 0 : Math.max(counts.scrollWidth, countsRange);
                return {
                    path,
                    row: rowBox,
                    content: contentBox,
                    decoration: decorationBox,
                    git: gitBox,
                    name: segments.map((segment) => segment.text).join(""),
                    nameClipped: segments.some((segment) => segment.scrollWidth > segment.clientWidth + 1),
                    decorationText: (decoration?.textContent ?? "").replace(/\s+/g, " ").trim(),
                    countsState: counts === null ? "absent" : countsContentWidth <= decorationClientWidth + 1 ? "whole" : "partial",
                    countsWidth: { lane: decorationClientWidth, content: countsContentWidth },
                    decorationClipped: counts !== null && countsContentWidth > decorationClientWidth + 1,
                    gitText: (git?.textContent ?? "").trim(),
                    gitClipped: git !== null && git.scrollWidth > git.clientWidth + 1,
                    insideRow: inside(contentBox, rowBox) && inside(decorationBox, rowBox) && inside(gitBox, rowBox),
                    noOverlap: contentBox !== null && decorationBox !== null && gitBox !== null
                        && contentBox.right <= decorationBox.left + 1
                        && decorationBox.right <= gitBox.left + 1,
                };
            }
        }
        return undefined;
    }, fileName);
}

async function treeLayout(page) {
    return page.evaluate(() => {
        const box = (selector) => {
            const element = document.querySelector(selector);
            if (element === null) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
        };
        const split = box(".changes-split");
        const tree = box(".changes-tree");
        const main = box(".changes-main");
        return {
            split,
            tree,
            main,
            treeShare: split === null || tree === null || split.width === 0 ? null : tree.width / split.width,
        };
    });
}

async function treeIndent(page) {
    return page.evaluate(() => {
        const host = [...document.querySelectorAll(".changes-tree *")].find((node) => node.shadowRoot !== null);
        if (host === undefined) return undefined;
        const rows = [...host.shadowRoot.querySelectorAll('[data-type="item"]')];
        const contentLeft = (suffix) => {
            const row = rows.find((entry) => {
                const path = (entry.dataset.itemPath ?? "").replace(/\/+$/, "");
                return path === suffix || path.endsWith(`/${suffix}`);
            });
            const rect = row?.querySelector('[data-item-section="content"]')?.getBoundingClientRect();
            return rect === undefined ? null : rect.left;
        };
        const src = contentLeft("src");
        const group = contentLeft("group-0");
        const file = contentLeft("file-00.ts");
        return {
            src,
            group,
            file,
            steps: {
                "src>group-0": src === null || group === null ? null : group - src,
                "group-0>file-00.ts": group === null || file === null ? null : file - group,
            },
        };
    });
}

async function fileHeaderPath(page, path) {
    return page.evaluate((target) => {
        const label = [...document.querySelectorAll(".changes-file-path")].find((node) => node.title === target) ?? null;
        const folder = label?.querySelector(".changes-file-folder") ?? null;
        const name = label?.querySelector(".changes-file-name") ?? null;
        const measure = (node) => node === null ? null : {
            text: (node.textContent ?? "").trim(),
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            clipped: node.scrollWidth > node.clientWidth + 1,
        };
        return { folder: measure(folder), name: measure(name) };
    }, path);
}

async function fileHeaderDetail(page, path) {
    return page.evaluate((target) => {
        const label = [...document.querySelectorAll(".changes-file-path")].find((node) => node.title === target) ?? null;
        const header = label?.closest(".changes-file-header") ?? null;
        if (header === null) return undefined;
        const box = (node) => {
            if (node === null) return null;
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        };
        const folders = [...label.querySelectorAll(".changes-file-folder")];
        const names = [...label.querySelectorAll(".changes-file-name")];
        const note = header.querySelector(".changes-file-note");
        const actions = header.querySelector(".changes-file-actions");
        const counts = header.querySelector(".changes-file-counts");
        const add = counts?.querySelector(".change-add") ?? null;
        const del = counts?.querySelector(".change-del") ?? null;
        const noteBox = box(note);
        const actionsBox = box(actions);
        const addBox = box(add);
        const delBox = box(del);
        return {
            text: (header.textContent ?? "").replace(/\s+/g, " ").trim(),
            pathText: (label.textContent ?? "").replace(/\s+/g, " ").trim(),
            folders: folders.map((node) => node.textContent ?? ""),
            names: names.map((node) => node.textContent ?? ""),
            nameClipped: names.some((node) => node.scrollWidth > node.clientWidth + 1),
            noteText: note === null ? null : (note.textContent ?? "").trim(),
            headerBox: box(header),
            noteClipped: note !== null && note.scrollWidth > note.clientWidth + 1,
            countsText: counts === null ? "" : (counts.textContent ?? "").replace(/\s+/g, " ").trim(),
            tallyGap: addBox === null || delBox === null ? null : Math.round(delBox.left - addBox.right),
            overlapActions: noteBox !== null && actionsBox !== null && noteBox.right > actionsBox.left + 0.5,
            binarySpan: header.querySelector(".changes-file-binary") !== null,
        };
    }, path);
}

async function treeFilePaths(page) {
    return page.evaluate(() => {
        const paths = [];
        for (const host of [...document.querySelectorAll(".changes-tree *")].filter((node) => node.shadowRoot !== null)) {
            for (const row of host.shadowRoot.querySelectorAll('[data-type="item"]')) {
                const path = row.dataset.itemPath ?? "";
                if (path !== "" && !path.endsWith("/")) paths.push(path);
            }
        }
        return paths;
    });
}

async function treeRootRow(page) {
    return page.evaluate(() => {
        const root = document.querySelector(".changes-tree-root");
        const host = [...document.querySelectorAll(".changes-tree *")].find((node) => node.shadowRoot !== null);
        const first = host?.shadowRoot?.querySelector('[data-type="item"]') ?? null;
        return {
            rootText: (root?.textContent ?? "").replace(/\s+/g, " ").trim(),
            rootTop: root?.getBoundingClientRect().top ?? null,
            firstText: (first?.textContent ?? "").replace(/\s+/g, " ").trim(),
            firstPath: first?.dataset.itemPath ?? "",
            firstTop: first?.getBoundingClientRect().top ?? null,
        };
    });
}

async function treeSelectedPaths(page) {
    return page.evaluate(() => {
        const paths = [];
        for (const host of [...document.querySelectorAll(".changes-tree *")].filter((node) => node.shadowRoot !== null)) {
            for (const row of host.shadowRoot.querySelectorAll('[data-type="item"]')) {
                if (row.dataset.itemSelected === "true" || row.getAttribute("aria-selected") === "true") paths.push(row.dataset.itemPath ?? "");
            }
        }
        return paths;
    });
}

async function scrollPosition(page) {
    return page.evaluate(() => {
        const pane = document.querySelector(".changes-main");
        if (pane === null) return null;
        const scroller = [pane, ...pane.querySelectorAll("*")]
            .flatMap((node) => [node, node.shadowRoot])
            .filter((node) => node !== null && node !== undefined)
            .find((node) => node.scrollHeight > node.clientHeight + 100);
        return scroller === undefined ? null : scroller.scrollTop;
    });
}

async function waitForTree(page, text) {
    try {
        await until(`the tree to list ${text}`, async () => (await shadowTree(page)).includes(text), 20_000);
    } catch (error) {
        console.log(`tree after waiting for ${text}:`, (await shadowTree(page)).replace(/\s+/g, " ").slice(0, 600));
        throw error;
    }
}

async function searchTree(page) {
    return page.evaluate(() => {
        for (const node of document.querySelectorAll(".changes-tree *")) {
            const input = node.shadowRoot?.querySelector('input[placeholder="Filter files..."]');
            if (input) {
                return {
                    found: node.shadowRoot !== null,
                    focused: node.shadowRoot.activeElement === input || document.activeElement === input,
                    placeholder: input.getAttribute("placeholder"),
                };
            }
        }
        return { found: false };
    });
}

async function lineCount(page) {
    return page.evaluate(() => [...document.querySelectorAll(".changes-diffs diffs-container")]
        .reduce((total, container) => total + (container.shadowRoot?.querySelectorAll("[data-line]").length ?? 0), 0));
}

async function findLine(page, text, type) {
    return page.evaluate(async ({ text, type }) => {
        for (const container of document.querySelectorAll(".changes-diffs diffs-container")) {
            const shadow = container.shadowRoot;
            if (!shadow) continue;
            for (const line of shadow.querySelectorAll("[data-line]")) {
                if (type && line.getAttribute("data-line-type") !== type) continue;
                if (!line.textContent.includes(text)) continue;
                line.scrollIntoView({ block: "center" });
                await new Promise((resolve) => setTimeout(resolve, 200));
                const rect = line.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }
        }
        return undefined;
    }, { text, type });
}

async function plusButton(page) {
    return page.evaluate(() => {
        for (const container of document.querySelectorAll(".changes-diffs diffs-container")) {
            const button = container.querySelector("[data-utility-button]") ?? container.shadowRoot?.querySelector("[data-utility-button]");
            if (!button) continue;
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            if (rect.width > 0 && style.visibility !== "hidden" && style.opacity !== "0") {
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
        }
        return undefined;
    });
}

async function separatorCandidate(page) {
    return page.evaluate(() => {
        for (const container of document.querySelectorAll(".changes-diffs diffs-container")) {
            const content = container.shadowRoot?.querySelector("[data-separator-content]");
            if (!content) continue;
            const wrapper = content.closest("[data-separator-wrapper]") ?? content.parentElement;
            const button = wrapper?.querySelector("[data-expand-button]") ?? content;
            button.scrollIntoView({ block: "center" });
            globalThis.__veraSeparator = button;
            return { text: content.textContent.trim(), html: (wrapper ?? button).outerHTML.slice(0, 400) };
        }
        return undefined;
    });
}

async function visibleCommentBox(page) {
    const box = page.locator(".diff-comment-box:not(.diff-comment-readonly):visible").first();
    await box.waitFor({ timeout: 10_000 });
    return box;
}

async function scrollTop(page) {
    await page.evaluate(() => {
        const pane = document.querySelector(".changes-main");
        if (pane === null) return;
        const scroller = [pane, ...pane.querySelectorAll("*")]
            .flatMap((node) => [node, node.shadowRoot])
            .filter((node) => node !== null && node !== undefined)
            .find((node) => node.scrollHeight > node.clientHeight + 100);
        if (scroller) scroller.scrollTop = 0;
    });
    await page.waitForTimeout(500);
}

async function hoverLine(page, point) {
    return page.evaluate(({ x, y }) => {
        for (const container of document.querySelectorAll(".changes-diffs diffs-container")) {
            const shadow = container.shadowRoot;
            if (!shadow) continue;
            for (const line of shadow.querySelectorAll("[data-line]")) {
                const rect = line.getBoundingClientRect();
                if (rect.width === 0 || Math.abs(rect.y - y) > 2 || Math.abs(rect.x - x) > 2) continue;
                line.dispatchEvent(new PointerEvent("pointermove", {
                    bubbles: true,
                    composed: true,
                    pointerType: "mouse",
                    clientX: rect.x + 10,
                    clientY: rect.y + rect.height / 2,
                }));
                return true;
            }
        }
        return false;
    }, point);
}

async function scrollStats(page) {
    return page.evaluate(async () => {
        const pane = document.querySelector(".changes-main");
        const scroller = [pane, ...pane.querySelectorAll("*")]
            .flatMap((node) => [node, node.shadowRoot])
            .filter((node) => node !== null && node !== undefined)
            .find((node) => node.scrollHeight > node.clientHeight + 100);
        if (!scroller) return { found: false };
        const before = scroller.scrollTop;
        const deltas = [];
        let last = performance.now();
        await new Promise((resolve) => {
            let frame = 0;
            const tick = () => {
                const now = performance.now();
                deltas.push(now - last);
                last = now;
                scroller.scrollTop += 160;
                frame += 1;
                if (frame < 60) requestAnimationFrame(tick);
                else resolve();
            };
            requestAnimationFrame(tick);
        });
        deltas.sort((left, right) => left - right);
        const at = (share) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * share))];
        return {
            found: true,
            before,
            after: scroller.scrollTop,
            p50: at(0.5),
            p95: at(0.95),
            max: deltas[deltas.length - 1],
        };
    });
}

async function blankSamples(app, page, count = 20) {
    const box = await page.locator(".changes-main").boundingBox();
    if (!box) return { blank: count, counts: [] };
    const buffers = [];
    for (let index = 0; index < count; index += 1) {
        await page.evaluate(() => {
            const pane = document.querySelector(".changes-main");
            const scroller = [pane, ...pane.querySelectorAll("*")]
                .flatMap((node) => [node, node.shadowRoot])
                .filter((node) => node !== null && node !== undefined)
                .find((node) => node.scrollHeight > node.clientHeight + 100);
            if (scroller) scroller.scrollTop += 900;
        });
        await page.waitForTimeout(35);
        buffers.push((await page.screenshot({ clip: box })).toString("base64"));
    }
    const counts = await app.evaluate(({ nativeImage }, list) => list.map((encoded) => {
        const image = nativeImage.createFromBuffer(Buffer.from(encoded, "base64"));
        const bitmap = image.toBitmap();
        const colors = new Set();
        for (let index = 0; index < bitmap.length; index += 4 * 31) {
            colors.add(`${bitmap[index]},${bitmap[index + 1]},${bitmap[index + 2]}`);
        }
        return colors.size;
    }), buffers);
    return { blank: counts.filter((unique) => unique < 8).length, counts };
}

const results = [];
function check(name, ok, detail = "") {
    results.push(`${ok ? "pass" : "FAIL"} ${name}${detail === "" ? "" : `  ${detail}`}`);
    console.log(results.at(-1));
}

async function runTrial({ repo, label, large }) {
    const trial = startTrial();
    const violations = [];
    let app;
    let page;
    try {
        configureFauxHome(trial.home, provider.address().port);
        app = await trial.launch({ args: COUNT_PROCESSES });
        page = await app.firstWindow();
        page.on("console", (message) => {
            if (/Trusted Type|TrustedHTML|Content Security Policy|Refused to|requires 'trusted-types'/i.test(message.text())) {
                violations.push(message.text());
            }
        });
        page.on("pageerror", (error) => violations.push(`pageerror ${error.message}`));
        await resize(app, page, 1500, 1000);
        await page.waitForSelector('.app[data-sessions="0"]', { timeout: 45_000 });
        await trial.waitForHost();
        const launch = await processes(app);
        check(`${label}: no Vera Git process at launch`, launch.started === 0 && launch.running === 0, JSON.stringify(launch));
        await openFolder(app, page, repo, label);
        await attach(page, label);

        const started = performance.now();
        await openChanges(page);
        await page.locator(".changes-file-header").first().waitFor({ timeout: 90_000 });
        const headerMs = performance.now() - started;
        await page.waitForFunction(() => [...document.querySelectorAll(".changes-diffs diffs-container")]
            .some((container) => container.shadowRoot?.querySelector("[data-line]") !== null), undefined, { timeout: 90_000 });
            check(`${label}: first file header rendered`, headerMs < 90_000, `${Math.round(headerMs)} ms`);
        const lineMs = performance.now() - started;
        check(`${label}: first diff line rendered`, lineMs < 90_000, `${Math.round(lineMs)} ms`);
        let counts = await idle(app, `${label}: git idle after opening`, 2);
        check(`${label}: reads start processes on demand`, counts.started >= 2 && counts.running === 0, JSON.stringify({ started: counts.started, running: counts.running }));
        check(`${label}: one Vera Git process at a time`, counts.max === 1, `max ${counts.max}`);
        await setTheme(app, page, "dark");

        if (!large) {
            const totals = (await page.locator(".changes-scope-counts").first().innerText()).replace(/\s+/g, " ");
            const added = Number(/\+\s*([\d,]+)/.exec(totals)?.[1]?.replaceAll(",", "") ?? "0");
            const removed = Number(/−\s*([\d,]+)/.exec(totals)?.[1]?.replaceAll(",", "") ?? "0");
            check(`${label}: branch pill counts the whole diff`, added >= 100 && removed >= 100, totals);
            const destination = await page.locator(".changes-destination-pill").innerText();
            check(`${label}: branch pill names branch and destination`, destination.includes("feature") && destination.includes("main"), destination.replace(/\s+/g, " "));

            await waitForTree(page, "file-00.ts");
            const treeText = await shadowTree(page);
            check(`${label}: tree has the Changed files root`, treeText.includes("Changed files"), treeText.split("\n").slice(0, 3).join(" | "));
            check(`${label}: tree lists changed files`, treeText.includes("file-00.ts"));

            await page.getByRole("button", { name: "Search files" }).click();
            await page.waitForTimeout(400);
            const search = await searchTree(page);
            check(`${label}: Search files opens the tree filter`, search.found && search.placeholder === "Filter files...", JSON.stringify(search));

            await page.locator(".changes-destination-pill").click();
            const picker = page.locator('[role="listbox"][aria-label="Destination branch"]');
            await picker.waitFor({ timeout: 5_000 });
            const placeholder = await picker.locator("input").getAttribute("placeholder");
            const menu = await picker.innerText();
            const heading = await picker.locator(".changes-branch-heading").innerText();
            const selected = await picker.locator('[role="option"][aria-selected="true"]').innerText();
            check(`${label}: destination picker searches and checks the branch`, placeholder === "Search destination branches" && heading.trim().toLowerCase() === "branches" && selected.includes("main"), `${placeholder} | ${menu.replace(/\s+/g, " ")}`);
            await shootDestination(app, page, "dark", 1500);
            await shootDestination(app, page, "light", 1500);
            await shootDestination(app, page, "light", 1150);
            await shootDestination(app, page, "dark", 1150);
            await resize(app, page, 1500);
            await setTheme(app, page, "dark");
            const beforeDestination = (await processes(app)).started;
            await page.locator(".changes-destination-pill").click();
            await page.locator('[role="option"]', { hasText: "release" }).click();
            await page.waitForFunction(() => document.querySelector(".changes-destination-pill")?.textContent?.includes("release"));
            counts = await idle(app, `${label}: git idle after a destination change`, beforeDestination + 2);
            check(`${label}: a destination change rereads the diff`, counts.started >= beforeDestination + 2, `${beforeDestination} -> ${counts.started}`);
            await page.locator(".changes-destination-pill").click();
            await page.locator('[role="option"]', { hasText: "main" }).click();
            await page.waitForFunction(() => document.querySelector(".changes-destination-pill")?.textContent?.includes("main"));
            await idle(app, `${label}: git idle after main is back`);

            const beforeRefresh = (await processes(app)).started;
            await page.getByRole("button", { name: "Refresh changes" }).click();
            counts = await idle(app, `${label}: git idle after Refresh`, beforeRefresh + 2);
            check(`${label}: Refresh rereads the diff`, counts.started >= beforeRefresh + 2, `${beforeRefresh} -> ${counts.started}`);

            const beforeScope = (await processes(app)).started;
            await page.locator(".changes-scope .right-seg-option").nth(1).click();
            await page.waitForFunction(() => document.querySelector(".changes-destination-static")?.textContent?.includes("working tree"));
            counts = await idle(app, `${label}: git idle after the uncommitted scope`, beforeScope + 2);
            check(`${label}: uncommitted scope has no picker`, await page.locator(".changes-destination-pill").count() === 0);
            await waitForTree(page, "new.txt");
            await page.waitForTimeout(400);
            const uncommitted = await shadowTree(page);
            const stagedRow = await treeRowBoxes(page, "staged.txt");
            console.log(`${label}: uncommitted staged row`, JSON.stringify(stagedRow));
            check(`${label}: uncommitted scope lists the untracked file`, uncommitted.includes("new.txt"), uncommitted.split("\n").slice(-4).join(" | "));
            const uncommittedRoot = await treeRootRow(page);
            check(`${label}: uncommitted scope keeps the Changed files root on its own row`,
                uncommittedRoot.rootText === "Changed files" && uncommittedRoot.rootTop !== null
                && uncommittedRoot.firstTop !== null && uncommittedRoot.rootTop < uncommittedRoot.firstTop
                && !uncommittedRoot.firstText.includes("Changed"),
                JSON.stringify(uncommittedRoot));
            check(`${label}: an added file shows whole counts or none`,
                stagedRow !== undefined && (stagedRow.countsState === "absent"
                    || (stagedRow.countsState === "whole" && stagedRow.decorationText === "+1"
                        && stagedRow.countsWidth.lane - stagedRow.countsWidth.content >= 4)),
                JSON.stringify(stagedRow));
            check(`${label}: uncommitted scope rereads the diff`, counts.started >= beforeScope + 2, `${beforeScope} -> ${counts.started}`);
            await page.locator(".changes-scope .right-seg-option").nth(0).click();
            await page.waitForFunction(() => document.querySelector(".changes-destination-pill") !== null);
            await idle(app, `${label}: git idle after the branch scope`);
            await waitForTree(page, "file-00.ts");
            await waitForDiff(page);

            const header1500 = await headerBoxes(page, 1500);
            check(`${label}: header pieces stay inside their boxes at 1500`,
                header1500.countsInsideActive && header1500.activeInsideScope && header1500.scopeInsideToolbar
                && header1500.startInsideToolbar && header1500.actionsInsideToolbar && header1500.overflow <= 1,
                JSON.stringify(header1500));
            const indent = await treeIndent(page);
            const defaultLayout = await treeLayout(page);
            const defaultHeader = await fileHeaderPath(page, "src/group-0/file-00.ts");
            const defaultRow = await treeRowBoxes(page, "file-00.ts");
            const defaultEleven = await treeRowBoxes(page, "file-11.ts");
            const defaultGone = await treeRowBoxes(page, "gone.txt");
            const defaultCountsWhole = defaultRow?.countsState === "whole" && defaultRow.decorationText === "+2 −2";
            const defaultCountsAbsent = defaultRow?.countsState === "absent" && defaultRow.decorationText === "";
            const elevenCountsFit = defaultEleven !== undefined && (defaultEleven.countsState === "absent"
                || (defaultEleven.countsState === "whole"
                    && defaultEleven.countsWidth.lane - defaultEleven.countsWidth.content >= 4));
            const defaultGoneFit = defaultGone !== undefined && (defaultGone.countsState === "absent"
                || (defaultGone.countsState === "whole" && defaultGone.decorationText === "−1"
                    && defaultGone.countsWidth.lane - defaultGone.countsWidth.content >= 4));
            console.log(`${label}: tree indent`, JSON.stringify(indent));
            console.log(`${label}: file header path`, JSON.stringify(defaultHeader));
            console.log(`${label}: default tree`, JSON.stringify({ layout: defaultLayout, row: defaultRow, eleven: defaultEleven, gone: defaultGone }));
            check(`${label}: the file name stays whole before the folder truncates`,
                defaultHeader.name !== null && defaultHeader.name.text === "file-00.ts" && !defaultHeader.name.clipped,
                JSON.stringify(defaultHeader));
            check(`${label}: file-11.ts shows counts only with a spacing token to spare`,
                defaultEleven !== undefined && defaultEleven.name === "file-11.ts" && !defaultEleven.nameClipped
                && elevenCountsFit && defaultEleven.gitText === "M" && !defaultEleven.gitClipped
                && defaultEleven.noOverlap && defaultEleven.insideRow,
                JSON.stringify(defaultEleven));
            check(`${label}: gone.txt shows whole counts or none at the default width`,
                defaultGone !== undefined && defaultGone.name === "gone.txt" && !defaultGone.nameClipped
                && defaultGoneFit && defaultGone.gitText === "D" && !defaultGone.gitClipped
                && defaultGone.noOverlap && defaultGone.insideRow,
                JSON.stringify(defaultGone));
            check(`${label}: the default tree takes 40% of the split`,
                defaultLayout.treeShare !== null && Math.abs(defaultLayout.treeShare - 0.4) <= 0.01,
                JSON.stringify(defaultLayout));
            check(`${label}: the default tree keeps the full name and status, counts whole or absent`,
                defaultRow !== undefined && defaultRow.name === "file-00.ts" && !defaultRow.nameClipped
                && (defaultCountsWhole || defaultCountsAbsent)
                && defaultRow.gitText === "M" && !defaultRow.gitClipped
                && defaultRow.noOverlap && defaultRow.insideRow,
                JSON.stringify(defaultRow));

            const renameHeader = await fileHeaderDetail(page, "renamed/name.ts");
            const rowHeader = await fileHeaderDetail(page, "src/group-0/file-00.ts");
            const rootRow = await treeRootRow(page);
            const treeOrderNow = await treeFilePaths(page);
            const diffOrderNow = await page.evaluate(() => [...document.querySelectorAll(".changes-file-path")].map((node) => node.title));
            console.log(`${label}: special headers`, JSON.stringify({ rename: renameHeader, row: rowHeader }));
            console.log(`${label}: tree row`, JSON.stringify({ root: rootRow, order: treeOrderNow.slice(0, diffOrderNow.length), diffOrder: diffOrderNow }));
            check(`${label}: a renamed header has one slash per folder`,
                renameHeader !== undefined && renameHeader.pathText === "old/name.ts→renamed/name.ts"
                && !renameHeader.pathText.includes("//") && renameHeader.folders.join("") === "old/renamed/"
                && renameHeader.names.join(",") === "name.ts,name.ts" && !renameHeader.nameClipped
                && !renameHeader.overlapActions,
                JSON.stringify(renameHeader));
            check(`${label}: the diff starts in the tree's order`,
                diffOrderNow.length > 0 && diffOrderNow.every((path, index) => path === treeOrderNow[index]),
                JSON.stringify({ tree: treeOrderNow.slice(0, diffOrderNow.length), diff: diffOrderNow }));
            check(`${label}: the Changed files root is its own row`,
                rootRow.rootText === "Changed files" && rootRow.rootTop !== null && rootRow.firstTop !== null
                && rootRow.rootTop < rootRow.firstTop && !rootRow.firstText.includes("Changed"),
                JSON.stringify(rootRow));

            await page.getByRole("button", { name: "Collapse all files" }).click();
            await page.waitForTimeout(800);
            const collapsedFirst = await page.evaluate(() => {
                const header = document.querySelector(".changes-file-header");
                return { top: header?.getBoundingClientRect().top ?? null };
            });
            const collapsedMain = (await page.locator(".changes-main").boundingBox()).y;
            check(`${label}: Collapse all leaves no gap above the first file`,
                collapsedFirst.top !== null && collapsedFirst.top - collapsedMain < 40,
                JSON.stringify({ first: collapsedFirst.top, main: collapsedMain }));
            await page.getByRole("button", { name: "Expand all files" }).click();
            await waitForDiff(page);

            await scrollTop(page);
            await page.getByRole("button", { name: "Search files" }).click();
            const treeFilter = page.locator('.changes-tree input[placeholder="Filter files..."]');
            await treeFilter.fill("logo.bin");
            await waitForTree(page, "logo.bin");
            await page.waitForTimeout(400);
            const binaryRow = await treeRowBoxes(page, "logo.bin");
            check(`${label}: a binary tree row says Binary with no counts`,
                binaryRow !== undefined && binaryRow.decorationText === "Binary" && !/[+−]\d/.test(binaryRow.decorationText)
                && binaryRow.name === "logo.bin" && !binaryRow.nameClipped && binaryRow.noOverlap,
                JSON.stringify(binaryRow));
            if (binaryRow !== undefined) {
                await page.mouse.click((binaryRow.row.left + binaryRow.row.right) / 2, (binaryRow.row.top + binaryRow.row.bottom) / 2);
            }
            await until("the picked binary header", async () => (await fileHeaderDetail(page, "logo.bin")) !== undefined, 10_000);
            const binaryHeader = await fileHeaderDetail(page, "logo.bin");
            const selectedLogo = await treeSelectedPaths(page);
            check(`${label}: a binary header says only the note`,
                binaryHeader !== undefined && binaryHeader.noteText === "Binary file, not shown."
                && binaryHeader.binarySpan === false && binaryHeader.countsText === ""
                && binaryHeader.names.includes("logo.bin") && !binaryHeader.nameClipped
                && !binaryHeader.overlapActions,
                JSON.stringify(binaryHeader));
            check(`${label}: picking the last file shows it and keeps its mark`,
                binaryHeader !== undefined && binaryHeader.headerBox.top >= 100 && binaryHeader.headerBox.top < 960
                && selectedLogo.includes("logo.bin"),
                JSON.stringify({ header: binaryHeader?.headerBox, selected: selectedLogo }));
            const manualBefore = await scrollPosition(page);
            const manualSet = await page.evaluate(() => {
                const pane = document.querySelector(".changes-main");
                if (pane === null) return null;
                const scroller = [pane, ...pane.querySelectorAll("*")]
                    .flatMap((node) => [node, node.shadowRoot])
                    .filter((node) => node !== null && node !== undefined)
                    .find((node) => node.scrollHeight > node.clientHeight + 100);
                if (scroller === undefined) return null;
                scroller.scrollTop = Math.max(0, scroller.scrollTop - 100);
                return scroller.scrollTop;
            });
            await page.waitForTimeout(600);
            const heldLogo = await treeSelectedPaths(page);
            check(`${label}: a picked file stays marked while it is in view`,
                manualSet !== null && manualBefore !== null && Math.abs(manualSet - manualBefore) >= 50
                && heldLogo.includes("logo.bin"),
                JSON.stringify({ before: manualBefore, set: manualSet, selected: heldLogo }));
            await treeFilter.fill("");
            await page.keyboard.press("Escape");
            await scrollTop(page);
            await page.evaluate(() => {
                const pane = document.querySelector(".changes-main");
                if (pane === null) return;
                const scroller = [pane, ...pane.querySelectorAll("*")]
                    .flatMap((node) => [node, node.shadowRoot])
                    .filter((node) => node !== null && node !== undefined)
                    .find((node) => node.scrollHeight > node.clientHeight + 100);
                if (scroller !== undefined) scroller.scrollTop = 900;
            });
            await page.waitForTimeout(700);
            const movedLogo = await treeSelectedPaths(page);
            check(`${label}: scrolling by hand moves the mark`, !movedLogo.includes("logo.bin") && movedLogo.length > 0,
                JSON.stringify({ selected: movedLogo, scrollTop: await scrollPosition(page) }));
            await page.getByRole("button", { name: "Search files" }).click();
            await page.waitForTimeout(300);

            const bigFilter = page.locator('.changes-tree input[placeholder="Filter files..."]');
            await bigFilter.fill("big.ts");
            await page.waitForTimeout(400);
            const bigRow = await treeRowBoxes(page, "big.ts");
            if (bigRow !== undefined) await page.mouse.click((bigRow.row.left + bigRow.row.right) / 2, (bigRow.row.top + bigRow.row.bottom) / 2);
            await until("the picked long header", async () => (await fileHeaderDetail(page, "big.ts")) !== undefined, 10_000);
            const bigHeader = await fileHeaderDetail(page, "big.ts");
            check(`${label}: a long note keeps the whole file name and clears the actions`,
                bigHeader !== undefined && bigHeader.names.includes("big.ts") && !bigHeader.nameClipped
                && bigHeader.noteText === "First 400 lines" && !bigHeader.overlapActions,
                JSON.stringify(bigHeader));
            check(`${label}: header counts keep a spacing token between them`,
                rowHeader !== undefined && rowHeader.tallyGap !== null && rowHeader.tallyGap >= 4
                && bigHeader !== undefined && bigHeader.tallyGap !== null && bigHeader.tallyGap >= 4,
                JSON.stringify({ row: rowHeader?.tallyGap, big: bigHeader?.tallyGap }));
            await bigFilter.fill("");
            await page.keyboard.press("Escape");
            await page.waitForTimeout(400);

            const paneSash = await page.locator('[data-sash="rightPane"]').boundingBox();
            await page.mouse.move(paneSash.x + paneSash.width / 2, paneSash.y + paneSash.height / 2);
            await page.mouse.down();
            await page.mouse.move(paneSash.x + paneSash.width / 2 - 220, paneSash.y + paneSash.height / 2, { steps: 6 });
            await page.mouse.up();
            await page.waitForTimeout(500);
            const wideLayout = await treeLayout(page);
            const wideRow = await treeRowBoxes(page, "file-00.ts");
            const wideEleven = await treeRowBoxes(page, "file-11.ts");
            const wideGone = await treeRowBoxes(page, "gone.txt");
            console.log(`${label}: widened tree`, JSON.stringify({ layout: wideLayout, row: wideRow, eleven: wideEleven, gone: wideGone }));
            check(`${label}: a wider pane gives the tree 230 px and the diff at least 320 px`,
                wideLayout.tree !== null && Math.abs(wideLayout.tree.width - 230) <= 1
                && wideLayout.main !== null && wideLayout.main.width >= 320,
                JSON.stringify(wideLayout));
            check(`${label}: the 230 px tree shows file-00.ts, +2 −2 and M whole`,
                wideRow !== undefined && wideRow.name === "file-00.ts" && !wideRow.nameClipped
                && wideRow.countsState === "whole" && wideRow.decorationText === "+2 −2"
                && wideRow.gitText === "M" && !wideRow.gitClipped
                && wideRow.noOverlap && wideRow.insideRow,
                JSON.stringify(wideRow));
            check(`${label}: the 230 px tree shows file-11.ts, +2 −2 and M whole`,
                wideEleven !== undefined && wideEleven.name === "file-11.ts" && !wideEleven.nameClipped
                && wideEleven.countsState === "whole" && wideEleven.decorationText === "+2 −2"
                && wideEleven.gitText === "M" && !wideEleven.gitClipped
                && wideEleven.noOverlap && wideEleven.insideRow,
                JSON.stringify(wideEleven));
            check(`${label}: the 230 px tree shows gone.txt, −1 and D whole`,
                wideGone !== undefined && wideGone.name === "gone.txt" && !wideGone.nameClipped
                && wideGone.countsState === "whole" && wideGone.decorationText === "−1"
                && wideGone.gitText === "D" && !wideGone.gitClipped
                && wideGone.noOverlap && wideGone.insideRow,
                JSON.stringify(wideGone));
            await setTheme(app, page, "dark");
            await page.screenshot({ path: join(shots, "tree-wide-dark-1500.png") });
            await setTheme(app, page, "light");
            await page.screenshot({ path: join(shots, "tree-wide-light-1500.png") });

            let treeSash = await page.locator('[data-sash="Changed files tree"]').boundingBox();
            await page.mouse.move(treeSash.x + treeSash.width / 2, treeSash.y + treeSash.height / 2);
            await page.mouse.down();
            await page.mouse.move(treeSash.x + treeSash.width / 2 + 80, treeSash.y + treeSash.height / 2, { steps: 5 });
            await page.mouse.up();
            await page.waitForTimeout(500);
            const minLayout = await treeLayout(page);
            const minRow = await treeRowBoxes(page, "file-00.ts");
            const minGone = await treeRowBoxes(page, "gone.txt");
            console.log(`${label}: minimum tree`, JSON.stringify({ layout: minLayout, row: minRow, gone: minGone }));
            check(`${label}: the tree reaches its minimum width`,
                minLayout.tree !== null && Math.abs(minLayout.tree.width - 160) <= 1,
                JSON.stringify(minLayout));
            check(`${label}: a narrow tree never half-draws file-00.ts counts and keeps the status letter`,
                minRow !== undefined && (minRow.countsState === "whole" || minRow.countsState === "absent")
                && !minRow.decorationClipped
                && minRow.gitText === "M" && !minRow.gitClipped && minRow.git.width > 0
                && minRow.noOverlap && minRow.insideRow,
                JSON.stringify(minRow));
            check(`${label}: a narrow tree never half-draws gone.txt counts and keeps the status letter`,
                minGone !== undefined && (minGone.countsState === "whole" || minGone.countsState === "absent")
                && !minGone.decorationClipped
                && minGone.gitText === "D" && !minGone.gitClipped && minGone.git.width > 0
                && minGone.noOverlap && minGone.insideRow,
                JSON.stringify(minGone));

            // The sash moved when the tree narrowed, so read its box again for the reset.
            treeSash = await page.locator('[data-sash="Changed files tree"]').boundingBox();
            await page.mouse.dblclick(treeSash.x + treeSash.width / 2, treeSash.y + treeSash.height / 2);
            await page.waitForTimeout(500);
            const resetLayout = await treeLayout(page);
            console.log(`${label}: reset tree`, JSON.stringify(resetLayout));
            check(`${label}: the double-click returns the tree to its default width`,
                resetLayout.tree !== null && Math.abs(resetLayout.tree.width - 230) <= 1,
                JSON.stringify(resetLayout));

            // Double-click restores the pane to its opening size. The tree follows to 40%.
            const widePaneSash = await page.locator('[data-sash="rightPane"]').boundingBox();
            await page.mouse.dblclick(widePaneSash.x + widePaneSash.width / 2, widePaneSash.y + widePaneSash.height / 2);
            await page.waitForTimeout(500);
            const backLayout = await treeLayout(page);
            console.log(`${label}: default pane restored`, JSON.stringify(backLayout));
            check(`${label}: the pane returns to its opening width and the tree to 40%`,
                backLayout.treeShare !== null && Math.abs(backLayout.treeShare - 0.4) <= 0.01,
                JSON.stringify(backLayout));

            await setTheme(app, page, "dark");
            await page.screenshot({ path: join(shots, "changes-dark-1500.png") });
            await setTheme(app, page, "light");
            await page.screenshot({ path: join(shots, "changes-light-1500.png") });
            await resize(app, page, 1150, 1000);
            const header1150 = await headerBoxes(page, 1150);
            check(`${label}: header pieces stay inside their boxes at 1150`,
                header1150.countsInsideActive && header1150.activeInsideScope && header1150.scopeInsideToolbar
                && header1150.startInsideToolbar && header1150.actionsInsideToolbar && header1150.overflow <= 1,
                JSON.stringify(header1150));
            await page.screenshot({ path: join(shots, "changes-light-1150.png") });
            await setTheme(app, page, "dark");
            await page.screenshot({ path: join(shots, "changes-dark-1150.png") });
            await page.locator(".changes-tree").screenshot({ path: join(shots, "tree-dark-1150.png") });
            await resize(app, page, 1500);
            await page.locator(".changes-tree").screenshot({ path: join(shots, "tree-dark-1500.png") });
            await setTheme(app, page, "light");
            await page.locator(".changes-tree").screenshot({ path: join(shots, "tree-light-1500.png") });
            await resize(app, page, 1150);
            await page.locator(".changes-tree").screenshot({ path: join(shots, "tree-light-1150.png") });

            const frames = await scrollStats(page);
            check(`${label}: the diff scrolls`, frames.found === true && frames.after > frames.before, JSON.stringify(frames));
            const blanks = await blankSamples(app, page);
            check(`${label}: no blank samples in a fast scroll`, blanks.blank === 0, `${blanks.blank} of ${blanks.counts.length}; colors ${JSON.stringify(blanks.counts)}`);
            await setTheme(app, page, "dark");
            await scrollTop(page);

            const separator = await separatorCandidate(page);
            check(`${label}: a file shows unmodified-line separators`, separator !== undefined, JSON.stringify(separator));
            if (separator !== undefined) {
                const beforeLines = await lineCount(page);
                const beforeTexts = (await processes(app)).started;
                await page.evaluate(() => globalThis.__veraSeparator.click());
                await page.waitForTimeout(800);
                await idle(app, `${label}: git idle after expanding a separator`, beforeTexts + 1);
                const afterLines = await lineCount(page);
                check(`${label}: an expanded separator reads both texts`, afterLines > beforeLines, `${beforeLines} -> ${afterLines} lines, ${beforeTexts} -> ${(await processes(app)).started} requests`);
                for (const [theme, width] of [["dark", 1500], ["light", 1500], ["light", 1150], ["dark", 1150]]) {
                    await resize(app, page, width);
                    await setTheme(app, page, theme);
                    await page.screenshot({ path: join(shots, `separator-${theme}-${width}.png`) });
                }
            }

            await scrollTop(page);
            const beforeComment = await page.locator(".diff-comment-chip").count();
            const line = await findLine(page, "Port Royal", "change-addition");
            check(`${label}: a changed line is rendered`, line !== undefined, JSON.stringify(line));
            if (line !== undefined) {
                await page.mouse.move(line.x + 40, line.y + line.height / 2);
                await page.mouse.move(line.x + 60, line.y + line.height / 2, { steps: 3 });
                const gutter = await page.evaluate((lineY) => {
                    for (const container of document.querySelectorAll(".changes-diffs diffs-container")) {
                        for (const number of container.shadowRoot?.querySelectorAll("[data-column-number]") ?? []) {
                            const rect = number.getBoundingClientRect();
                            if (Math.abs(rect.y + rect.height / 2 - lineY) < 24) return { x: rect.right - 4, y: rect.y + rect.height / 2 };
                        }
                    }
                    return undefined;
                }, line.y + line.height / 2);
                if (gutter !== undefined) await page.mouse.move(gutter.x, gutter.y, { steps: 5 });
                await page.waitForTimeout(300);
                const hovered = await page.evaluate(() => {
                    const found = [];
                    for (const container of document.querySelectorAll(".changes-diffs diffs-container")) {
                        const shadow = container.shadowRoot;
                        const lineNode = shadow?.querySelector("[data-line][data-hovered]");
                        const slots = shadow?.querySelectorAll("[data-gutter-utility-slot]") ?? [];
                        const buttons = shadow?.querySelectorAll("[data-utility-button]") ?? [];
                        if (lineNode || slots.length > 0 || buttons.length > 0) found.push({
                            line: lineNode?.textContent?.slice(0, 30),
                            slots: [...slots].map((node) => node.getBoundingClientRect().toJSON()),
                            buttons: [...buttons].map((node) => node.getBoundingClientRect().toJSON()),
                        });
                    }
                    return found;
                });
                console.log(`${label}: hover`, JSON.stringify(hovered));
                let plus = await plusButton(page);
                if (plus === undefined) {
                    await hoverLine(page, { x: line.x, y: line.y });
                    await page.waitForTimeout(300);
                    plus = await plusButton(page);
                }
                check(`${label}: the gutter plus shows on hover`, plus !== undefined);
                if (plus !== undefined) {
                    await page.mouse.click(plus.x, plus.y);
                    const box = await visibleCommentBox(page);
                    await box.locator("textarea").fill("Port Royal only for rich crows");
                    await box.getByRole("button", { name: "Comment", exact: true }).click();
                    await page.waitForTimeout(400);
                    check(`${label}: a line comment reaches the composer`, await page.locator(".diff-comment-chip").count() === beforeComment + 1, `${await page.locator(".diff-comment-chip").count()} chips`);
                }
            }
            const fileComment = page.locator('button[aria-label="Comment on src/group-0/file-00.ts"]').first();
            await fileComment.scrollIntoViewIfNeeded();
            await fileComment.dispatchEvent("click");
            await page.waitForTimeout(600);
            const boxes = await page.evaluate(() => [...document.querySelectorAll(".diff-comment-box")].map((box) => ({
                readonly: box.classList.contains("diff-comment-readonly"),
                visible: box.getClientRects().length > 0,
                text: (box.textContent ?? "").slice(0, 50),
            })));
            console.log(`${label}: comment boxes after the file button`, JSON.stringify(boxes));
            const fileBox = await visibleCommentBox(page);
            await fileBox.locator("textarea").fill("This file needs a second look.");
            await fileBox.getByRole("button", { name: "Comment", exact: true }).click();
            await page.waitForTimeout(400);
            const chips = await page.locator(".diff-comment-chip").allInnerTexts();
            check(`${label}: a file comment reaches the composer`, chips.length === beforeComment + 2, JSON.stringify(chips));
            check(`${label}: the file comment chip names the path only`, chips.some((text) => text.includes(".ts") && !/line/i.test(text)), JSON.stringify(chips));
            for (const [theme, width] of [["dark", 1500], ["light", 1500], ["light", 1150], ["dark", 1150]]) {
                await resize(app, page, width);
                await setTheme(app, page, theme);
                await page.screenshot({ path: join(shots, `comments-${theme}-${width}.png`) });
            }

            check(`${label}: no Trusted Types violations in the Changes pane`, violations.length === 0, JSON.stringify(violations.slice(0, 5)));
            const times = (await processes(app)).times;
            const sorted = [...times].sort((left, right) => left - right);
            console.log(`${label}: Vera Git lifetimes (ms)`, JSON.stringify({ count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }));
        } else {
            const banner = await page.locator(".changes-one-file-note").innerText();
            check(`${label}: one-file mode banner`, banner === "This diff is large, showing one file at a time", banner);
            check(`${label}: one-file mode shows one file`, await page.locator(".changes-file-header").count() === 1, `${await page.locator(".changes-file-header").count()} headers`);
            const firstName = await page.locator(".changes-file-header").first().innerText();
            const countBefore = await page.locator(".changes-one-file-count").innerText();
            const buttonHtml = await page.evaluate(() => {
                const button = document.querySelector('button[aria-label="Next file"]');
                if (button === null) return "missing";
                const detail = `${button.outerHTML.slice(0, 120)} disabled=${button.disabled} rects=${button.getClientRects().length}`;
                button.click();
                return detail;
            });
            await page.waitForTimeout(200);
            const count200 = await page.locator(".changes-one-file-count").innerText();
            await page.waitForTimeout(600);
            const countAfter = await page.locator(".changes-one-file-count").innerText();
            const nextName = await page.locator(".changes-file-header").first().innerText();
            console.log(`${label}: one-file count`, countBefore, "->", count200, "->", countAfter, buttonHtml);
            check(`${label}: one-file mode moves to the next file`, countAfter !== countBefore && nextName !== firstName && nextName.length > 0, `${countBefore} -> ${countAfter}; ${firstName.replace(/\s+/g, " ")} -> ${nextName.replace(/\s+/g, " ")}`);
            if (!(await page.getByRole("button", { name: "Previous file" }).isDisabled())) {
                await page.getByRole("button", { name: "Previous file" }).dispatchEvent("click");
                await page.waitForTimeout(600);
            }
            check(`${label}: one-file mode starts at the tree's first file`, firstName.includes("module-000.ts"), firstName.replace(/\s+/g, " "));
            const treeText = await shadowTree(page);
            check(`${label}: one-file mode tree lists the nearest files`, treeText.includes("module-000.ts"), treeText.replace(/\s+/g, " ").slice(0, 200));
            await page.getByRole("button", { name: "Search files" }).click();
            const treeFilter = page.locator('.changes-tree input[placeholder="Filter files..."]');
            await treeFilter.fill("aaa.ts");
            await page.waitForTimeout(400);
            const aaaRow = await treeRowBoxes(page, "aaa.ts");
            if (aaaRow !== undefined) await page.mouse.click((aaaRow.row.left + aaaRow.row.right) / 2, (aaaRow.row.top + aaaRow.row.bottom) / 2);
            await page.waitForTimeout(800);
            const lastOne = await page.locator(".changes-file-path").first().getAttribute("title");
            check(`${label}: one-file mode picks the last file in tree order`, lastOne === "aaa.ts", lastOne ?? "none");
            await page.getByRole("button", { name: "Previous file" }).dispatchEvent("click");
            await page.waitForTimeout(700);
            const previousOne = await page.locator(".changes-file-path").first().getAttribute("title");
            check(`${label}: Previous follows the tree's order`, previousOne === "packages/p9/module-499.ts", previousOne ?? "none");
            await page.getByRole("button", { name: "Next file" }).dispatchEvent("click");
            await page.waitForTimeout(700);
            const nextOne = await page.locator(".changes-file-path").first().getAttribute("title");
            check(`${label}: Next follows the tree's order`, nextOne === "aaa.ts", nextOne ?? "none");
            await treeFilter.fill("module-499");
            await waitForTree(page, "module-499.ts");
            const filteredTree = await shadowTree(page);
            check(`${label}: one-file mode tree filters to the last file`,
                treeText.includes("module-000.ts") && filteredTree.includes("module-499.ts") && !filteredTree.includes("module-000.ts"),
                filteredTree.replace(/\s+/g, " ").slice(0, 200));
            await treeFilter.fill("");
            await page.waitForTimeout(300);
            await setTheme(app, page, "dark");
            await page.screenshot({ path: join(shots, "one-file-dark-1500.png") });
            await setTheme(app, page, "light");
            await page.screenshot({ path: join(shots, "one-file-light-1500.png") });
            await resize(app, page, 1150, 1000);
            await page.screenshot({ path: join(shots, "one-file-light-1150.png") });
            await setTheme(app, page, "dark");
            await page.screenshot({ path: join(shots, "one-file-dark-1150.png") });
            check(`${label}: no Trusted Types violations in one-file mode`, violations.length === 0, JSON.stringify(violations.slice(0, 5)));
            const times = (await processes(app)).times;
            const sorted = [...times].sort((left, right) => left - right);
            console.log(`${label}: Vera Git lifetimes (ms)`, JSON.stringify({ count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }));
        }

        await resize(app, page, 1500, 1000);
        counts = await idle(app, `${label}: no Vera Git process left after the trial`);
        check(`${label}: no Vera Git process left after requests`, counts.running === 0 && counts.live === 0, JSON.stringify({ running: counts.running, live: counts.live }));
    } finally {
        await trial.cleanup();
    }
}

let failed = false;
try {
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const root = join(tmpdir(), `vera-changes-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    try {
        const only = process.env.VERA_CHANGES_ONLY;
        const sixty = only === "large" ? undefined : sixtyRepository(root);
        const fiveHundred = only === "sixty" ? undefined : fiveHundredRepository(root);
        if (sixty !== undefined) await runTrial({ repo: sixty, label: "sixty", large: false });
        if (fiveHundred !== undefined) await runTrial({ repo: fiveHundred, label: "fivehundred", large: true });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
    console.log(`Screenshots in ${shots}`);
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
}
process.exit(failed ? 1 : 0);

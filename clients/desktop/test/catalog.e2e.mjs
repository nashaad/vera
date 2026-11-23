// Extension catalog test for the desktop shell. Run with: node clients/desktop/test/catalog.e2e.mjs
// The app is built with the address of a local http server, which serves a catalog and the packages this file makes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { markDesktopExtensionStoreMigrated } from "./extension-fixtures.mjs";
import { startTrial } from "./trial.mjs";

const trial = startTrial();
const files = join(trial.trialRoot, "files");
const extensionsFolder = join(trial.home, "machine", "desktop", "extensions");
const CATALOG_SERVICE = "Vera Extension Catalog";
const NIGHT = "#101820";
const DAY = "#f0e8d8";
const PALETTE = ["#07080a", "#deddd7", "#e8582a", "#6fe3d4", "#ff5f56"];

function write(path, value) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
}

function savedTheme(slug, name, type, surface) {
    return { version: 1, slug, name, type, source: "Catalog", colors: { surface }, values: {}, tokenColors: [], semanticTokenColors: {} };
}

// A package is a gzip tar with its files at the archive root.
function makePackage(id, name, type, surface) {
    const slug = name.toLowerCase().replace(/ /g, "-");
    const folder = join(files, `${id}-src`);
    write(join(folder, "vera.desktop.json"), { id, version: "1.0.0", engine: "vera-gui@^1", contributes: { themes: [{ label: name, path: `themes/${slug}.json` }] } });
    write(join(folder, "themes", `${slug}.json`), savedTheme(slug, name, type, surface));
    const path = join(files, `${id}.tgz`);
    execFileSync("tar", ["--format", "ustar", "-czf", path, "-C", folder, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    return readFileSync(path);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const hits = [];
const routes = new Map();
const server = createServer((request, response) => {
    hits.push(request.url);
    const body = routes.get(request.url);
    if (body === undefined) {
        response.writeHead(404).end();
        return;
    }
    response.writeHead(200, { "content-length": body.length, "cache-control": "no-store" }).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const night = makePackage("crow.pack", "Crow Night", "dark", NIGHT);
const day = makePackage("crow.day", "Crow Day", "light", DAY);
const other = makePackage("crow.other", "Crow Other", "dark", "#202020");
function entry(id, name, bytes, extra = {}) {
    return { id, name, version: "1.0.0", kind: "theme", engine: "vera-gui@^1", url: `${origin}/${id}.tgz`, sha256: sha256(bytes), size: bytes.length, palette: PALETTE, withdrawn: false, ...extra };
}
routes.set("/crow.pack.tgz", night);
routes.set("/crow.day.tgz", day);
routes.set("/crow.bad.tgz", night);
routes.set("/catalog.json", Buffer.from(JSON.stringify({
    format: 1,
    extensions: [
        entry("crow.pack", "Crow Night", night),
        entry("crow.day", "Crow Day", day),
        // The package is right but the checksum is another package's.
        entry("crow.bad", "Crow Bad", night, { sha256: sha256(other) }),
        entry("crow.old", "Crow Old", night, { withdrawn: true }),
        entry("crow.next", "Crow Next", night, { engine: "vera-gui@^2" }),
    ],
})));

async function until(label, check, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

function expectEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

async function themeState(page) {
    return page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--vera-surface)";
        document.body.append(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { theme: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("vera.theme"), surface };
    });
}

// Counts the catalog processes started since the watch was installed, and the ones still running.
async function watchCatalogProcesses(app) {
    await app.evaluate(({ utilityProcess }, service) => {
        const fork = utilityProcess.fork.bind(utilityProcess);
        globalThis.catalogStarts = 0;
        utilityProcess.fork = (modulePath, args, options) => {
            if (options?.serviceName === service) globalThis.catalogStarts += 1;
            return fork(modulePath, args, options);
        };
    }, CATALOG_SERVICE);
}

function catalogProcesses(app) {
    return app.evaluate(({ app: electronApp }, service) => ({
        started: globalThis.catalogStarts,
        running: electronApp.getAppMetrics().filter((metric) => metric.name === service).length,
    }), CATALOG_SERVICE);
}

async function catalogProcessGone(app, started) {
    await until("the catalog process to stop", async () => {
        const processes = await catalogProcesses(app);
        return processes.started === started && processes.running === 0;
    });
}

function entries() {
    return existsSync(extensionsFolder) ? readdirSync(extensionsFolder).sort() : [];
}

const extensionFolders = () => entries().filter((name) => !name.startsWith(".staging-")).join(",");
const stagingFolders = () => entries().filter((name) => name.startsWith(".staging-")).length;

// Every file under the home that mentions the server, which the catalog and its packages would if they were kept.
function filesMentioning(folder, text) {
    const found = [];
    for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        const stat = statSync(path, { throwIfNoEntry: false });
        if (stat === undefined || stat.isSocket()) continue;
        if (stat.isDirectory()) found.push(...filesMentioning(path, text));
        else if (stat.size < 20_000_000 && readFileSync(path).includes(text)) found.push(path);
    }
    return found;
}

const seconds = (started) => (Date.now() - started) / 1000;

try {
    markDesktopExtensionStoreMigrated(trial.home);
    const appFolder = join(trial.trialRoot, "app");
    const bun = process.env.VERA_DESKTOP_BUN || "bun";
    const built = Date.now();
    execFileSync(bun, [join(trial.root, "clients", "desktop", "build.ts"), "--out", appFolder, "--catalog-url", `${origin}/catalog.json`], { stdio: "inherit" });
    console.log(`built the app in ${seconds(built).toFixed(1)} s`);

    const app = await trial.launch({ appDir: appFolder });
    const page = await app.firstWindow();
    await page.waitForSelector(".app[data-sessions]", { timeout: 45_000 });
    await trial.waitForHost();
    await watchCatalogProcesses(app);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expectEqual(hits.length, 0, "the requests made by launching");
    await catalogProcessGone(app, 0);

    // Plugins and its Yours view do not fetch the catalog.
    await page.locator("[data-page=\"customize\"]").first().click();
    await page.waitForSelector("main[data-page=\"customize\"]", { timeout: 10_000 });
    await page.locator(".plugins-kinds button[data-kind=\"extensions\"]").click();
    await page.locator(".plugins-add").waitFor({ timeout: 10_000 });
    expectEqual(hits.length, 0, "the requests made by opening Plugins");

    // Discover lists the catalog's themes: withdrawn entries and entries for another engine are left out.
    const opened = Date.now();
    await page.locator(".customize-seg button", { hasText: "Discover" }).click();
    await page.locator("[data-catalog-theme]").first().waitFor({ timeout: 15_000 });
    const listSeconds = seconds(opened);
    expectEqual(hits.join(","), "/catalog.json", "the requests made by opening Discover");
    const listed = await page.locator("[data-catalog-theme]").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-catalog-theme")));
    expectEqual(listed.join(","), "crow.pack,crow.day,crow.bad", "the themes listed");
    const card = await page.locator("[data-catalog-theme=\"crow.pack\"]").innerText();
    for (const text of ["Crow Night", "1.0.0"]) if (!card.includes(text)) throw new Error(`The card does not show "${text}": ${card}`);
    expectEqual(await page.locator("[data-catalog-theme=\"crow.pack\"] .catalog-swatch").count(), 5, "the swatches on a card");
    expectEqual(await page.locator("[data-catalog-installed]").count(), 0, "the themes marked Installed");
    await catalogProcessGone(app, 1);

    // Install previews the theme in the window; nothing is stored or installed yet.
    const before = await themeState(page);
    expectEqual(before.theme, "dark", "the theme before a preview");
    let clicked = Date.now();
    await page.locator("[data-catalog-install=\"crow.pack\"]").click();
    await page.locator("[data-catalog-bar=\"crow.pack\"]").waitFor({ timeout: 20_000 });
    const previewSeconds = seconds(clicked);
    const bar = await page.locator("[data-catalog-bar]").innerText();
    if (!bar.includes("Previewing Crow Night 1.0.0.")) throw new Error(`The bar does not name the theme: ${bar}`);
    await until("the previewed theme", async () => (await themeState(page)).theme === "imported:crow.pack.crow-night");
    const previewing = await themeState(page);
    expectEqual(previewing.surface, "rgb(16, 24, 32)", "the previewed surface");
    expectEqual(previewing.stored, before.stored, "the stored theme while previewing");
    expectEqual(extensionFolders(), "", "the installed extensions while previewing");
    expectEqual(stagingFolders(), 1, "the staging folders while previewing");
    expectEqual(hits.join(","), "/catalog.json,/crow.pack.tgz", "the requests after a preview");
    await catalogProcessGone(app, 2);

    // Escape puts the previous theme back and discards the download.
    await page.keyboard.press("Escape");
    await page.locator("[data-catalog-bar]").waitFor({ state: "detached", timeout: 5_000 });
    await until("the previous theme", async () => (await themeState(page)).theme === "dark");
    expectEqual((await themeState(page)).surface, before.surface, "the surface after Escape");
    expectEqual((await themeState(page)).stored, before.stored, "the stored theme after Escape");
    await until("the staging folder to be removed", () => stagingFolders() === 0);
    expectEqual(extensionFolders(), "", "the installed extensions after Escape");

    // Cancel does the same.
    await page.locator("[data-catalog-install=\"crow.day\"]").click();
    await page.locator("[data-catalog-bar=\"crow.day\"]").waitFor({ timeout: 20_000 });
    await until("the light preview", async () => (await themeState(page)).theme === "imported:crow.day.crow-day");
    await page.locator("[data-catalog-cancel]").click();
    await page.locator("[data-catalog-bar]").waitFor({ state: "detached", timeout: 5_000 });
    await until("the previous theme after Cancel", async () => (await themeState(page)).theme === "dark");
    await until("the staging folder after Cancel", () => stagingFolders() === 0);

    // Leaving Discover with a preview open puts the previous theme back too.
    await page.locator("[data-catalog-install=\"crow.day\"]").click();
    await page.locator("[data-catalog-bar=\"crow.day\"]").waitFor({ timeout: 20_000 });
    await page.locator(".customize-seg button", { hasText: "Yours" }).click();
    await until("the previous theme after leaving", async () => (await themeState(page)).theme === "dark");
    await until("the staging folder after leaving", () => stagingFolders() === 0);
    await page.locator(".customize-seg button", { hasText: "Discover" }).click();
    await page.locator("[data-catalog-theme]").first().waitFor({ timeout: 15_000 });
    expectEqual(hits.filter((url) => url === "/catalog.json").length, 2, "the catalog requests after reopening Discover");

    // Install from the bar commits the package and keeps the theme.
    await page.locator("[data-catalog-install=\"crow.pack\"]").click();
    await page.locator("[data-catalog-bar=\"crow.pack\"]").waitFor({ timeout: 20_000 });
    clicked = Date.now();
    await page.locator("[data-catalog-keep]").click();
    await page.locator("[data-catalog-theme=\"crow.pack\"] [data-catalog-installed]").waitFor({ timeout: 10_000 });
    const installSeconds = seconds(clicked);
    await page.locator("[data-catalog-bar]").waitFor({ state: "detached", timeout: 5_000 });
    const kept = await themeState(page);
    expectEqual(kept.theme, "imported:crow.pack.crow-night", "the theme after Install");
    expectEqual(kept.stored, "imported:crow.pack.crow-night", "the stored theme after Install");
    expectEqual(extensionFolders(), "crow.pack", "the installed extensions after Install");
    expectEqual(stagingFolders(), 0, "the staging folders after Install");
    expectEqual(await page.locator("[data-catalog-install=\"crow.pack\"]").count(), 0, "the Install buttons on an installed theme");
    await page.locator(".customize-seg button", { hasText: "Yours" }).click();
    await page.locator("[data-desktop-extension=\"crow.pack\"]").waitFor({ timeout: 10_000 });
    await page.locator(".customize-seg button", { hasText: "Discover" }).click();
    await page.locator("[data-catalog-theme=\"crow.pack\"] [data-catalog-installed]").waitFor({ timeout: 15_000 });

    // A package whose checksum is not the catalog's is refused before anything is unpacked.
    await page.locator("[data-catalog-install=\"crow.bad\"]").click();
    const refusal = await page.locator("[data-catalog-report]").innerText({ timeout: 20_000 });
    expectEqual(refusal, "The package does not match its expected checksum.", "the refusal");
    expectEqual(await page.locator("[data-catalog-bar]").count(), 0, "the bars after a refusal");
    expectEqual((await themeState(page)).theme, "imported:crow.pack.crow-night", "the theme after a refusal");
    expectEqual(extensionFolders(), "crow.pack", "the installed extensions after a refusal");
    expectEqual(stagingFolders(), 0, "the staging folders after a refusal");

    // Nothing of the catalog stays on disk or running.
    await page.locator(".customize-seg button", { hasText: "Yours" }).click();
    const kept_files = filesMentioning(trial.home, origin);
    expectEqual(kept_files.join(","), "", "the files under the home that mention the catalog server");
    const finalCount = hits.filter((url) => url === "/catalog.json").length;
    await until("the catalog process to stop", async () => {
        const processes = await catalogProcesses(app);
        return processes.running === 0;
    });
    const processes = await catalogProcesses(app);
    console.log(`catalog e2e passed: ${trial.home} (list ${listSeconds.toFixed(2)} s, preview ${previewSeconds.toFixed(2)} s, install ${installSeconds.toFixed(2)} s, ${processes.started} catalog processes, ${finalCount} catalog fetches)`);
} finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await trial.cleanup();
}

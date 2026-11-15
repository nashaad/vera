import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runCatalogTask } from "../../clients/desktop/src/extension-catalog/run-task.ts";
import {
    CATALOG_UNREACHABLE,
    DOWNLOAD_FAILED,
    parseCatalogReply,
    parseCatalogTask,
    type CatalogReply,
    type CatalogTask,
} from "../../clients/desktop/src/extension-catalog/task-protocol.ts";
import { runInstallTask } from "../../clients/desktop/src/extension-install/run-task.ts";
import { parseInstallReply, parseInstallTask } from "../../clients/desktop/src/extension-install/task-protocol.ts";
import { ExtensionCatalogService } from "../../clients/desktop/src/extensions/catalog-service.ts";
import { MAX_PACKAGE_BYTES } from "../../clients/desktop/src/extensions/limits.ts";
import { extensionsDirectory, extensionStatePath } from "../../clients/desktop/src/extensions/paths.ts";
import { ExtensionService } from "../../clients/desktop/src/extensions/service.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";
import { runThemeTask } from "../../clients/desktop/src/theme-import/run-task.ts";
import { ThemeService } from "../../clients/desktop/src/theme-service.ts";
import { themesDirectory } from "../../clients/desktop/src/theme-store.ts";
import { catalogBytes, PALETTE, rawEntry, serve, sha256Of } from "./extension-catalog-fixtures.ts";
import { tarGzBytes, themeFiles } from "./extension-fixtures.ts";
import { removeScratchDirectories, scratchDirectory } from "./theme-fixtures.ts";

const stops: (() => void)[] = [];
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    removeScratchDirectories();
});

function server(routes: Parameters<typeof serve>[0]): ReturnType<typeof serve> {
    const started = serve(routes);
    stops.push(started.stop);
    return started;
}

function crowPackage(id = "crow.pack", version = "1.0.0"): Buffer {
    return tarGzBytes(themeFiles(id, version, [{ label: "Crow Night", name: "Crow Night" }]));
}

// A task crosses a structured clone and a JSON round trip, as it does to a task process, and runs with no state.
async function runAsProcess(task: CatalogTask): Promise<CatalogReply> {
    const parsed = parseCatalogTask(JSON.parse(JSON.stringify(structuredClone(task))));
    if (parsed === undefined) throw new Error("The task did not read.");
    const reply = parseCatalogReply(JSON.parse(JSON.stringify(structuredClone(await runCatalogTask(parsed)))));
    if (reply === undefined) throw new Error("The reply did not read.");
    return reply;
}

test("@core tasks and replies survive a clone and JSON, and malformed ones are refused", () => {
    const list: CatalogTask = { kind: "list", url: "http://127.0.0.1:1/catalog.json", engine: "vera-gui@^1" };
    const download: CatalogTask = { kind: "download", url: "https://example.test/a.tgz", size: 10, destination: "/tmp/staging/package.tgz" };
    for (const task of [list, download]) expect(parseCatalogTask(JSON.parse(JSON.stringify(structuredClone(task))))).toEqual(task);
    const entry = { id: "crow.pack", name: "Crow Night", version: "1.0.0", url: download.kind === "download" ? download.url : "", sha256: "a".repeat(64), size: 10, palette: PALETTE };
    const replies: CatalogReply[] = [{ ok: true, kind: "list", entries: [entry] }, { ok: true, kind: "download", bytes: 10 }, { ok: false, reason: "No." }];
    for (const reply of replies) expect(parseCatalogReply(JSON.parse(JSON.stringify(structuredClone(reply))))).toEqual(reply);

    const badTasks: unknown[] = [
        null,
        "list",
        {},
        { kind: "list", url: "ftp://example.test/catalog.json", engine: "vera-gui@^1" },
        { kind: "list", url: "file:///etc/passwd", engine: "vera-gui@^1" },
        { kind: "list", url: "http://127.0.0.1:1/catalog.json" },
        { kind: "download", url: download.kind === "download" ? download.url : "", size: 0, destination: "/tmp/a" },
        { kind: "download", url: "http://127.0.0.1:1/a.tgz", size: MAX_PACKAGE_BYTES + 1, destination: "/tmp/a" },
        { kind: "download", url: "http://127.0.0.1:1/a.tgz", size: 10, destination: "relative/package.tgz" },
        { kind: "other", url: "http://127.0.0.1:1/a.tgz" },
    ];
    for (const task of badTasks) expect(parseCatalogTask(task)).toBeUndefined();
    const badReplies: unknown[] = [
        null,
        {},
        { ok: true },
        { ok: false },
        { ok: false, reason: 4 },
        { ok: true, kind: "download", bytes: -1 },
        { ok: true, kind: "list", entries: "none" },
        { ok: true, kind: "list", entries: [{ ...entry, palette: [] }] },
        { ok: true, kind: "list", entries: Array.from({ length: 501 }, () => entry) },
    ];
    for (const reply of badReplies) expect(parseCatalogReply(reply)).toBeUndefined();
});

test("@core the list task fetches a catalog and follows an http redirect", async () => {
    const bytes = crowPackage();
    const { origin } = server(() => ({
        "/old": { status: 302, headers: { location: "/catalog.json" } },
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/crow.tgz`, bytes)]) },
    }));
    const reply = await runAsProcess({ kind: "list", url: `${origin}/old`, engine: "vera-gui@^1" });
    expect(reply.ok && reply.kind === "list" && reply.entries.map((entry) => entry.id)).toEqual(["crow.pack"]);
});

test("@core the list task refuses a server error, a redirect to another scheme, a loop and an oversized catalog", async () => {
    const { origin } = server(() => ({
        "/error": { status: 500 },
        "/scheme": { status: 302, headers: { location: "file:///etc/passwd" } },
        "/ftp": { status: 302, headers: { location: "ftp://127.0.0.1/catalog.json" } },
        "/loop": { status: 302, headers: { location: "/loop" } },
        "/big": { body: Buffer.alloc(1024 * 1024 + 1, 0x20) },
        "/not-json": { body: "nothing" },
    }));
    const list = (path: string) => runAsProcess({ kind: "list", url: `${origin}${path}`, engine: "vera-gui@^1" });
    for (const path of ["/error", "/scheme", "/ftp", "/loop", "/missing"]) expect(await list(path)).toEqual({ ok: false, reason: CATALOG_UNREACHABLE });
    expect(await list("/big")).toEqual({ ok: false, reason: "The catalog is larger than 1 MiB." });
    expect(await list("/not-json")).toEqual({ ok: false, reason: "Vera could not read the catalog." });
    expect(await runAsProcess({ kind: "list", url: "http://127.0.0.1:1/catalog.json", engine: "vera-gui@^1" })).toEqual({ ok: false, reason: CATALOG_UNREACHABLE });
});

test("@core the download task writes exactly the listed size, once, and refuses any other length", async () => {
    const bytes = crowPackage();
    const { origin } = server(() => ({
        "/crow.tgz": { body: bytes },
        "/long.tgz": { body: Buffer.concat([bytes, Buffer.from("extra")]) },
        "/short.tgz": { body: bytes.subarray(0, bytes.length - 1) },
        "/missing.tgz": { status: 404 },
    }));
    const directory = scratchDirectory();
    const task = (path: string, destination: string): CatalogTask => ({ kind: "download", url: `${origin}${path}`, size: bytes.length, destination });

    const written = join(directory, "package.tgz");
    expect(await runAsProcess(task("/crow.tgz", written))).toEqual({ ok: true, kind: "download", bytes: bytes.length });
    expect(readFileSync(written).equals(bytes)).toBe(true);
    expect(await runAsProcess(task("/crow.tgz", written))).toEqual({ ok: false, reason: DOWNLOAD_FAILED });

    const mismatch = { ok: false as const, reason: "The package does not match the size the catalog lists." };
    expect(await runAsProcess(task("/long.tgz", join(directory, "long")))).toEqual(mismatch);
    expect(await runAsProcess(task("/short.tgz", join(directory, "short")))).toEqual(mismatch);
    expect(await runAsProcess(task("/missing.tgz", join(directory, "missing")))).toEqual({ ok: false, reason: DOWNLOAD_FAILED });
    expect(readdirSync(directory)).toEqual(["package.tgz"]);
});

interface Catalog {
    readonly home: string;
    readonly store: ExtensionStore;
    readonly extensions: ExtensionService;
    readonly catalog: ExtensionCatalogService;
    readonly tasks: CatalogTask[];
}

// The install task and the catalog task each run on a cloned task with no state, over a store in a scratch home.
function catalogOver(address: string | undefined, home = scratchDirectory()): Catalog {
    const store = new ExtensionStore(extensionsDirectory(home), new ExtensionStateStore(extensionStatePath(home)));
    const themes = new ThemeService(store, themesDirectory(home), runThemeTask);
    const extensions = new ExtensionService(store, themes, async (task) => {
        const parsed = parseInstallTask(structuredClone(task));
        if (parsed === undefined) throw new Error("The task did not read.");
        const reply = parseInstallReply(structuredClone(runInstallTask(parsed)));
        if (reply === undefined) throw new Error("The reply did not read.");
        return reply;
    });
    const tasks: CatalogTask[] = [];
    const catalog = new ExtensionCatalogService(address, store, extensions, (task) => {
        tasks.push(task);
        return runAsProcess(task);
    });
    return { home, store, extensions, catalog, tasks };
}

function folders(home: string): string[] {
    const root = extensionsDirectory(home);
    return existsSync(root) ? readdirSync(root).sort() : [];
}

test("@core with no address Discover reports no catalog and runs no task", async () => {
    const { catalog, tasks } = catalogOver(undefined);
    expect(await catalog.open()).toEqual({ ok: true, available: false });
    expect(await catalog.preview("crow.pack")).toEqual({ ok: false, reason: "That extension is not in the catalog." });
    expect(tasks).toEqual([]);
});

test("@core open lists the catalog, marks what is installed at that version, and keeps nothing on disk", async () => {
    const bytes = crowPackage();
    const { origin, hits } = server(() => ({
        "/catalog.json": {
            body: catalogBytes([
                rawEntry(`${origin}/crow.tgz`, bytes),
                rawEntry(`${origin}/two.tgz`, bytes, { id: "crow.two", name: "Two", version: "2.0.0" }),
                rawEntry(`${origin}/old.tgz`, bytes, { id: "crow.old", withdrawn: true }),
            ]),
        },
        "/crow.tgz": { body: bytes },
    }));
    const { home, catalog, extensions, tasks } = catalogOver(`${origin}/catalog.json`);
    expect(hits).toEqual([]);
    const opened = await catalog.open();
    expect(opened).toEqual({
        ok: true,
        available: true,
        themes: [
            { id: "crow.pack", name: "Crow Night", version: "1.0.0", palette: PALETTE, installed: false },
            { id: "crow.two", name: "Two", version: "2.0.0", palette: PALETTE, installed: false },
        ],
    });
    expect(tasks.map((task) => task.kind)).toEqual(["list"]);
    expect(folders(home)).toEqual([]);

    const preview = await catalog.preview("crow.pack");
    if (!preview.ok) throw new Error(preview.reason);
    expect(extensions.confirm(preview.preview.token).ok).toBe(true);
    const again = await catalog.open();
    expect(again.ok && again.available && again.themes.map((theme) => [theme.id, theme.installed])).toEqual([["crow.pack", true], ["crow.two", false]]);
});

test("@core a preview downloads, checks and unpacks the package, and confirm installs it", async () => {
    const bytes = crowPackage();
    const { origin } = server(() => ({
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/crow.tgz`, bytes)]) },
        "/crow.tgz": { body: bytes },
    }));
    const { home, catalog, extensions, tasks } = catalogOver(`${origin}/catalog.json`);
    await catalog.open();
    const result = await catalog.preview("crow.pack");
    if (!result.ok) throw new Error(result.reason);
    expect(result.preview).toMatchObject({ id: "crow.pack", name: "Crow Night", version: "1.0.0" });
    expect(result.preview.themes.map((theme) => [theme.slug, theme.name])).toEqual([["crow.pack.crow-night", "Crow Night"]]);
    expect(tasks.map((task) => task.kind)).toEqual(["list", "download"]);
    expect(folders(home)).toHaveLength(1);

    const done = extensions.confirm(result.preview.token);
    expect(done.ok && done.extensions.map((entry) => entry.id)).toEqual(["crow.pack"]);
    expect(folders(home)).toEqual(["crow.pack"]);
});

test("@core a package that does not match its checksum is refused and leaves nothing behind", async () => {
    const bytes = crowPackage();
    const other = crowPackage("crow.other");
    const { origin } = server(() => ({
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/crow.tgz`, bytes, { sha256: sha256Of(other), size: bytes.length })]) },
        "/crow.tgz": { body: bytes },
    }));
    const { home, catalog } = catalogOver(`${origin}/catalog.json`);
    await catalog.open();
    expect(await catalog.preview("crow.pack")).toEqual({ ok: false, reason: "The package does not match its expected checksum." });
    expect(folders(home)).toEqual([]);
});

test("@core a package that is not the one the catalog lists is refused and leaves nothing behind", async () => {
    const bytes = crowPackage("crow.other");
    const { origin } = server(() => ({
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/crow.tgz`, bytes, { id: "crow.pack" })]) },
        "/crow.tgz": { body: bytes },
    }));
    const { home, catalog, extensions } = catalogOver(`${origin}/catalog.json`);
    await catalog.open();
    expect(await catalog.preview("crow.pack")).toEqual({ ok: false, reason: "The package is not the one the catalog lists." });
    expect(folders(home)).toEqual([]);
    expect(extensions.confirm("anything").ok).toBe(false);
});

test("@core a preview needs the catalog open, and closing drops the list", async () => {
    const bytes = crowPackage();
    const { origin, hits } = server(() => ({
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/crow.tgz`, bytes)]) },
        "/crow.tgz": { body: bytes },
    }));
    const { home, catalog } = catalogOver(`${origin}/catalog.json`);
    const notListed = { ok: false as const, reason: "That extension is not in the catalog." };
    expect(await catalog.preview("crow.pack")).toEqual(notListed);
    await catalog.open();
    catalog.close();
    expect(await catalog.preview("crow.pack")).toEqual(notListed);
    expect(hits).toEqual(["/catalog.json"]);
    expect(folders(home)).toEqual([]);
});

test("@core a download that finishes after Discover closed installs nothing", async () => {
    const bytes = crowPackage();
    const { origin } = server(() => ({
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/crow.tgz`, bytes)]) },
        "/crow.tgz": { body: bytes },
    }));
    const { home, catalog } = catalogOver(`${origin}/catalog.json`);
    await catalog.open();
    const pending = catalog.preview("crow.pack");
    catalog.close();
    expect(await pending).toEqual({ ok: false, reason: "That extension is not in the catalog." });
    expect(folders(home)).toEqual([]);
});

test("@core an unreachable catalog or package fails the request with a reason", async () => {
    const bytes = crowPackage();
    const { origin } = server(() => ({
        "/catalog.json": { body: catalogBytes([rawEntry(`${origin}/gone.tgz`, bytes)]) },
    }));
    const { home, catalog } = catalogOver(`${origin}/catalog.json`);
    await catalog.open();
    expect(await catalog.preview("crow.pack")).toEqual({ ok: false, reason: DOWNLOAD_FAILED });
    expect(folders(home)).toEqual([]);
    expect(await catalogOver(`${origin}/nope.json`).catalog.open()).toEqual({ ok: false, reason: CATALOG_UNREACHABLE });
});

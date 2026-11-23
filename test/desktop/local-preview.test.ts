import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalPreviewScopes, MAX_PREVIEW_ASSET_BYTES, MAX_PREVIEW_SCOPES } from "../../clients/desktop/src/local-preview.ts";
import { extensionsDirectory } from "../../clients/desktop/src/extensions/paths.ts";
import { parseDesktopManifest } from "../../clients/ui/src/extensions/manifest.ts";
import { ExtensionStateStore } from "../../clients/desktop/src/extensions/state.ts";
import { ExtensionStore } from "../../clients/desktop/src/extensions/store.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "vera-preview-test-"));
    directories.push(directory);
    const root = join(directory, "root");
    await mkdir(root);
    await writeFile(join(root, "index.html"), "<h1>Pirate crow</h1>");
    await writeFile(join(root, "style.css"), "h1 { color: red }");
    await writeFile(join(directory, "secret"), "secret");
    await symlink(join(directory, "secret"), join(root, "escape"));
    const scopes = new LocalPreviewScopes();
    const scope = await scopes.create(root, join(root, "index.html"));
    return { scopes, scope, root, directory };
}

test("@core preview resources remain confined and reload from disk", async () => {
    const { scopes, scope, root } = await fixture();
    const page = await scopes.serve(new Request(scope.url));
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<h1>Pirate crow</h1>");
    const css = new URL("style.css", scope.url).href;
    expect((await scopes.serve(new Request(css))).headers.get("content-type")).toContain("text/css");
    await writeFile(join(root, "index.html"), "changed");
    expect(await (await scopes.serve(new Request(scope.url))).text()).toBe("changed");
    for (const path of ["escape", "missing", "%2e%2e%2fsecret", "%00", "%ZZ", "./"]) {
        expect((await scopes.serve(new Request(new URL(path, scope.url)))).status).toBe(404);
    }
    expect((await scopes.serve(new Request(scope.url, { method: "POST" }))).status).toBe(405);
    const head = await scopes.serve(new Request(scope.url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    scopes.release(scope.token);
    expect((await scopes.serve(new Request(scope.url))).status).toBe(404);
    const another = await scopes.create(root, join(root, "index.html"));
    scopes.clear();
    expect((await scopes.serve(new Request(another.url))).status).toBe(404);
});

test("preview refuses large files, escaped entries and excess scopes", async () => {
    const { scopes, scope, root, directory } = await fixture();
    await truncate(join(root, "style.css"), MAX_PREVIEW_ASSET_BYTES + 1);
    expect((await scopes.serve(new Request(new URL("style.css", scope.url)))).status).toBe(413);
    await expect(scopes.create(root, join(root, "style.css"))).rejects.toThrow("too large");
    await expect(scopes.create(root, join(directory, "secret"))).rejects.toThrow();
    for (let index = 1; index < MAX_PREVIEW_SCOPES; index++) await scopes.create(root, join(root, "index.html"));
    await expect(scopes.create(root, join(root, "index.html"))).rejects.toThrow();
    scopes.release(scope.token);
    await expect(scopes.create(root, join(root, "index.html"))).resolves.toBeDefined();
});

test("clearing while a scope opens prevents allocation", async () => {
    const { scopes, root } = await fixture();
    const opening = scopes.create(root, join(root, "index.html"));
    scopes.clear();
    await expect(opening).rejects.toThrow("closed");
    for (let index = 0; index < MAX_PREVIEW_SCOPES; index++) await expect(scopes.create(root, join(root, "index.html"))).resolves.toBeDefined();
});

test("releasing a scope closes unconsumed streams and frees read slots", async () => {
    const { scopes, scope, root } = await fixture();
    await writeFile(join(root, "large.html"), Buffer.alloc(2 * 1024 * 1024));
    const url = new URL("large.html", scope.url).href;
    const responses: Response[] = [];
    for (let index = 0; index < 16; index++) responses.push(await scopes.serve(new Request(url)));
    expect((await scopes.serve(new Request(url))).status).toBe(503);
    scopes.release(scope.token);
    const next = await scopes.create(root, join(root, "index.html"));
    let answer = await scopes.serve(new Request(next.url));
    for (let attempt = 0; answer.status === 503 && attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        answer = await scopes.serve(new Request(next.url));
    }
    expect(answer.status).toBe(200);
    await answer.text();
    for (const response of responses) await response.body?.cancel().catch(() => {});
});

test("only included extensions list preview contributions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vera-preview-store-"));
    directories.push(directory);
    const included = join(directory, "included");
    const installed = extensionsDirectory(directory);
    for (const [parent, id] of [[included, "crow.included"], [installed, "crow.installed"]] as const) {
        const folder = join(parent, id);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "vera.desktop.json"), JSON.stringify({ id, version: "1.0.0", engine: "vera-gui@^1", contributes: { filePreviews: ["html"] } }));
    }
    const store = new ExtensionStore(directory, new ExtensionStateStore(join(directory, "state.json")), included);
    expect(store.entries().find((entry) => entry.id === "crow.included")?.filePreviews).toEqual(["html"]);
    expect(store.entries().find((entry) => entry.id === "crow.installed")?.filePreviews).toBeUndefined();
});

test("preview extension contributions are bounded and validated", () => {
    const make = (filePreviews: unknown) => parseDesktopManifest({ id: "crow.preview", version: "1", engine: "vera-gui@^1", contributes: { filePreviews } });
    expect(make(["html", "htm"])).toMatchObject({ ok: true, manifest: { filePreviews: ["html", "htm"] } });
    for (const value of [[], ["HTML"], [".html"], ["html", "html"], ["x".repeat(17)], new Array(9).fill("x"), "html"]) expect(make(value).ok).toBe(false);
});

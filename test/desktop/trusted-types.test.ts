import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { preloadPatchDiff } from "@pierre/diffs/ssr";
import { getBuiltInSpriteSheet } from "@pierre/trees";

import { ALLOWED_HTML_ATTRIBUTES, ALLOWED_HTML_TAGS, filterHtml } from "../../clients/ui/src/security/trustedTypes.ts";

const root = join(import.meta.dir, "..", "..");
const SPRITE = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
<symbol id="diffs-icon-expand" viewBox="0 0 16 16"><path d="M1 2h14v2H1z"/></symbol>
</svg>`;
const ESCAPING_PATCH = [
    "--- a/crow.ts",
    "+++ b/crow.ts",
    "@@ -1,4 +1,4 @@",
    " crow stays",
    "-old <img src=x onerror=alert(1)>",
    "+new <style>body{display:none}</style>",
    " </span><b>bold</b>",
    " <script>x</script>",
    "",
].join("\n");
const { prerenderedHTML: PIERRE_HTML } = await preloadPatchDiff({
    patch: ESCAPING_PATCH,
    options: {
        theme: "github-dark",
        themeType: "dark",
        diffStyle: "unified",
        hunkSeparators: "line-info-basic",
        enableLineSelection: true,
        enableGutterUtility: true,
    },
});

function renderedText(html: string): string {
    return html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "")
        .replace(/&#x3C;/g, "<").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    });
}

test("@core app source has no HTML string sinks", () => {
    const sink = /\b(?:innerHTML|outerHTML)\s*(?:\+?=)(?!=)|\b(?:insertAdjacentHTML|setHTMLUnsafe|dangerouslySetInnerHTML|document\.write)\b|\bnew Function\b|\beval\s*\(/;
    const offenders = [...sourceFiles(join(root, "clients", "ui", "src")), ...sourceFiles(join(root, "clients", "desktop", "src"))]
        .filter((path) => sink.test(readFileSync(path, "utf8")))
        .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
});

test("@core the trusted types policy admits real Pierre output and its sprite", () => {
    expect(() => filterHtml(SPRITE)).not.toThrow();
    expect(() => filterHtml(PIERRE_HTML)).not.toThrow();
    for (const set of ["minimal", "standard", "complete"] as const) {
        const treeSprite = getBuiltInSpriteSheet(set);
        expect(() => filterHtml(treeSprite)).not.toThrow();
        expect(filterHtml(treeSprite)).toBe(treeSprite);
    }
    expect(filterHtml(PIERRE_HTML)).toBe(PIERRE_HTML);
    expect(PIERRE_HTML).toContain("<style data-core-css=\"\">");
    const text = renderedText(PIERRE_HTML);
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(text).toContain("<style>body{display:none}</style>");
    expect(text).toContain("</span><b>bold</b>");
    expect(text).toContain("<script>x</script>");
    expect(PIERRE_HTML).not.toContain("<img src=x");
    expect(PIERRE_HTML).not.toContain("<style>body{display:none}");
    expect(PIERRE_HTML).not.toContain("<script>x</script>");
    expect(ALLOWED_HTML_TAGS.has("script")).toBe(false);
    expect(ALLOWED_HTML_ATTRIBUTES.has("onerror")).toBe(false);
});

test("@core the trusted types policy rejects executable markup and unknown names", () => {
    for (const html of [
        `<img src=x onerror="alert(1)">`,
        `<script>alert(1)</script>`,
        `<iframe src="https://example.test">`,
        `<use href="javascript:alert(1)"></use>`,
        `<use href="jav&#x61;script:alert(1)"></use>`,
        `<use href="https://example.test/diffs-icon-expand"></use>`,
        `<span onclick="alert(1)">x</span>`,
        `<span unknown="x">x</span>`,
        `<div><span></div>`,
        `<form action="/">Submit</form>`,
        `<style>body{display:none}</style><script>alert(1)</script>`,
        `<!-- hidden --><span>x</span>`,
    ]) expect(() => filterHtml(html)).toThrow();
    expect(() => filterHtml(`<div title="&lt;img onerror=alert(1)&gt;">safe</div>`)).not.toThrow();
    expect(() => filterHtml(`<div data-anything="x">safe</div>`)).not.toThrow();
    expect(() => filterHtml(`<button data-utility-button="" type="button"><svg></svg></button>`)).not.toThrow();
    expect(() => filterHtml(`<svg><use href="#diffs-icon-expand"></use></svg>`)).not.toThrow();
    expect(() => filterHtml(`<style>body{display:none}</style>`)).not.toThrow();
});

test("@core a script URL is only the bundled worker", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("file:///app/dist/renderer/index.html") });
    try {
        const { filterScriptUrl } = require("../../clients/ui/src/security/trustedTypes.ts") as typeof import("../../clients/ui/src/security/trustedTypes.ts");
        expect(filterScriptUrl("file:///app/dist/renderer/worker.js")).toBe("file:///app/dist/renderer/worker.js");
        expect(() => filterScriptUrl("file:///app/dist/renderer/other.js")).toThrow();
        expect(() => filterScriptUrl("file:///app/dist/renderer/worker.js#copy")).toThrow();
        expect(() => filterScriptUrl("data:text/javascript,alert(1)")).toThrow();
        expect(() => filterScriptUrl("https://cdn.example.test/worker.js")).toThrow();
        expect(() => filterScriptUrl("https://example.test/app/dist/renderer/worker.js")).toThrow();
    } finally {
        if (previous === undefined) delete (globalThis as { location?: Location }).location;
        else Object.defineProperty(globalThis, "location", previous);
    }
});

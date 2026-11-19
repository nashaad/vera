import { expect, test } from "bun:test";
import { browserFrame } from "../../clients/desktop/src/extension-commands/page.ts";

function contents(frames: readonly { name: string; url: string }[], selected: { name: string; url: string }) {
    return {
        mainFrame: { framesInSubtree: frames },
        executeJavaScript: async (script: string) => {
            const expected = JSON.parse(/const name = (.*?); const f/.exec(script)![1]!);
            if (expected !== null && expected !== selected.name) return null;
            return { ...selected, x: 10, y: 20, width: 400, height: 300 };
        },
    } as unknown as Parameters<typeof browserFrame>[0];
}

test("@core an explicit frame uses its current URL and never chooses a different frame", async () => {
    const initial = "vera-preview://abc/index.html";
    const current = "vera-preview://abc/other.html";
    const shell = contents([{ name: "browser-other", url: "http://localhost/" }, { name: "preview-abc", url: current }], { name: "preview-abc", url: initial });
    expect(await browserFrame(shell, (url) => url.startsWith("vera-preview://abc/"), "preview-abc")).toMatchObject({ name: "preview-abc", url: current });
    expect(await browserFrame(shell, () => true, "browser-other")).toBeUndefined();
    expect(await browserFrame(contents([{ name: "preview-abc", url: "vera-preview://other/index.html" }], { name: "preview-abc", url: initial }), () => true, "preview-abc")).toBeUndefined();
    expect(await browserFrame(contents([{ name: "preview-abc", url: current }, { name: "preview-abc", url: current }], { name: "preview-abc", url: initial }), () => true, "preview-abc")).toBeUndefined();
});

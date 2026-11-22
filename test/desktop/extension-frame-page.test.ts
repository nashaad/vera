import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { extensionFramePage } from "../../clients/desktop/extension-frame-page.ts";

const SCRIPT = "window.addEventListener('message', function () { /* start */ });";

test("@core the frame page allows exactly its own script, worker blobs and nothing from the network", () => {
    const html = extensionFramePage(SCRIPT);
    const hash = createHash("sha256").update(SCRIPT).digest("base64");
    expect(html).toContain(`script-src 'sha256-${hash}' blob:`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("worker-src blob:");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toContain("unsafe-eval");
    expect(html).toContain(`<script>${SCRIPT}</script>`);
});

test("a script that could end the inline block is refused", () => {
    expect(() => extensionFramePage("a</script><script>b")).toThrow();
    expect(() => extensionFramePage("a<!--b")).toThrow();
});

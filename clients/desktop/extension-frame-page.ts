import { createHash } from "node:crypto";

// A file: page cannot load file: scripts from an opaque origin, so the frame script is inline and named by hash.
// The page may run only that script, start workers from blobs and import blob modules. It cannot reach the network.
export function extensionFramePage(script: string): string {
    if (/<\/script|<!--/i.test(script)) throw new Error("The extension frame script cannot be placed inline.");
    const hash = createHash("sha256").update(script).digest("base64");
    const policy = `default-src 'none'; script-src 'sha256-${hash}' blob:; worker-src blob:; connect-src 'none'`;
    return `<!doctype html>\n<html><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${policy}" /></head><body><script>${script}</script></body></html>\n`;
}

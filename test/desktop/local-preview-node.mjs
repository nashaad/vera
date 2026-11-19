import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { LocalPreviewScopes } = await import(pathToFileURL(process.argv[2]).href);
const directory = await mkdtemp(join(tmpdir(), "vera-preview-node-"));
const streams = [];
let prototype;
let original;
try {
    const file = join(directory, "index.html");
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024));
    const probe = await open(file);
    prototype = Object.getPrototypeOf(probe);
    original = prototype.createReadStream;
    prototype.createReadStream = function (...args) {
        const stream = original.apply(this, args);
        streams.push(stream);
        return stream;
    };
    await probe.close();
    const scopes = new LocalPreviewScopes();
    const scope = await scopes.create(directory, file);
    const responses = [];
    for (let i = 0; i < 16; i++) responses.push(await scopes.serve(new Request(scope.url)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await scopes.serve(new Request(scope.url))).status, 503);
    for (const stream of streams) assert.ok(stream.bytesRead <= 256 * 1024, `unconsumed body read ${stream.bytesRead} bytes`);
    scopes.release(scope.token);
    await Promise.all(streams.map((stream) => stream.closed ? undefined : new Promise((resolve) => stream.once("close", resolve))));
    const next = await scopes.create(directory, file);
    const response = await scopes.serve(new Request(next.url));
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.ok((await reader.read()).value.byteLength > 0);
    scopes.release(next.token);
    await reader.cancel().catch(() => {});
    for (const item of responses) await item.body.cancel().catch(() => {});
    console.log("Node preview backpressure and release passed");
} finally {
    if (prototype && original) prototype.createReadStream = original;
    await rm(directory, { recursive: true, force: true });
}

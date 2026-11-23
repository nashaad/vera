import { join } from "node:path";

import { loadVeraConfig } from "../../src/config.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { DEFAULT_CURATED_URL } from "../../src/model/curated-models.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";

const home = process.env.VERA_HOME;
if (home === undefined) throw new Error("VERA_HOME is required");

const unexpectedRequests: string[] = [];
const blockedFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === DEFAULT_CURATED_URL
        || (url.origin === "https://datasets-server.huggingface.co" && url.pathname === "/rows")) {
        return new Response(null, { status: 503 });
    }
    unexpectedRequests.push(`${url.origin}${url.pathname}`);
    throw new Error("Unexpected network request");
}) as unknown as typeof fetch;
globalThis.fetch = blockedFetch;

const host = await startResidentHost({
    home,
    config: loadVeraConfig({ path: join(home, "config.json") }),
    authStorage: createAuthStorage({ path: join(home, "machine", "auth.json") }),
    catalogFetch: blockedFetch,
    webRoot: home,
});
await host.close();
if (unexpectedRequests.length !== 0) {
    throw new Error(`Startup made unexpected requests:\n${unexpectedRequests.join("\n")}`);
}

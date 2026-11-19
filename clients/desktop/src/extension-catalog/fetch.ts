import { CatalogRefusal } from "./refusal.ts";

const MAX_REDIRECTS = 5;
// Shorter than the task deadline, so a slow server is refused with a reason rather than by the timeout.
export const FETCH_TIMEOUT_MS = 45_000;

export interface FetchOptions {
    readonly maxBytes: number;
    readonly failed: string;
    readonly tooLarge: string;
}

function followable(location: string | null, current: string): string | undefined {
    if (location === null) return undefined;
    try {
        const next = new URL(location, current);
        return next.protocol === "http:" || next.protocol === "https:" ? next.href : undefined;
    } catch {
        return undefined;
    }
}

async function readCapped(response: Response, options: FetchOptions): Promise<Buffer> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel();
        throw new CatalogRefusal(options.tooLarge);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    while (reader !== undefined) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > options.maxBytes) {
            await reader.cancel();
            throw new CatalogRefusal(options.tooLarge);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

// Fetches over http or https. Each redirect is checked before it is followed, so a server cannot send the task to
// another scheme, and the body is read only up to `maxBytes`.
export async function fetchBytes(url: string, options: FetchOptions): Promise<Buffer> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
        let current = url;
        for (let hops = 0; ; hops += 1) {
            const response = await fetch(current, { redirect: "manual", signal });
            if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                const next = hops < MAX_REDIRECTS ? followable(response.headers.get("location"), current) : undefined;
                if (next === undefined) throw new CatalogRefusal(options.failed);
                current = next;
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw new CatalogRefusal(options.failed);
            }
            return await readCapped(response, options);
        }
    } catch (error) {
        throw error instanceof CatalogRefusal ? error : new CatalogRefusal(options.failed);
    }
}

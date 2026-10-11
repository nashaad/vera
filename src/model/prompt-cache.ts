import type { ModelRequest } from "./types.ts";

export type CacheRetention = "none" | "short" | "long";

// Providers reject longer keys; counted in code points so a key never ends in half a surrogate pair.
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function cacheRetention(request: Pick<ModelRequest, "cacheRetention">): CacheRetention {
    return request.cacheRetention ?? "short";
}

export function promptCacheKey(
    request: Pick<ModelRequest, "cacheKey" | "cacheRetention">,
): string | undefined {
    if (request.cacheKey === undefined || cacheRetention(request) === "none") {
        return undefined;
    }
    const key = Array.from(request.cacheKey)
        .slice(0, PROMPT_CACHE_KEY_MAX_LENGTH)
        .join("");
    return key.length === 0 ? undefined : key;
}

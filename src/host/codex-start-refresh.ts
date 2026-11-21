/**
 * Fetches the Codex model list once at host start when the saved catalog is
 * missing or from another build. Boot never waits on it; the daily scan and a
 * manual refresh remain the retry path.
 */

import type { AuthStorage } from "../providers/auth-storage.ts";
import {
    CodexCatalogError,
    fetchCodexCatalog,
    readCodexCatalog,
    type CodexCatalogAuthorization,
    type CodexCatalogFailure,
} from "../model/codex-catalog.ts";
import type { HostLog } from "./host-log.ts";

const PROVIDER = "openai-codex";

export const CODEX_CATALOG_START_TIMEOUT_MS = 15_000;

export interface CodexCatalogStartFetchOptions {
    readonly authStorage: AuthStorage;
    readonly cacheDir?: string;
    readonly log: HostLog;
    readonly authorization?: CodexCatalogAuthorization;
    readonly baseUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}

export type CodexCatalogStartFetchOutcome =
    | { readonly status: "fetched"; readonly models: number }
    | { readonly status: "skipped"; readonly reason: "missing_credential" | "cache_usable" }
    | { readonly status: "failed"; readonly failure: CodexCatalogFailure | "timeout" };

class CodexStartTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`OpenAI Codex models request timed out after ${timeoutMs} ms`);
        this.name = "CodexStartTimeoutError";
    }
}

export async function fetchCodexCatalogAtStart(
    options: CodexCatalogStartFetchOptions,
): Promise<CodexCatalogStartFetchOutcome> {
    if (!hasCodexCredential(options.authStorage)) {
        return { status: "skipped", reason: "missing_credential" };
    }
    // An other-build or unreadable file reads as an empty catalog, and a
    // successful fetch never writes an empty one.
    if (readCodexCatalog(options.cacheDir).models.length > 0) {
        return { status: "skipped", reason: "cache_usable" };
    }

    try {
        const catalog = await withTimeout(
            fetchCodexCatalog({
                authStorage: options.authStorage,
                ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
                ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
                ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            }),
            options.timeoutMs ?? CODEX_CATALOG_START_TIMEOUT_MS,
        );
        options.log({ type: "codex_catalog_start_fetch", models: catalog.models.length });
        return { status: "fetched", models: catalog.models.length };
    } catch (error) {
        const failure = error instanceof CodexStartTimeoutError
            ? "timeout"
            : error instanceof CodexCatalogError ? error.failure : "unavailable";
        options.log({
            type: "codex_catalog_start_fetch_failed",
            failure,
            message: error instanceof Error ? error.message : String(error),
        });
        return { status: "failed", failure };
    }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CodexStartTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
    });
    return Promise.race([work, deadline]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

function hasCodexCredential(authStorage: Pick<AuthStorage, "getCredential">): boolean {
    try {
        return authStorage.getCredential(PROVIDER) !== undefined;
    } catch {
        return false;
    }
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CODEX_CLIENT_VERSION,
    CodexCatalogError,
    fetchCodexCatalog,
    normalizeCodexModelCache,
} from "../../src/model/codex-catalog.ts";
import { createAuthStorage } from "../../src/providers/auth-storage.ts";
import { readProviderCatalogSnapshot } from "../../src/model/catalog-cache.ts";
import { effectiveCatalog } from "../../src/model/catalog.ts";

const fixturePath = new URL(
    "../fixtures/codex-models-cache.json",
    import.meta.url,
);
const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("normalizeCodexModelCache", () => {
    test("normalizes the Codex cache into the pinned catalog shape", () => {
        const catalog = normalizeCodexModelCache(fixture);
        const sol = catalog.models.find((model) => model.id === "gpt-5.6-sol");

        expect(catalog.schema_version).toBe(2);
        expect(catalog.provider).toBe("openai-codex");
        expect(catalog.fetched_at).toBe(
            (fixture as { fetched_at: string }).fetched_at,
        );
        expect(sol?.levels.map((level) => level.id)).toEqual([
            "ultra",
            "max",
            "xhigh",
            "high",
            "medium",
            "low",
        ]);
        expect(sol?.levels).toHaveLength(6);
    });

    test("stores levels strongest first, reversing Codex's own order", () => {
        const source = (fixture as {
            models: { slug: string; supported_reasoning_levels: unknown[] }[];
        }).models.find((model) => model.slug === "gpt-5.6-sol");
        const sol = normalizeCodexModelCache(fixture).models.find(
            (model) => model.id === "gpt-5.6-sol",
        );

        // Not a restatement of the case above: it pins the direction to the
        // source rather than to a hardcoded list, so a fixture refresh that
        // changes which levels exist still checks the thing that matters.
        expect(sol?.levels.map((level) => level.id)).toEqual(
            (source?.supported_reasoning_levels as { effort: string }[])
                .map((level) => level.effort)
                .reverse(),
        );
    });

    test("does not copy large unmapped fields", () => {
        const serialized = JSON.stringify(normalizeCodexModelCache(fixture));

        expect(serialized).not.toContain(
            "TRUNCATED_FOR_FIXTURE_large_system_prompt_must_never_be_copied",
        );
        expect(serialized).not.toContain("TRUNCATED_FOR_FIXTURE");
    });

    test("filters only models whose visibility is hide", () => {
        const catalog = normalizeCodexModelCache(fixture);
        const ids = catalog.models.map((model) => model.id);

        expect(ids).not.toContain("codex-auto-review");
        expect(ids).toContain("gpt-5.3-codex-spark");
    });

    test("returns an empty catalog for malformed input", () => {
        const malformed = [
            null,
            {},
            { models: "not an array" },
            { models: [123, null, { slug: 5 }] },
        ];

        for (const raw of malformed) {
            expect(() => normalizeCodexModelCache(raw)).not.toThrow();
            expect(normalizeCodexModelCache(raw).models).toEqual([]);
        }
    });
});

describe("fetchCodexCatalog", () => {
    const directories: string[] = [];

    function scratch(): string {
        const directory = mkdtempSync(join(tmpdir(), "vera-codex-"));
        directories.push(directory);
        return directory;
    }

    function signedIn(directory: string, accessToken = "access-1") {
        const authStorage = createAuthStorage({ path: join(directory, "auth.json") });
        authStorage.setCredential("openai-codex", {
            type: "oauth",
            token: JSON.stringify({
                schema_version: 1,
                access_token: accessToken,
                refresh_token: "refresh-1",
                expires_at: Date.now() + 3_600_000,
                account_id: "account-1",
            }),
        });
        return authStorage;
    }

    afterEach(() => {
        while (directories.length > 0) {
            rmSync(directories.pop()!, { recursive: true, force: true });
        }
    });

    test("asks the Codex models endpoint as the signed-in account and saves the list", async () => {
        const directory = scratch();
        const seen: { url: string; headers: Record<string, string> }[] = [];
        const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
            return Response.json(fixture);
        }) as typeof globalThis.fetch;

        const catalog = await fetchCodexCatalog({
            authStorage: signedIn(directory), fetch, cacheDir: directory,
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
        expect(seen[0]!.headers.Authorization).toBe("Bearer access-1");
        expect(seen[0]!.headers["chatgpt-account-id"]).toBe("account-1");
        expect(catalog.fetched_at).toBeDefined();
        const sol = effectiveCatalog("openai-codex", { cacheDir: directory })
            .models.find((model) => model.id === "gpt-5.6-sol");
        expect(sol?.label).toBe("GPT-5.6-Sol");
        expect(sol?.levels[0]?.id).toBe("ultra");
    });

    test("a failed or empty answer throws and keeps the saved list", async () => {
        const directory = scratch();
        const authStorage = signedIn(directory);
        await fetchCodexCatalog({ authStorage, cacheDir: directory,
            fetch: (async () => Response.json(fixture)) as unknown as typeof globalThis.fetch });
        const saved = readProviderCatalogSnapshot("openai-codex", { cacheDir: directory }).models.length;

        for (const answer of [new Response("down", { status: 503 }), Response.json({ models: [] })]) {
            await expect(fetchCodexCatalog({ authStorage, cacheDir: directory,
                fetch: (async () => answer) as unknown as typeof globalThis.fetch })).rejects.toThrow();
        }
        expect(readProviderCatalogSnapshot("openai-codex", { cacheDir: directory }).models)
            .toHaveLength(saved);
    });

    test("each failure names its kind so a refresh can report it", async () => {
        const failureOf = async (authStorage: ReturnType<typeof signedIn>, fetch: typeof globalThis.fetch) =>
            fetchCodexCatalog({ authStorage, cacheDir: scratch(), fetch })
                .then(() => "ok", (error: unknown) => error instanceof CodexCatalogError ? error.failure : "untyped");
        const answering = (response: () => Response) => (async () => response()) as unknown as typeof globalThis.fetch;

        expect(await failureOf(signedIn(scratch()), answering(() => new Response("down", { status: 503 })))).toBe("unavailable");
        expect(await failureOf(signedIn(scratch()), answering(() => Response.json({ models: [] })))).toBe("empty_response");
        expect(await failureOf(signedIn(scratch()), (async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch))
            .toBe("unavailable");
        // 401 spends the one refresh; the token endpoint refusing it is a sign-in problem.
        const rejecting = async (input: string | URL | Request) =>
            String(input).includes("/models") ? new Response("no", { status: 401 }) : new Response("bad", { status: 400 });
        expect(await failureOf(signedIn(scratch()), rejecting as unknown as typeof globalThis.fetch)).toBe("authentication");
        expect(await failureOf(createAuthStorage({ path: join(scratch(), "auth.json") }), answering(() => Response.json(fixture))))
            .toBe("missing_credential");
    });

    test("an abort drops a reply that ignores the signal", async () => {
        const directory = scratch();
        const controller = new AbortController();
        let requestSignal: AbortSignal | null | undefined;
        const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            requestSignal = init?.signal;
            controller.abort();
            await Bun.sleep(25);
            return Response.json(fixture);
        }) as typeof globalThis.fetch;

        const failure = await fetchCodexCatalog({
            authStorage: signedIn(directory),
            cacheDir: directory,
            fetch,
            signal: controller.signal,
        }).then(() => undefined, (error: unknown) => error);

        expect((failure as { name?: string } | undefined)?.name).toBe("AbortError");
        expect(requestSignal?.aborted).toBe(true);
        expect(readProviderCatalogSnapshot("openai-codex", { cacheDir: directory }).models)
            .toHaveLength(0);
    });

    test("signed out is an error, not an empty list", async () => {
        const directory = scratch();
        await expect(fetchCodexCatalog({
            authStorage: createAuthStorage({ path: join(directory, "auth.json") }),
            cacheDir: directory,
            fetch: (async () => Response.json(fixture)) as unknown as typeof globalThis.fetch,
        })).rejects.toThrow();
    });
});

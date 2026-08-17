import { expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
    VeraConfigError,
    type VeraCustomProviderConfig,
} from "../../src/config.ts";
import { loadRecommendedModels } from "../../src/model/recommended-models.ts";

const LOCAL: VeraCustomProviderConfig = {
    protocol: "openai-chat",
    base_url: "https://gateway.example/v1",
    credential: "api_key",
};

function withConfigFile(
    run: (path: string) => void,
    seed: Record<string, unknown> = { schema_version: 1, model: "seed" },
): void {
    const directory = mkdtempSync(join(tmpdir(), "vera-provider-write-"));
    try {
        const path = join(directory, "config.json");
        writeFileSync(path, JSON.stringify(seed));
        run(path);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("a declared provider writes and reads back", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.providers?.gateway).toEqual(LOCAL);
    });
});

test("a hand-written entry and a written one parse the same", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults(
            {
                custom_provider: {
                    id: "gateway",
                    // The trailing slash is what a user pastes from a docs
                    // page; the loader strips it either way.
                    declaration: { ...LOCAL, base_url: `${LOCAL.base_url}/` },
                },
            },
            { path },
        );
        const written = loadVeraConfig({ path }).providers?.gateway;
        withConfigFile((handPath) => {
            const byHand = loadVeraConfig({ path: handPath }).providers?.gateway;
            expect(written).toEqual(byHand!);
        }, {
            schema_version: 1,
            model: "seed",
            providers: { gateway: { ...LOCAL, base_url: `${LOCAL.base_url}/` } },
        });
    });
});

test("declaring one provider leaves the others alone", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        updateVeraConfigDefaults(
            {
                custom_provider: {
                    id: "workstation",
                    declaration: {
                        protocol: "anthropic-messages",
                        base_url: "http://localhost:8080",
                        credential: "none",
                    },
                },
            },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(Object.keys(config.providers ?? {}).sort()).toEqual([
            "gateway",
            "workstation",
        ]);
    });
});

test("null removes only the named provider", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        updateVeraConfigDefaults(
            { custom_provider: { id: "workstation", declaration: LOCAL } },
            { path },
        );
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: null } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.providers?.gateway).toBeUndefined();
        expect(config.providers?.workstation).toBeDefined();
    });
});

test("settings the user made separately survive the write", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.approval_mode).toBe("ask");
        expect(config.model).toBe("seed");
        expect(config.model_assignments?.extra).toBeDefined();
    }, {
        schema_version: 1,
        model: "seed",
        approval_mode: "ask",
        model_assignments: {
            extra: {
                models: [
                    { name: "big", provider: "openrouter", model: "big-1" },
                ],
            },
        },
    });
});

test("an id Vera already ships is refused and nothing is written", () => {
    withConfigFile((path) => {
        const before = readFileSync(path, "utf8");
        expect(() =>
            updateVeraConfigDefaults(
                { custom_provider: { id: "openrouter", declaration: LOCAL } },
                { path },
            )
        ).toThrow(VeraConfigError);
        expect(readFileSync(path, "utf8")).toBe(before);
    });
});

test("a base URL the loader would refuse is refused here too", () => {
    withConfigFile((path) => {
        expect(() =>
            updateVeraConfigDefaults(
                {
                    custom_provider: {
                        id: "gateway",
                        declaration: { ...LOCAL, base_url: "http://example.com" },
                    },
                },
                { path },
            )
        ).toThrow(VeraConfigError);
    });
});

test("declaring a provider on a machine with no config creates one", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-provider-fresh-"));
    try {
        const path = join(directory, "config.json");
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.providers?.gateway).toEqual(LOCAL);
        expect(config.schema_version).toBe(1);
        expect(config.model.length).toBeGreaterThan(0);
        expect(config.approval_mode).toBe("auto");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the created config matches the shipped recommendation", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-provider-fresh-"));
    try {
        const path = join(directory, "config.json");
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        const first = loadRecommendedModels()[0]!;
        const config = loadVeraConfig({ path });
        expect(config.provider).toBe(first.provider);
        expect(config.model).toBe(first.model);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("an existing config is never replaced by the starting one", () => {
    withConfigFile((path) => {
        updateVeraConfigDefaults(
            { custom_provider: { id: "gateway", declaration: LOCAL } },
            { path },
        );
        const config = loadVeraConfig({ path });
        expect(config.model).toBe("seed");
    });
});

test("a refused declaration on a fresh machine writes no file", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-provider-fresh-"));
    try {
        const path = join(directory, "config.json");
        expect(() =>
            updateVeraConfigDefaults(
                { custom_provider: { id: "openrouter", declaration: LOCAL } },
                { path },
            )
        ).toThrow(VeraConfigError);
        expect(existsSync(path)).toBe(false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

import { expect, test } from "bun:test";

import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    loadVeraConfig,
    VeraConfigError,
} from "../../src/config.ts";

function fixture(raw: Record<string, unknown>): { directory: string; path: string } {
    const directory = mkdtempSync(join(tmpdir(), "vera-digitalocean-migration-"));
    const path = join(directory, "config.json");
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { directory, path };
}

function baseConfig(provider: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
        schema_version: 1,
        provider: "digitalocean",
        model: "account-model",
        approval_mode: "ask",
        providers: { digitalocean: provider },
        ...extra,
    };
}

test("an equivalent DigitalOcean custom declaration is removed atomically", () => {
    const { directory, path } = fixture(baseConfig({
        protocol: "openai-chat",
        base_url: "https://inference.do-ai.run/v1",
        credential: "api_key",
    }, { model_catalog_max_age_days: 3 }));
    try {
        const config = loadVeraConfig({ path });
        const disk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        expect(config.provider).toBe("digitalocean");
        expect(config.model).toBe("account-model");
        expect(disk.providers).toBeUndefined();
        expect(disk.model_catalog_max_age_days).toBe(3);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a changed custom endpoint becomes a shipped endpoint override", () => {
    const { directory, path } = fixture(baseConfig({
        protocol: "openai-chat",
        base_url: "https://proxy.example/v1",
        credential: "api_key",
    }, {
        providers: {
            digitalocean: {
                protocol: "openai-chat",
                base_url: "https://proxy.example/v1",
                credential: "api_key",
            },
            gateway: {
                protocol: "openai-chat",
                base_url: "https://gateway.example/v1",
                credential: "none",
            },
        },
        provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" },
    }));
    try {
        const config = loadVeraConfig({ path });
        expect(config.provider_endpoints).toMatchObject({
            cerebras: "https://eu.cerebras.example/v1",
            digitalocean: "https://proxy.example/v1",
        });
        expect(config.providers?.digitalocean).toBeUndefined();
        expect(config.providers?.gateway).toBeDefined();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("migration refuses custom fields it cannot preserve", () => {
    const { directory, path } = fixture(baseConfig({
        protocol: "openai-chat",
        base_url: "https://inference.do-ai.run/v1",
        credential: "api_key",
        images: true,
    }));
    const before = readFileSync(path, "utf8");
    try {
        expect(() => loadVeraConfig({ path })).toThrow(VeraConfigError);
        expect(() => loadVeraConfig({ path })).toThrow(/digitalocean.*images/);
        expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("migration normalizes the previously accepted DigitalOcean id", () => {
    const raw = {
        ...baseConfig({
            protocol: "openai-chat",
            base_url: "https://inference.do-ai.run/v1",
            credential: "api_key",
        }),
        providers: {
            " digitalocean ": {
                protocol: "openai-chat",
                base_url: "https://inference.do-ai.run/v1",
                credential: "api_key",
            },
        },
    };
    const { directory, path } = fixture(raw);
    try {
        const config = loadVeraConfig({ path });
        expect(config.provider).toBe("digitalocean");
        expect(JSON.parse(readFileSync(path, "utf8")).providers).toBeUndefined();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("migration accepts the environment key already shipped for DigitalOcean", () => {
    const { directory, path } = fixture(baseConfig({
        protocol: "openai-chat",
        base_url: "https://inference.do-ai.run/v1",
        credential: "api_key",
        api_key_env: "DIGITALOCEAN_API_KEY",
    }));
    try {
        const config = loadVeraConfig({ path });
        expect(config.provider).toBe("digitalocean");
        expect(JSON.parse(readFileSync(path, "utf8")).providers).toBeUndefined();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

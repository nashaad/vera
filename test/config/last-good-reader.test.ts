import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLastGoodVeraConfigReader, VeraConfigError } from "../../src/config.ts";
import { VERA_HOME_ENV } from "../../src/profile-paths.ts";

const good = { schema_version: 1, provider: "openrouter", model: "crow/good" };
const fixed = { schema_version: 1, provider: "openrouter", model: "crow/fixed" };
const clashing = { ...good, providers: { deepseek: { protocol: "openai-chat", base_url: "https://crow.example/v1", credential: "api_key" } } };

function configPath(): string {
    return join(mkdtempSync(join(tmpdir(), "vera-last-good-")), "config.json");
}

test("the reader answers with the last good config and the load error while the file is bad", () => {
    const path = configPath();
    const read = createLastGoodVeraConfigReader({ path });
    expect(read()).toEqual({ config: undefined });

    writeFileSync(path, JSON.stringify(good));
    expect(read().config?.model).toBe("crow/good");
    expect(read().error).toBeUndefined();

    writeFileSync(path, JSON.stringify(clashing));
    const clash = read();
    expect(clash.config?.model).toBe("crow/good");
    expect(clash.error).toBeInstanceOf(VeraConfigError);
    expect((clash.error as VeraConfigError).problem).toContain('provider "deepseek" is built into Vera');

    writeFileSync(path, "{ not json");
    const broken = read();
    expect(broken.config?.model).toBe("crow/good");
    expect((broken.error as VeraConfigError).problem).toContain("not valid JSON");

    writeFileSync(path, JSON.stringify(fixed));
    expect(read()).toEqual({ config: expect.objectContaining({ model: "crow/fixed" }) });
});

test("a file that never loaded gives only the error, and a deleted one gives neither", () => {
    const path = configPath();
    const read = createLastGoodVeraConfigReader({ path });
    writeFileSync(path, JSON.stringify(clashing));
    const never = read();
    expect(never.config).toBeUndefined();
    expect(never.error).toBeInstanceOf(VeraConfigError);

    writeFileSync(path, JSON.stringify(good));
    expect(read().config?.model).toBe("crow/good");
    const absent = createLastGoodVeraConfigReader({ path: join(path, "..", "missing.json") });
    expect(absent()).toEqual({ config: undefined });
});

test("a config remembered under one home is not served under another", () => {
    const previous = process.env[VERA_HOME_ENV];
    const first = mkdtempSync(join(tmpdir(), "vera-last-good-home-"));
    const second = mkdtempSync(join(tmpdir(), "vera-last-good-home-"));
    try {
        const read = createLastGoodVeraConfigReader();
        process.env[VERA_HOME_ENV] = first;
        writeFileSync(join(first, "config.json"), JSON.stringify(good));
        expect(read().config?.model).toBe("crow/good");

        process.env[VERA_HOME_ENV] = second;
        writeFileSync(join(second, "config.json"), JSON.stringify(clashing));
        const other = read();
        expect(other.config).toBeUndefined();
        expect(other.error).toBeInstanceOf(VeraConfigError);
    } finally {
        if (previous === undefined) delete process.env[VERA_HOME_ENV];
        else process.env[VERA_HOME_ENV] = previous;
    }
});

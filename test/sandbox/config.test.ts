import { expect, test } from "bun:test";

import { collectConfigProblem } from "../../src/config/diagnostic.ts";
import {
    DEFAULT_SANDBOX_CONFIG,
    parseSandboxConfig,
} from "../../src/config/sandbox.ts";

function parse(value: unknown) {
    return collectConfigProblem(() => parseSandboxConfig(value));
}

test("@core sandbox config is off with an open network by default", () => {
    expect(parse(undefined).value).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(DEFAULT_SANDBOX_CONFIG).toEqual({
        enabled: false,
        network: "open",
        allowed_domains: [],
    });
    expect(parse({}).value).toEqual(DEFAULT_SANDBOX_CONFIG);
});

test("@core sandbox config reads the three keys", () => {
    const { value, problem } = parse({
        enabled: true,
        network: "allowlist",
        allowed_domains: ["github.com", "*.example.com:443"],
    });
    expect(problem).toBeUndefined();
    expect(value).toEqual({
        enabled: true,
        network: "allowlist",
        allowed_domains: ["github.com", "*.example.com:443"],
    });
});

test("@core sandbox config keeps an allowlist empty when no hosts are given", () => {
    expect(parse({ enabled: true, network: "allowlist" }).value).toEqual({
        enabled: true,
        network: "allowlist",
        allowed_domains: [],
    });
});

test("@core sandbox config refuses unknown keys", () => {
    const { value, problem } = parse({ enabled: true, allow_read: true });
    expect(value).toBeUndefined();
    expect(problem?.field).toBe("sandbox.allow_read");
});

test("@core sandbox config refuses a wrong network mode", () => {
    const { value, problem } = parse({ network: "deny" });
    expect(value).toBeUndefined();
    expect(problem?.field).toBe("sandbox.network");
});

test("@core sandbox config refuses a non-boolean enabled", () => {
    const { value, problem } = parse({ enabled: "yes" });
    expect(value).toBeUndefined();
    expect(problem?.field).toBe("sandbox.enabled");
});

test("@core sandbox config refuses a bare wildcard host", () => {
    for (const entry of ["*", "https://github.com", "git hub.com", "*.com"]) {
        const { value, problem } = parse({ allowed_domains: [entry] });
        expect(value).toBeUndefined();
        expect(problem?.field).toBe("sandbox.allowed_domains");
    }
});

test("@core sandbox config refuses ports outside the valid range", () => {
    for (const entry of ["github.com:0", "github.com:65536", "github.com:http"]) {
        expect(parse({ allowed_domains: [entry] }).value).toBeUndefined();
    }
});

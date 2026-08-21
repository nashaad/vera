import { expect, test } from "bun:test";

import {
    EnvReferenceError,
    resolveEnvReferences,
} from "../../src/extensions/env-refs.ts";

const ENV = { TOKEN: "secret-value", EMPTY: "", OTHER: "other-value" };

test("a value that is entirely one reference resolves from the environment", () => {
    const resolved = resolveEnvReferences(
        { headers: { authorization: "{env:TOKEN}" } },
        "mcp",
        ENV,
    );

    expect(resolved).toEqual({ headers: { authorization: "secret-value" } });
});

test("a reference inside a longer string is left alone", () => {
    const resolved = resolveEnvReferences(
        { authorization: "Bearer {env:TOKEN}" },
        "mcp",
        ENV,
    );

    expect(resolved).toEqual({ authorization: "Bearer {env:TOKEN}" });
});

test("references resolve through arrays and nested objects", () => {
    const resolved = resolveEnvReferences(
        {
            servers: [
                { command: ["run", "{env:TOKEN}"] },
                { env: { KEY: "{env:OTHER}" } },
            ],
        },
        "mcp",
        ENV,
    );

    expect(resolved).toEqual({
        servers: [
            { command: ["run", "secret-value"] },
            { env: { KEY: "other-value" } },
        ],
    });
});

test("numbers, booleans, and null pass through untouched", () => {
    const resolved = resolveEnvReferences(
        { port: 8080, enabled: true, missing: null },
        "mcp",
        ENV,
    );

    expect(resolved).toEqual({ port: 8080, enabled: true, missing: null });
});

test("an unset variable throws and names the variable and the key path", () => {
    expect(() =>
        resolveEnvReferences(
            { servers: { github: { token: "{env:ABSENT}" } } },
            "mcp",
            ENV,
        )
    ).toThrow(EnvReferenceError);

    try {
        resolveEnvReferences({ token: "{env:ABSENT}" }, "mcp", ENV);
        throw new Error("expected a throw");
    } catch (error) {
        expect(error).toBeInstanceOf(EnvReferenceError);
        expect((error as EnvReferenceError).variable).toBe("ABSENT");
        expect((error as Error).message).toContain("ABSENT");
        expect((error as Error).message).toContain("config.token");
        expect((error as Error).message).toContain("mcp");
    }
});

test("a variable set to the empty string counts as unset", () => {
    expect(() => resolveEnvReferences({ token: "{env:EMPTY}" }, "mcp", ENV))
        .toThrow(EnvReferenceError);
});

test("the failure message never carries the resolved value", () => {
    try {
        resolveEnvReferences(
            { good: "{env:TOKEN}", bad: "{env:ABSENT}" },
            "mcp",
            ENV,
        );
        throw new Error("expected a throw");
    } catch (error) {
        expect((error as Error).message).not.toContain("secret-value");
    }
});

test("a malformed reference is an ordinary string", () => {
    const resolved = resolveEnvReferences(
        { a: "{env:}", b: "{env:1BAD}", c: "{env:TOKEN }", d: "{ENV:TOKEN}" },
        "mcp",
        ENV,
    );

    expect(resolved).toEqual({
        a: "{env:}",
        b: "{env:1BAD}",
        c: "{env:TOKEN }",
        d: "{ENV:TOKEN}",
    });
});

test("the input config is not mutated", () => {
    const input = { headers: { authorization: "{env:TOKEN}" } };

    resolveEnvReferences(input, "mcp", ENV);

    expect(input.headers.authorization).toBe("{env:TOKEN}");
});

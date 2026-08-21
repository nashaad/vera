import { expect, test } from "bun:test";

import {
    findLiteralSecrets,
    redactSecretShapedText,
} from "../../src/extensions/literal-secret.ts";

test("a value carrying a known credential prefix is reported with its path", () => {
    const findings = findLiteralSecrets(
        { servers: { one: { token: "ghp_abcdefghijklmnop" } } },
        "mcp",
    );

    expect(findings).toEqual([
        { extensionId: "mcp", configPath: "servers.one.token", prefix: "ghp_" },
    ]);
});

test("the longest matching prefix is the one reported", () => {
    const findings = findLiteralSecrets(
        { key: "sk-ant-api03-value", other: "sk-value" },
        "mcp",
    );

    expect(findings.map((finding) => finding.prefix)).toEqual([
        "sk-ant-",
        "sk-",
    ]);
});

test("the key name never decides: an innocuous value under a secret-sounding key passes", () => {
    expect(findLiteralSecrets({ token: "{env:TOKEN}", password: "" }, "mcp"))
        .toEqual([]);
});

test("a secret-shaped value under an innocuous key is still reported", () => {
    const findings = findLiteralSecrets({ label: "AKIAIOSFODNN7EXAMPLE" }, "mcp");

    expect(findings.map((finding) => finding.configPath)).toEqual(["label"]);
});

test("arrays and nested objects are walked", () => {
    const findings = findLiteralSecrets(
        { command: ["run", "--token", "xoxb-1-2-3"], nested: { deep: { at: "gho_x" } } },
        "mcp",
    );

    expect(findings.map((finding) => finding.configPath)).toEqual([
        "command[2]",
        "nested.deep.at",
    ]);
});

test("numbers, booleans, and null are not values that can hold a credential", () => {
    expect(findLiteralSecrets({ port: 8080, on: true, none: null }, "mcp"))
        .toEqual([]);
});

test("a config key that is itself a credential does not reach the reported path", () => {
    const findings = findLiteralSecrets(
        { "ghp_abcdefghijklmnop": "sk-placeholder" },
        "mcp",
    );

    expect(findings[0]?.configPath).toBe("ghp_...");
});

test("redaction keeps the prefix, drops the value, and flattens line breaks", () => {
    expect(redactSecretShapedText("auth failed for ghp_abcdefghijklmnop"))
        .toBe("auth failed for ghp_...");
    expect(redactSecretShapedText("first\n\nsecond")).toBe("first second");
});

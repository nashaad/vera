import { expect, test } from "bun:test";

import { sanitizeDiagnosticText } from "../../src/model/diagnostic-text.ts";

test("provider diagnostic text is bounded and redacts secrets and encoded data", () => {
    const encoded = "A".repeat(256);
    const wrapped = ["B".repeat(76), "C".repeat(76), "D".repeat(76)].join("\n");
    const wrappedDataUri = `data:image/png;base64,${"E".repeat(76)}\n${
        "F".repeat(76)
    }`;
    const diagnostic = sanitizeDiagnosticText([
        "authorization: Bearer live-token",
        "authorization: Basic dXNlcjpwYXNz",
        "api_key=sk-example12345678",
        `attachment=${encoded}`,
        wrapped,
        wrappedDataUri,
        "ordinary words ".repeat(500),
    ].join("; "));

    expect(diagnostic).not.toContain("live-token");
    expect(diagnostic).not.toContain("dXNlcjpwYXNz");
    expect(diagnostic).not.toContain("sk-example");
    expect(diagnostic).not.toContain(encoded);
    expect(diagnostic).not.toContain(wrapped);
    expect(diagnostic).not.toContain("F".repeat(76));
    expect(diagnostic).toContain("[REDACTED]");
    expect(diagnostic).toContain("[REDACTED_BINARY]");
    expect(diagnostic).toEndWith("…[TRUNCATED]");
});

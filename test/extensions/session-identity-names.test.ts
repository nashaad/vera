import { describe, expect, test } from "bun:test";

import {
    agentNameForFilename,
    agentNameKey,
    mintAgentName,
    parseAgentName,
} from "../../src/core-extensions/session-identity/names.ts";

describe("agent name format", () => {
    test("a bare name parses into slug and hex4", () => {
        expect(parseAgentName("frosty-frost:9f3a")).toEqual({
            slug: "frosty-frost",
            hex4: "9f3a",
        });
    });

    test("a purpose tail parses as decoration", () => {
        expect(parseAgentName("frosty-frost:9f3a:UAT-tester")).toEqual({
            slug: "frosty-frost",
            hex4: "9f3a",
            purpose: "UAT-tester",
        });
    });

    test("matching uses slug:hex4 only, never the purpose", () => {
        expect(agentNameKey("frosty-frost:9f3a:UAT-tester"))
            .toBe("frosty-frost:9f3a");
        expect(agentNameKey("frosty-frost:9f3a")).toBe("frosty-frost:9f3a");
    });

    test("text that is not a name yields no key", () => {
        expect(agentNameKey("boundary-agent")).toBeNull();
        expect(agentNameKey("a1b2c3d4-uuid-like")).toBeNull();
        expect(agentNameKey("frosty-frost:9f3")).toBeNull();
        expect(agentNameKey("frosty-frost:9F3A")).toBeNull();
    });

    test("a fourth field is malformed, not extra decoration", () => {
        expect(parseAgentName("a:9f3a:x:y")).toBeNull();
    });

    test("colons inside fields are rejected via the field patterns", () => {
        expect(parseAgentName("frosty frost:9f3a")).toBeNull();
        expect(parseAgentName("frosty-frost:9f3a:has space")).toBeNull();
        expect(parseAgentName("frosty-frost:9f3a:a/b")).toBeNull();
    });

    test("colons mangle to hyphens at filename boundaries", () => {
        expect(agentNameForFilename("frosty-frost:9f3a:UAT-tester"))
            .toBe("frosty-frost-9f3a-UAT-tester");
    });
});

describe("agent name minting", () => {
    test("a minted name is well formed and carries no purpose", () => {
        const name = mintAgentName(() => false);
        const parsed = parseAgentName(name);
        expect(parsed).not.toBeNull();
        expect(parsed!.purpose).toBeUndefined();
        expect(agentNameKey(name)).toBe(name);
    });

    test("minting skips a taken key rather than reissuing it", () => {
        const first = mintAgentName(() => false, fixedThenRandom());
        const second = mintAgentName(
            (key) => key === first,
            fixedThenRandom(),
        );
        expect(second).not.toBe(first);
        expect(parseAgentName(second)).not.toBeNull();
    });
});

/** Deterministic draws that change every call, to force one collision. */
function fixedThenRandom(): (bytes: number) => Buffer {
    let draw = 0;
    return (bytes: number): Buffer => {
        draw += 1;
        return Buffer.alloc(bytes, draw);
    };
}

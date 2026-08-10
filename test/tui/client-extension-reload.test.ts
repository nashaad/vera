import { expect, test } from "bun:test";

import {
    boundedExtensionReloadFailure,
    ClientExtensionReloadPartialFailure,
} from "../../clients/tui/client-extension-reload.ts";

test("client extension reload failures preserve the partial outcome", () => {
    const failure = new ClientExtensionReloadPartialFailure(
        "some",
        "some failed",
        ["test.sidebar"],
        ["missing: activation failed"],
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("ClientExtensionReloadPartialFailure");
    expect(failure.kind).toBe("some");
    expect(failure.loadedExtensionIds).toEqual(["test.sidebar"]);
    expect(failure.failures).toEqual(["missing: activation failed"]);
    expect(failure.message).toBe("some failed");
});

test("client extension reload failure messages are compact and bounded", () => {
    expect(boundedExtensionReloadFailure("  one\n two\tthree  "))
        .toBe("one two three");

    const bounded = boundedExtensionReloadFailure("x".repeat(300));
    expect(Array.from(bounded)).toHaveLength(240);
    expect(bounded.endsWith("…")).toBe(true);
});

import { expect, test } from "bun:test";

import {
    boundedExtensionReloadFailure,
    clientExtensionReloadFailed,
    clientExtensionReloadStarted,
    clientExtensionReloadSucceeded,
    ClientExtensionReloadPartialFailure,
    reloadTuiClientExtensions,
} from "../../clients/tui/client-extension-reload.ts";
import { createTuiClientExtensionHostController } from
    "../../clients/tui/client-extension-host.ts";
import type { ClientExtensionRegistry } from
    "../../src/extensions/client-registry.ts";

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

test("client extension reload outcomes keep status and notices together", () => {
    expect(clientExtensionReloadStarted()).toEqual({
        status: "reloading",
        loadedExtensionIds: [],
        failures: [],
    });
    expect(clientExtensionReloadSucceeded(["test.sidebar"])).toEqual({
        status: "success",
        loadedExtensionIds: ["test.sidebar"],
        failures: [],
    });

    const partial = clientExtensionReloadFailed(
        new ClientExtensionReloadPartialFailure(
            "some",
            "some failed: missing",
            ["test.sidebar"],
            ["missing activation failed"],
        ),
        [],
    );
    expect(partial.snapshot.status).toBe("partial");
    expect(partial.notice).toContain("some: some failed: missing");

    const failed = clientExtensionReloadFailed(
        new Error("network\nfailed"),
        ["old.extension"],
    );
    expect(failed.snapshot).toEqual({
        status: "failed",
        loadedExtensionIds: ["old.extension"],
        failures: ["network failed"],
    });
    expect(failed.notice).toBe("Extensions could not reload in the TUI: network failed");
});

test("client extension reload applies refreshed config before activation", async () => {
    const events: string[] = [];
    const host = createTuiClientExtensionHostController(
        async () => fakeRegistry(["old"], events),
        () => {},
    );
    await host.reload();
    const extension = {
        path: "/tmp/test-sidebar",
        enabled: true,
        config: {},
    } as const;

    const loaded = await reloadTuiClientExtensions({
        configuration: {
            disabledIncludedExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [],
        },
        refreshConfiguration: () => ({
            disabledIncludedExtensions: [
                "vera.model-presets",
                "vera.reasoning-cycle",
            ],
            clientExtensions: [extension],
        }),
        applyConfiguration(configuration) {
            events.push(`apply:${configuration.clientExtensions.length}`);
        },
        host,
        async start(_signal, extensions) {
            events.push(`start:${extensions.length}`);
            return fakeRegistry(["test.sidebar"], events);
        },
    });

    expect(loaded).toEqual(["test.sidebar"]);
    expect(events).toEqual(["apply:1", "close:old", "start:1"]);
    await host.close();
});

test("client extension reload reports loaded IDs when activation partially fails", async () => {
    const host = createTuiClientExtensionHostController(
        async () => fakeRegistry(["old"], []),
        () => {},
    );
    await host.reload();

    await expect(reloadTuiClientExtensions({
        configuration: {
            disabledIncludedExtensions: [],
            clientExtensions: [],
        },
        applyConfiguration() {},
        host,
        async start(_signal, _extensions, failures) {
            failures.push("missing\nactivation failed");
            return fakeRegistry(["test.sidebar"], []);
        },
    })).rejects.toMatchObject({
        kind: "some",
        loadedExtensionIds: ["test.sidebar"],
        failures: ["missing activation failed"],
    });
    await host.close();
});

function fakeRegistry(
    ids: readonly string[],
    events: string[],
): ClientExtensionRegistry {
    return {
        close: async () => {
            events.push(`close:${ids[0] ?? "empty"}`);
        },
        loadedExtensionIds: () => ids,
    } as unknown as ClientExtensionRegistry;
}

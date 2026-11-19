import { expect, test } from "bun:test";

import { deliverySender, extensionSourceName } from "../../clients/ui/src/session/deliverySource.ts";

test("@core a delivery from an extension names the extension, and one from a subagent keeps the subagent wording", () => {
    expect(deliverySender({ fromExtension: true, sourceAgentId: "vera.artifacts" }, undefined)).toBe("Artifacts");
    expect(deliverySender({ fromExtension: false, sourceAgentId: "sub-1" }, undefined)).toBe("A subagent");
    expect(deliverySender({ fromExtension: false, sourceAgentId: "sub-1" }, "Scout")).toBe("Scout");
});

test("an extension delivery ignores a session name even when a session shares its id", () => {
    expect(deliverySender({ fromExtension: true, sourceAgentId: "vera.artifacts" }, "Scout")).toBe("Artifacts");
});

test("@core a process delivery is titled with its label instead of its process id", () => {
    const text = "Crow checks the hold\nProcess p-aa2832eb (PID 4242). Exited with code 7.\nLast output:\ncrow found the map";
    expect(deliverySender({ fromExtension: true, sourceAgentId: "vera/process/p-aa2832eb", text }, undefined)).toBe("Crow checks the hold");
});

test("an extension's name is the last part of its id in words", () => {
    expect(extensionSourceName("vera.artifacts")).toBe("Artifacts");
    expect(extensionSourceName("acme.my-nest_box")).toBe("My nest box");
    expect(extensionSourceName("solo")).toBe("Solo");
    expect(extensionSourceName("")).toBe("");
});

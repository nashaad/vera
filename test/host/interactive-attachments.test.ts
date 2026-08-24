import { describe, expect, test } from "bun:test";

import {
    InteractiveAttachmentRegistry,
} from "../../src/host/interactive-attachments.ts";

describe("InteractiveAttachmentRegistry", () => {
    test("counts independent agents and releases each lease once", () => {
        const registry = new InteractiveAttachmentRegistry();
        const first = registry.open("agent-1", "client-1");
        const second = registry.open("agent-1", "client-1");
        const other = registry.open("agent-2", "client-2");

        expect(registry.clientCount(["agent-1"])).toBe(1);
        expect(registry.clientCount(["agent-1", "agent-2"])).toBe(2);
        expect(registry.clientCount(
            ["agent-1", "agent-2"],
            "client-1",
        )).toBe(1);
        expect(first.release()).toBe(1);
        expect(first.release()).toBe(1);
        expect(second.release()).toBe(0);
        expect(other.release()).toBe(0);
        expect(registry.clientCount(["agent-1", "agent-2"])).toBe(0);
    });
});

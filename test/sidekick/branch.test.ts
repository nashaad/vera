import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    decideSidekickSync,
    SIDE_CONVERSATION_BOUNDARY,
    SIDEKICK_APPROVAL_MODE,
    SIDEKICK_BUSY_NOTICE,
    SIDEKICK_EXTENSION_ID,
    SIDEKICK_LIFETIME,
    SIDEKICK_MENTION,
    sidekickBranchOptions,
    sidekickHostBranchOptions,
} from "../../src/sidekick/branch.ts";

const ROOT = join(import.meta.dir, "../..");

test("@core the boundary the model reads is the text the extension carried before it moved", () => {
    const digest = new Bun.CryptoHasher("sha256").update(SIDE_CONVERSATION_BOUNDARY).digest("hex");
    expect(digest).toBe("084575e05541953352342957a151778def0ee1d9ed47a27abdd0b4af68f7e39e");
    expect(SIDE_CONVERSATION_BOUNDARY.startsWith("Side conversation boundary.\n\n")).toBe(true);
    expect(SIDE_CONVERSATION_BOUNDARY.endsWith("without disrupting the primary conversation.")).toBe(true);
});

test("@core a sidekick is a readonly, ephemeral branch that hides what it inherits and opens on the hidden boundary", () => {
    expect(sidekickBranchOptions()).toEqual({
        approvalMode: "readonly",
        attachmentLifetime: "ephemeral",
        hideInheritedMessages: true,
        initialMessages: [{ role: "user", text: SIDE_CONVERSATION_BOUNDARY, hidden: true, compactionBarrier: true }],
    });
    expect(SIDEKICK_MENTION).toBe("sidekick");
});

test("@core the host's branch options carry the same boundary, hidden from the transcript and fenced from compaction", () => {
    const options = sidekickHostBranchOptions();
    expect(options.approvalMode).toBe(SIDEKICK_APPROVAL_MODE);
    expect(options.lifetime).toBe(SIDEKICK_LIFETIME);
    expect(options.hideInheritedMessages).toBe(true);
    expect(options.initialMessages).toEqual([{
        role: "user",
        content: [{ type: "text", text: SIDE_CONVERSATION_BOUNDARY }],
        internal: true,
        compactionBarrier: true,
    }]);
    expect(options.initialMessages[0]?.content[0]).toMatchObject({ text: sidekickBranchOptions().initialMessages[0].text });
});

test("@core a sync outcome becomes ok, stale or busy, and the ones that cannot go on throw", () => {
    expect(decideSidekickSync("synced")).toBe("ok");
    expect(decideSidekickSync("unchanged")).toBe("ok");
    expect(decideSidekickSync("stale_cursor")).toBe("stale");
    expect(decideSidekickSync("stale_cursor", true)).toBe("stale");
    expect(decideSidekickSync("busy")).toBe("busy");
    expect(decideSidekickSync("busy", true)).toBe("ok");
    expect(() => decideSidekickSync("not_found")).toThrow("BTW primary context is unavailable");
    expect(() => decideSidekickSync("failed")).toThrow("BTW primary context could not be synchronized");
    expect(SIDEKICK_BUSY_NOTICE).toBe("BTW context can sync only between turns");
});

test("@core the extension that offers /btw has the id the desktop gates on, and takes its options from this module", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "extensions/btw/vera.extension.json"), "utf8")) as { id: string };
    expect(manifest.id).toBe(SIDEKICK_EXTENSION_ID);
    const source = readFileSync(join(ROOT, "extensions/btw/extension.ts"), "utf8");
    expect(source).toContain("../../src/sidekick/branch.ts");
    expect(source).not.toContain("Side conversation boundary");
});

test("@core the desktop opens the sidekick through the same module", () => {
    const source = readFileSync(join(ROOT, "clients/desktop/src/sidekick-requests.ts"), "utf8");
    expect(source).toContain("../../../src/sidekick/branch.ts");
    expect(source).toContain("sidekickHostBranchOptions()");
    expect(source).not.toContain("Side conversation boundary");
});

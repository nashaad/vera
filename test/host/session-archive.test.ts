import { expect, test } from "bun:test";

import { createSessionArchiveIndex } from "../../src/host/session-archive.ts";
import { pageSessionListing } from "../../src/host/session-listing.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry/support.ts";

function summary(
    id: string,
    updatedAt: string,
    options: { readonly parentId?: string; readonly archived?: boolean } = {},
): RegisteredAgentSummary {
    return {
        id,
        workspace: "/workspace",
        session_path: `/sessions/${id}.jsonl`,
        kind: "interactive",
        status: "completed",
        live: false,
        updated_at: updatedAt,
        ...(options.parentId === undefined ? {} : { parent_id: options.parentId }),
        ...(options.archived === undefined ? {} : { archived: options.archived }),
    };
}

test("archived ancestry is included when its parent is outside the newest page", () => {
    const parent = summary("root", "2026-01-01T00:00:00.000Z", { archived: true });
    const child = summary("child", "2026-02-01T00:00:00.000Z", { parentId: parent.id });
    const others = Array.from({ length: 50 }, (_, index) =>
        summary(`other-${index}`, `2026-01-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`)
    );
    const summaries = [parent, child, ...others];
    const archiveIndex = createSessionArchiveIndex(summaries);
    const page = pageSessionListing(summaries, { limit: 50, order: "recent" });
    const rows = page.agents.map((agent) => ({
        ...agent,
        archived: archiveIndex.effectiveArchived(agent.id),
    }));

    expect(page.agents.some((agent) => agent.id === parent.id)).toBe(false);
    expect(rows.find((agent) => agent.id === child.id)?.archived).toBe(true);
});

test("nested requests resolve to the family root and include every descendant", () => {
    const summaries = [
        summary("root", "2026-01-01T00:00:00.000Z"),
        summary("child", "2026-01-02T00:00:00.000Z", { parentId: "root" }),
        summary("grandchild", "2026-01-03T00:00:00.000Z", { parentId: "child" }),
        summary("sibling", "2026-01-04T00:00:00.000Z", { parentId: "root" }),
        summary("other", "2026-01-05T00:00:00.000Z"),
    ];

    const archiveIndex = createSessionArchiveIndex(summaries);
    const family = archiveIndex.family("grandchild");
    expect(archiveIndex.rootAgentId("grandchild")).toBe("root");
    expect(family.map((member) => member.id).sort()).toEqual([
        "child", "grandchild", "root", "sibling",
    ]);
});

test("unarchiving the root clears inherited archive state for every descendant", () => {
    const summaries = [
        summary("root", "2026-01-01T00:00:00.000Z", { archived: false }),
        summary("child", "2026-01-02T00:00:00.000Z", { parentId: "root", archived: true }),
    ];
    const archiveIndex = createSessionArchiveIndex(summaries);
    expect(archiveIndex.effectiveArchived("child")).toBe(false);
});

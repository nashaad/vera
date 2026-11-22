import { expect, test } from "bun:test";

import { buildItems, latchedFolder } from "../../clients/ui/src/customize/catalog.ts";
import { folderReadOutcome, LOADING, readingStartState, type FolderReadState } from "../../clients/ui/src/customize/folderReading.ts";
import type { FolderCustomizationsAnswer } from "../../clients/ui/src/protocol/bridge.ts";

const ANSWER: FolderCustomizationsAnswer = {
    ok: true,
    skills: [{ name: "nest-check", description: "Checks the nest", manualOnly: false }],
    startsOn: "default",
    agents: [
        { name: "default", scope: "extension", writable: false },
        { name: "plan", scope: "project", writable: true, description: "Plans before it edits" },
    ],
    sources: [
        { id: "skills:nest-check", category: "skills", name: "nest-check", description: "Checks the nest", scope: "project", content: "Body", editable: true },
        { id: "instructions:/nest/AGENTS.md", category: "instructions", name: "AGENTS.md", description: "Project instructions and imports", scope: "project", content: "Caw", editable: true },
    ],
    warnings: ["Skipped broken.md"],
};

test("@core an answer from the host is a ready reading and a failure keeps its reason for the page", () => {
    expect(folderReadOutcome(ANSWER)).toEqual({ phase: "ready", reading: ANSWER });
    expect(folderReadOutcome({ ok: false, reason: "Vera needs a restart to read what this folder loads." }))
        .toEqual({ phase: "failed", reason: "Vera needs a restart to read what this folder loads." });
});

test("@core a reading read with no session builds the project's items beside the home's", () => {
    const items = buildItems(ANSWER, []);
    expect(items.find((item) => item.name === "nest-check")).toMatchObject({ kind: "skills", group: "This folder" });
    expect(items.find((item) => item.name === "plan")).toMatchObject({ kind: "agents", group: "This folder", current: false });
    expect(items.find((item) => item.name === "default")).toMatchObject({ kind: "agents", current: true });
    expect(items.find((item) => item.name === "AGENTS.md")).toMatchObject({ kind: "instructions", group: "This folder" });
});

test("@core a re-read that starts over a ready list keeps the list until the answer arrives", () => {
    const ready: FolderReadState = { phase: "ready", reading: ANSWER };
    expect(readingStartState(ready)).toBe(ready);
});

test("@core a first read and a read after a failure start from loading", () => {
    expect(readingStartState(LOADING)).toEqual({ phase: "loading" });
    expect(readingStartState({ phase: "failed", reason: "The host did not answer." })).toEqual({ phase: "loading" });
});

test("@core the folder latch keeps its folder when the folder order changes", () => {
    const first = latchedFolder(undefined, ["/a", "/b"]);
    expect(first).toBe("/a");
    expect(latchedFolder(first, ["/b", "/a"])).toBe("/a");
});

test("@core the folder latch takes the first folder when it had none", () => {
    expect(latchedFolder(undefined, [])).toBeUndefined();
    expect(latchedFolder(undefined, ["/c"])).toBe("/c");
});

test("@core a user pick replaces the latched folder", () => {
    expect(latchedFolder("/a", ["/b", "/a"])).toBe("/a");
    expect(latchedFolder("/b", ["/b", "/a"])).toBe("/b");
});

import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiSettingsPickerView,
    emptyPickerMessage,
    handleTuiSettingsPickerKey,
    pickerFooterText,
    startTuiImportPicker,
    updateTuiSettingsPickerSearch,
} from "../../clients/tui/settings-picker.ts";
import type { ImportableSessionListing } from "../../src/host/session-import-service.ts";

const now = new Date("2026-09-17T12:00:00.000Z");

const listing: ImportableSessionListing = {
    truncated: false,
    sessions: [
        {
            tool: "codex",
            path: "/home/u/.codex/sessions/2026/09/17/rollout-a.jsonl",
            source_session_id: "cx-1",
            workspace: "/work/alpha",
            updated_at: "2026-09-17T11:55:00.000Z",
            first_message: "add a test for the parser",
        },
        {
            tool: "claude-code",
            path: "/home/u/.claude/projects/-work-alpha/cc-1.jsonl",
            source_session_id: "cc-1",
            workspace: "/work/alpha",
            updated_at: "2026-09-16T12:00:00.000Z",
            title: "Fix the build",
            first_message: "fix the build",
            imported_session_id: "vera-1",
        },
    ],
};

test("rows name the tool, the title or first message, and whether it was imported", () => {
    const state = startTuiImportPicker({ scope: "folder", workspace: "/work/alpha", listing, now });
    expect(state.title).toBe("Import a conversation");
    expect(state.subtitle).toBe("This folder: /work/alpha");
    expect(state.options.map((option) => [option.value, option.label])).toEqual([
        [listing.sessions[0]!.path, "Codex · add a test for the parser"],
        [listing.sessions[1]!.path, "Claude Code · Fix the build · imported"],
    ]);
});

test("a truncated listing says how many it shows", () => {
    const state = startTuiImportPicker({
        scope: "all",
        workspace: "/work/alpha",
        listing: { ...listing, truncated: true },
        now,
    });
    expect(state.subtitle).toBe("All folders · newest 2");
});

test("enter picks the file and ctrl+g asks for the other scope", () => {
    const folder = startTuiImportPicker({ scope: "folder", workspace: "/work/alpha", listing, now });
    expect(handleTuiSettingsPickerKey(folder, { name: "enter" }).selection)
        .toEqual({ kind: "session_import", path: listing.sessions[0]!.path });
    expect(handleTuiSettingsPickerKey(folder, { name: "g", ctrl: true }))
        .toMatchObject({ importScope: "all", handled: true });
    const all = startTuiImportPicker({ scope: "all", workspace: "/work/alpha", listing, now });
    expect(handleTuiSettingsPickerKey(all, { name: "g", ctrl: true }))
        .toMatchObject({ importScope: "folder", handled: true });
});

test("search matches the first message behind a title", () => {
    const state = updateTuiSettingsPickerSearch(
        startTuiImportPicker({ scope: "folder", workspace: "/work/alpha", listing, now }),
        "fix the build",
    ).state!;
    expect(state.options.map((option) => option.value)).toEqual([listing.sessions[1]!.path]);
});

test("empty states say what to do next", () => {
    const loading = startTuiImportPicker({ scope: "folder", workspace: "/w" });
    expect(emptyPickerMessage(loading)).toBe("Looking for Claude Code and Codex sessions…");
    const empty = { sessions: [], truncated: false };
    expect(emptyPickerMessage(startTuiImportPicker({ scope: "folder", workspace: "/w", listing: empty })))
        .toBe("No Claude Code or Codex sessions in this folder. Press ctrl+g for all folders.");
    expect(emptyPickerMessage(startTuiImportPicker({ scope: "all", workspace: "/w", listing: empty })))
        .toBe("No Claude Code or Codex sessions found.");
});

test("the picker renders rows, the scope and the keys", async () => {
    const setup = await createTestRenderer({ width: 100, height: 20 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    try {
        const state = startTuiImportPicker({ scope: "folder", workspace: "/work/alpha", listing, now });
        expect(pickerFooterText(state)).toBe("↑↓ ^d^u move · ⏎ import · ^g folder/all · esc close");
        view.update(state);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Import a conversation");
        expect(frame).toContain("This folder: /work/alpha");
        expect(frame).toContain("Codex · add a test for the parser");
        expect(frame).toContain("Claude Code · Fix the build · imported");
        expect(frame).toContain("^g folder/all");
    } finally {
        setup.renderer.destroy();
    }
});

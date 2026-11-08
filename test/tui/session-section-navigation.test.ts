import { expect, test } from "bun:test";
import {
    handleTuiSettingsPickerKey,
    handleTuiSettingsPickerScroll,
    moveTuiSettingsPickerPointer,
    startTuiSessionPicker,
    updateTuiSettingsPickerSearch,
} from "../../clients/tui/settings-picker.ts";

function picker() {
    return startTuiSessionPicker([
        {
            id: "current", kind: "interactive", status: "idle", live: true,
            workspace: "/work/vera", session_path: "/sessions/current.jsonl",
            title: "Open conversation", has_user_content: true,
            updated_at: "2026-11-08T09:00:00.000Z",
        },
        {
            id: "first", kind: "interactive", status: "idle", live: false,
            workspace: "/work/vera", session_path: "/sessions/first.jsonl",
            title: "Alpha recent", has_user_content: true,
            updated_at: "2026-11-08T08:00:00.000Z",
        },
        {
            id: "second", kind: "interactive", status: "idle", live: false,
            workspace: "/work/vera", session_path: "/sessions/second.jsonl",
            title: "Beta recent", has_user_content: true,
            updated_at: "2026-11-08T07:00:00.000Z",
        },
    ], "current", false, new Date("2026-11-08T10:00:00.000Z"), false, [], "stop", true);
}

test("resume navigation skips inert section headings in both directions", () => {
    const start = picker();
    expect(start.options[start.selectedIndex]?.sessionId).toBe("current");
    const down = handleTuiSettingsPickerKey(start, { name: "down" }).state!;
    expect(down.options[down.selectedIndex]?.sessionId).toBe("first");
    expect(handleTuiSettingsPickerKey(down, { name: "enter" }).selection)
        .toMatchObject({ kind: "session", sessionId: "first" });
    const up = handleTuiSettingsPickerKey(down, { name: "up" }).state!;
    expect(up.options[up.selectedIndex]?.sessionId).toBe("current");
    expect(handleTuiSettingsPickerKey(up, { name: "up" }).state!.selectedIndex)
        .toBe(up.selectedIndex);
});

test("filtering starts on the first real row beneath a heading", () => {
    const filtered = updateTuiSettingsPickerSearch(picker(), "alpha").state!;
    expect(filtered.options[0]?.section).toBe("RECENT");
    expect(filtered.options[filtered.selectedIndex]?.sessionId).toBe("first");
    expect(handleTuiSettingsPickerKey(filtered, { name: "enter" }).selection)
        .toMatchObject({ kind: "session", sessionId: "first" });
});

test("paging, wheel movement and a pointer cannot select an inert heading", () => {
    const start = picker();
    const heading = start.options.findIndex((option) => option.section === "RECENT");
    const page = handleTuiSettingsPickerKey(start, { name: "d", ctrl: true }, 2).state!;
    expect(page.options[page.selectedIndex]?.sessionId).toBe("first");
    const wheel = handleTuiSettingsPickerScroll(start, { direction: "down", delta: 1 }).state!;
    expect(wheel.options[wheel.selectedIndex]?.sessionId).toBe("first");
    const pointer = moveTuiSettingsPickerPointer(start, heading);
    expect(pointer.selectedIndex).toBe(start.selectedIndex);
});

test("other picker lists also skip inert headings and start a search on a row", () => {
    const options = [
        { value: "heading-a", label: "match heading A", description: "", section: "A" },
        { value: "row-a", label: "match row A", description: "" },
        { value: "heading-b", label: "match heading B", description: "", section: "B" },
        { value: "row-b", label: "match row B", description: "" },
    ];
    const state = { kind: "theme" as const, allOptions: options, options, selectedIndex: 1, query: "" };
    const next = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
    expect(next.options[next.selectedIndex]?.value).toBe("row-b");
    const filtered = updateTuiSettingsPickerSearch(state, "match").state!;
    expect(filtered.options[filtered.selectedIndex]?.value).toBe("row-a");
});

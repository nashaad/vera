import { expect, test } from "bun:test";

import { fitFooter, type FooterItemContents } from "../../clients/tui/footer-fit.ts";
import { footerItemContents, type FooterItemFacts } from "../../clients/tui/footer-items.ts";
import { DEFAULT_FOOTER_LAYOUT, footerRowCount, type FooterItemId, type FooterLayout } from "../../clients/tui/footer-layout.ts";
import type { TuiStatusChunk } from "../../clients/tui/status.ts";

const IDLE_KEYS = "Ctrl+P commands · Ctrl+X h keys";
const STRIP: TuiStatusChunk[] = [..."▓▓▓▓▓▓"].map((glyph) => ({ text: glyph, tone: "accent" }));

function facts(working: boolean, overrides: Partial<FooterItemFacts> = {}): FooterItemFacts {
    return {
        status: { text: working ? "thinking · 4s" : "ready", color: "#ffffff" },
        keys: working ? "Ctrl+X h keys" : IDLE_KEYS,
        limits: ["5h 72% left · week 96% left", "5h 72% · week 96%", "5h 72%"],
        place: { workspace: "/srv/crows-nest/harbour/black-sail", branch: "plunder" },
        activity: working ? STRIP : [],
        activityColumns: STRIP.length,
        panes: ["crow mode", "split"],
        ...overrides,
    };
}

function rows(layout: FooterLayout, contents: FooterItemContents, working: boolean, width: number): string[] {
    return fitFooter(layout, contents, working, width).rows
        .map((row) => row.map((chunk) => chunk.text).join(""));
}

function withSlots(slots: readonly (FooterItemId | null)[]): FooterLayout {
    return { ...DEFAULT_FOOTER_LAYOUT, slots };
}

test("a turn spreads the first row from edge to edge with even gaps", () => {
    const [first] = rows(DEFAULT_FOOTER_LAYOUT, footerItemContents(facts(true)), true, 80);
    expect(first).toBe(`thinking · 4s${" ".repeat(14)}5h 72% left · week 96% left${" ".repeat(13)}Ctrl+X h keys`);
});

test("idle, the live status reads ready and the key hints lead with commands", () => {
    const [first] = rows(DEFAULT_FOOTER_LAYOUT, footerItemContents(facts(false)), false, 80);
    expect(first).toBe(`ready${" ".repeat(9)}5h 72% left · week 96% left${" ".repeat(8)}${IDLE_KEYS}`);
});

test("idle, a lone item keeps to the side its slot is on", () => {
    const left = withSlots(["status", null, null, "keys", "folder", "branch", "panes", "activity", "limits", null, null, null]);
    expect(rows(left, footerItemContents(facts(false)), false, 80)[2]).toBe("5h 72% left · week 96% left");
    const right = withSlots(["status", null, null, "keys", "folder", "branch", "panes", "activity", null, null, "limits", null]);
    const third = rows(right, footerItemContents(facts(false)), false, 80)[2]!;
    expect(third.endsWith("5h 72% left · week 96% left")).toBe(true);
    expect(Bun.stringWidth(third)).toBe(80);
});

test("the strip holds its cell while idle, so nothing shifts when a turn starts", () => {
    const idle = fitFooter(DEFAULT_FOOTER_LAYOUT, footerItemContents(facts(false)), false, 80);
    const working = fitFooter(DEFAULT_FOOTER_LAYOUT, footerItemContents(facts(true)), true, 80);
    for (const item of ["folder", "branch", "activity", "panes"] as const) {
        expect(working.spans.get(item)).toEqual(idle.spans.get(item));
    }
    expect(idle.fates.get("activity")).toBe("empty");
    expect(working.fates.get("activity")).toBe("shown");
});

test("a full row shortens the highest slot first, then drops it, never the key hints", () => {
    const contents = footerItemContents(facts(true));
    const shortened = fitFooter(DEFAULT_FOOTER_LAYOUT, contents, true, 50);
    expect(shortened.fates.get("keys")).toBe("shown");
    expect(shortened.fates.get("limits")).toBe("shortened");
    expect(shortened.fates.get("status")).toBe("shown");

    const crowded = fitFooter(DEFAULT_FOOTER_LAYOUT, contents, true, 20);
    expect(crowded.fates.get("limits")).toBe("no room");
    expect(crowded.fates.get("status")).toBe("no room");
    expect(crowded.fates.get("keys")).toBe("shown");
    expect(crowded.rows[0]!.map((chunk) => chunk.text).join("")).toBe(`${" ".repeat(7)}Ctrl+X h keys`);
});

test("the last item standing is cut with an ellipsis", () => {
    const layout = withSlots(["status", null, null, null, "folder", "branch", "activity", "panes", null, "limits", null, "keys"]);
    const fit = fitFooter(layout, footerItemContents(facts(true, {
        status: { text: "[DEV a-very-long-dev-instance-label] thinking · 4s", color: "#ffffff" },
    })), true, 20);
    expect(fit.fates.get("status")).toBe("cut");
    expect(fit.rows[0]!.map((chunk) => chunk.text).join("")).toBe("[DEV a-very-long-de…");
});

test("hidden and empty items say why they are missing", () => {
    const layout: FooterLayout = { ...DEFAULT_FOOTER_LAYOUT, hidden: ["branch"] };
    const fit = fitFooter(layout, footerItemContents(facts(false)), false, 80);
    expect(fit.fates.get("branch")).toBe("hidden");
    expect(fit.fates.get("activity")).toBe("empty");
    expect(fit.rows[1]!.map((chunk) => chunk.text).join("")).not.toContain("plunder");
});

test("the key hints cannot be hidden", () => {
    const layout: FooterLayout = { ...DEFAULT_FOOTER_LAYOUT, hidden: ["keys"] };
    const fit = fitFooter(layout, footerItemContents(facts(true)), true, 80);
    expect(fit.fates.get("keys")).toBe("shown");
});

test("the row count is the last row holding a shown item", () => {
    expect(footerRowCount(DEFAULT_FOOTER_LAYOUT)).toBe(2);
    expect(footerRowCount({ ...DEFAULT_FOOTER_LAYOUT, hidden: ["folder", "branch", "panes", "activity"] })).toBe(1);
    const gap = withSlots(["status", "limits", null, "keys", null, null, null, null, "folder", "branch", "panes", "activity"]);
    expect(footerRowCount(gap)).toBe(3);
    const drawn = rows(gap, footerItemContents(facts(false)), false, 80);
    expect(drawn).toHaveLength(3);
    expect(drawn[1]).toBe("");
});

test("no limits closes the gap between the live status and the key hints", () => {
    const [first] = rows(DEFAULT_FOOTER_LAYOUT, footerItemContents(facts(false, { limits: [] })), false, 80);
    expect(first).toBe(`ready${" ".repeat(80 - 5 - IDLE_KEYS.length)}${IDLE_KEYS}`);
});

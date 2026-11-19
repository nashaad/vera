import { expect, test } from "bun:test";
import { hitDrawing, translateDrawing } from "../../extensions/browser-annotate/geometry.ts";
import type { Drawing } from "../../extensions/browser-annotate/geometry.ts";

const drawing = (kind: Drawing["kind"]): Drawing => ({ kind, points: [{ x: 10, y: 10 }, { x: 110, y: 60 }], color: "red", width: 3, label: "crow" });
const hit = (item: Drawing, x: number, y: number) => hitDrawing(item, { x, y }, () => 30);

test("hit tests mark geometry rather than bounding boxes", () => {
    expect(hit(drawing("line"), 60, 35)).toBe(true);
    expect(hit(drawing("line"), 60, 10)).toBe(false);
    expect(hit(drawing("rectangle"), 60, 10)).toBe(true);
    expect(hit(drawing("rectangle"), 60, 35)).toBe(false);
    expect(hit(drawing("ellipse"), 60, 10)).toBe(true);
    expect(hit(drawing("ellipse"), 60, 35)).toBe(false);
    expect(hit(drawing("step"), 10, 10)).toBe(true);
    expect(hit(drawing("text"), 20, 5)).toBe(true);
    expect(hit(drawing("pen"), 60, 35)).toBe(true);
    expect(hit(drawing("arrow"), 110, 60)).toBe(true);
    const flat = { ...drawing("ellipse"), points: [{ x: 10, y: 10 }, { x: 110, y: 10.1 }] };
    expect(hit(flat, 1000, 10)).toBe(false);
    expect(hit({ ...flat, points: [{ x: 10, y: 10 }, { x: 110, y: 10 }] }, 60, 10)).toBe(true);
});

test("translation leaves prior snapshots unchanged", () => {
    const original = drawing("arrow");
    const moved = translateDrawing(original, 8, -3);
    expect(moved.points).toEqual([{ x: 18, y: 7 }, { x: 118, y: 57 }]);
    expect(original.points).toEqual([{ x: 10, y: 10 }, { x: 110, y: 60 }]);
    expect(moved.color).toBe(original.color);
});

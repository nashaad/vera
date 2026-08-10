import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    renderTuiActivityAnimation,
    renderTuiActivityPulse,
} from "../../clients/tui/activity-pulse.ts";

const colors = {
    active: "#7AA2F7",
    trail: "#B8B6D9",
    inactive: "#5C6370",
    text: "#7AA2F7",
};

test("TUI activity pulse advances an ActiveGrid-style shaded rail", () => {
    const pulse = renderTuiActivityPulse(4, "thinking · 2s", colors);
    expect(plainText(pulse)).toBe("░░▒▓█▓▒ thinking · 2s");
    expect(pulse.chunks.map((chunk) => String(chunk.fg))).toEqual([
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.48, 0.64, 0.97, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.48, 0.64, 0.97, 1.00)",
    ]);
    expect(plainText(renderTuiActivityPulse(5, "thinking · 2s", colors)))
        .toBe("▒░░▒▓█▓ thinking · 2s");
});

test("TUI activity pulse wraps cleanly in both directions", () => {
    expect(plainText(renderTuiActivityPulse(7, "working", colors)))
        .toBe("█▓▒░░▒▓ working");
    expect(plainText(renderTuiActivityPulse(-1, "working", colors)))
        .toBe("▓▒░░▒▓█ working");
});

test("TUI symmetric wave mirrors inward and outward by default", () => {
    expect(plainText(renderTuiActivityAnimation(
        "symmetric_wave",
        0,
        "thinking",
        colors,
    ))).toBe("▪···▪ thinking");
    expect(plainText(renderTuiActivityAnimation(
        "symmetric_wave",
        2,
        "thinking",
        colors,
    ))).toBe("··▪·· thinking");
    expect(plainText(renderTuiActivityAnimation(
        "symmetric_wave",
        3,
        "thinking",
        colors,
    ))).toBe("·▪·▪· thinking");
});

test("TUI activity animation can use Braille or disable motion", () => {
    expect(plainText(renderTuiActivityAnimation(
        "braille",
        1,
        "working",
        colors,
    ))).toBe("⠙ working");
    expect(plainText(renderTuiActivityAnimation(
        "off",
        100,
        "working",
        colors,
    ))).toBe("working");
});

test("TUI shimmer pulses a bullet while a highlight crosses the text", () => {
    const shimmer = renderTuiActivityAnimation("shimmer", 12, "working", colors);
    expect(plainText(shimmer)).toBe("• working");
    expect(shimmer.chunks.map((chunk) => String(chunk.fg))).toEqual([
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.48, 0.64, 0.97, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.72, 0.71, 0.85, 1.00)",
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.36, 0.39, 0.44, 1.00)",
    ]);
    const dimShimmer = renderTuiActivityAnimation(
        "shimmer",
        15,
        "working 🚀",
        colors,
    );
    expect(plainText(dimShimmer)).toBe("• working 🚀");
    expect(String(dimShimmer.chunks[0]?.fg))
        .toBe("rgba(0.36, 0.39, 0.44, 1.00)");
});

test("TUI activity animation accepts a numeric width", () => {
    expect(plainText(renderTuiActivityAnimation(
        "symmetric_wave",
        0,
        "working",
        colors,
        7,
    ))).toBe("▪·····▪ working");
    expect(plainText(renderTuiActivityAnimation(
        "symmetric_wave",
        0,
        "working",
        colors,
        2,
    ))).toBe("▪▪ working");
    expect(plainText(renderTuiActivityAnimation(
        "conveyor",
        2,
        "working",
        colors,
        5,
    ))).toBe("▒▓█▓▒ working");
});

function plainText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

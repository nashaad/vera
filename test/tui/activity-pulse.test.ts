import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";

import {
    renderTuiActivityAnimation,
    renderTuiActivityPulse,
    renderTuiSpokes,
    transcriptShimmerFrame,
} from "../../clients/tui/activity-pulse.ts";

const colors = {
    active: "#7AA2F7",
    trail: "#B8B6D9",
    inactive: "#5C6370",
    text: "#7AA2F7",
};

test("transcript shimmer advances every 40ms independently of footer settings", () => {
    expect(transcriptShimmerFrame(0)).toBe(0);
    expect(transcriptShimmerFrame(39)).toBe(0);
    expect(transcriptShimmerFrame(40)).toBe(1);
    expect(transcriptShimmerFrame(160)).toBe(4);
});

const shimmerColors = {
    ...colors,
    trail: "#24283B",
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

test("TUI shimmer diffuses a dark band across the bold activity verb", () => {
    const shimmer = renderTuiActivityAnimation(
        "shimmer",
        12,
        "working · 2s · esc stop",
        shimmerColors,
    );
    expect(plainText(shimmer)).toBe("•• working · 2s · esc stop");
    expect(shimmer.chunks.map((chunk) => String(chunk.fg))).toEqual([
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.36, 0.39, 0.44, 1.00)",
        "rgba(0.26, 0.33, 0.50, 1.00)",
        "rgba(0.24, 0.29, 0.44, 1.00)",
        "rgba(0.23, 0.28, 0.42, 1.00)",
        "rgba(0.24, 0.29, 0.44, 1.00)",
        "rgba(0.26, 0.33, 0.50, 1.00)",
        "rgba(0.30, 0.39, 0.59, 1.00)",
        "rgba(0.35, 0.45, 0.69, 1.00)",
        "rgba(0.48, 0.64, 0.97, 1.00)",
    ]);
    const dimShimmer = renderTuiActivityAnimation(
        "shimmer",
        15,
        "working 🚀",
        shimmerColors,
    );
    expect(plainText(dimShimmer)).toBe("•• working 🚀");
    expect(String(dimShimmer.chunks[0]?.fg))
        .toBe("rgba(0.36, 0.39, 0.44, 1.00)");
    expect(shimmer.chunks.slice(2, 9).every((chunk) => chunk.attributes === 1))
        .toBe(true);
    expect(shimmer.chunks.at(-1)?.attributes).toBe(0);
    expect(plainText(renderTuiActivityAnimation(
        "shimmer",
        0,
        " waiting",
        shimmerColors,
    ))).toBe("••  waiting");
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

test("TUI spokes spin a one-cell four-spoke glyph", () => {
    expect([0, 1, 2, 3, 4].map((frame) => plainText(
        renderTuiSpokes(frame, "4 subagents running", colors),
    ))).toEqual([
        "│ 4 subagents running",
        "/ 4 subagents running",
        "─ 4 subagents running",
        "\\ 4 subagents running",
        "│ 4 subagents running",
    ]);
});


function plainText(styled: StyledText): string {
    return styled.chunks.map((chunk) => chunk.text).join("");
}

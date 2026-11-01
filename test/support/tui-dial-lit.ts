import type { TuiTestSession } from "./tui-harness.ts";

// The live HUD paints the picked value with a background, not the › glyph the plain strip uses.
export function litDialValue(
    session: TuiTestSession,
    lane: "AGENT" | "ACCESS",
): string | undefined {
    const line = session.captureSpans().lines.find((row) =>
        row.spans.map((span) => span.text).join("").includes(lane)
    );
    const label = line?.spans.findIndex((span) => span.text.includes(lane)) ?? -1;
    if (line === undefined || label < 0) return undefined;
    const plain = line.spans[label]!.bg;
    const lit = line.spans.slice(label + 1).find((span) =>
        span.text.trim().length > 0 && !span.bg.equals(plain)
    );
    return lit?.text.trim();
}

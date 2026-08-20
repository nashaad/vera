import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { buildDashboardReport } from "../../examples/extensions/context/dashboard-report.ts";
import {
    dashboardWidth,
    renderDashboard,
} from "../../examples/extensions/context/dashboard-view.ts";
import {
    renderTuiExperimentalView,
    validateTuiExperimentalNode,
} from "../../clients/tui/experimental-tui-renderer.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import type { VeraClientSession } from "../../src/sdk/extensions.ts";

const SESSIONS: readonly VeraClientSession[] = [
    {
        id: "alpha",
        title: "refactor the host",
        workspace: "/workspace/vera",
        kind: "interactive",
        status: "working",
        live: true,
        updatedAt: "2026-08-20T12:00:00.000Z",
        facts: {
            model: { provider: "anthropic", model: "opus" },
            context: { tokens: 41_000, capacity: 200_000, estimated: false },
            usage: {
                rows: [{
                    provider: "anthropic",
                    model: "opus",
                    calls: 12,
                    durationMs: 40_000,
                    inputTokens: 90_000,
                    outputTokens: 4_000,
                    cachedInputTokens: 60_000,
                    reasoningTokens: 900,
                    totalTokens: 94_900,
                    cost: 1.25,
                    callsWithoutCost: 0,
                }],
            },
        },
    },
    {
        id: "beta",
        title: "unpriced local run",
        workspace: "/workspace/scratch",
        kind: "background",
        status: "failed",
        live: false,
        updatedAt: "2026-08-20T11:00:00.000Z",
        facts: {
            model: { provider: "ollama", model: "qwen" },
            failure: {
                at: "2026-08-20T11:00:00.000Z",
                provider: "ollama",
                model: "qwen",
                kind: "http_error",
                detail: "connection refused",
            },
        },
    },
];

test("dashboard column budget steps at 120, 80, and 60 columns", () => {
    expect(dashboardWidth(120)).toBe("wide");
    expect(dashboardWidth(80)).toBe("medium");
    expect(dashboardWidth(60)).toBe("narrow");
});

test("the dashboard node tree stays inside the declarative bounds", () => {
    const report = buildDashboardReport(SESSIONS, {
        sort: "context",
        partial: false,
    });
    for (const columns of [120, 80, 60]) {
        expect(() =>
            validateTuiExperimentalNode(
                renderDashboard(report, viewState(), columns),
            )
        ).not.toThrow();
    }
});

test("dashboard OpenTUI rendering adapts at 120, 80, and 60 columns", async () => {
    const report = buildDashboardReport(SESSIONS, {
        sort: "context",
        partial: false,
        totalSessions: 9,
    });
    for (const [width, height] of [[120, 44], [80, 44], [60, 44]] as const) {
        const setup = await createTestRenderer({ width, height });
        const root = renderTuiExperimentalView({
            renderer: setup.renderer,
            theme: VERA_TUI_THEME,
            node: renderDashboard(report, viewState(), width),
            id: `dashboard-${width}`,
            overlay: true,
            title: "Vera dashboard",
            focus() {},
            triggerAction() {},
        });
        setup.renderer.root.add(root);
        try {
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Vera dashboard");
            expect(frame).toContain("2 of 9 sessions");
            expect(frame).toContain("Recent failures");
            expect(frame).toContain("refactor the host");
            // Only the wide layout has room for the workspace column.
            expect(frame.includes("/workspace/vera")).toBe(width === 120);
        } finally {
            setup.renderer.destroy();
        }
    }
});

test("a session with no loaded facts renders as unavailable, never as zero", async () => {
    const report = buildDashboardReport([{
        id: "gamma",
        title: "never loaded",
        workspace: "/workspace/other",
        kind: "interactive",
        status: "idle",
        live: false,
    }], { sort: "cost", partial: true });

    const setup = await createTestRenderer({ width: 120, height: 30 });
    const root = renderTuiExperimentalView({
        renderer: setup.renderer,
        theme: VERA_TUI_THEME,
        node: renderDashboard(report, viewState(), 120),
        id: "dashboard-unavailable",
        overlay: true,
        focus() {},
        triggerAction() {},
    });
    setup.renderer.root.add(root);
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("unavailable");
        expect(frame).toContain("still reading");
        expect(frame).not.toContain("$0.0000");
    } finally {
        setup.renderer.destroy();
    }
});

test("the session list keeps a window around the selection", () => {
    const sessions = Array.from({ length: 12 }, (_unused, index) => ({
        id: `s-${index}`,
        title: `session ${String(index).padStart(2, "0")}`,
        workspace: "/work",
        kind: "interactive" as const,
        status: "idle" as const,
        live: false,
        facts: { context: { tokens: 1_000 - index, estimated: false } },
    }));
    const report = buildDashboardReport(sessions, {
        sort: "context",
        partial: false,
    });

    const top = sessionRows(renderDashboard(report, viewState(), 120));
    expect(top[0]).toContain("session 00");
    expect(top).toHaveLength(8);
    expect(text(renderDashboard(report, viewState(), 120)))
        .toContain("4 more sessions");

    const bottom = sessionRows(
        renderDashboard(report, { ...viewState(), selected: 11 }, 120),
    );
    expect(bottom.at(-1)).toContain("session 11");
    expect(bottom.some((row) => row.includes("session 00"))).toBe(false);
});

/** The lines the Sessions section drew, without the sections above it. */
function sessionRows(node: ReturnType<typeof renderDashboard>): string[] {
    const lines = text(node).split("\n");
    const start = lines.findIndex((line) => line.startsWith("Sessions (by"));
    return lines.slice(start + 2).filter((line) => line.startsWith("  "));
}

function text(node: ReturnType<typeof renderDashboard>): string {
    if (node.kind === "text") return node.text;
    if (node.kind === "button") return node.label;
    if (node.kind === "stack") return node.children.map(text).join("\n");
    return "";
}

function viewState() {
    return {
        sort: "context" as const,
        selected: 0,
        failuresOnly: false,
        loading: false,
        refreshedAt: "12:00:05",
    };
}

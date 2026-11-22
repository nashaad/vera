import { describe, expect, test } from "bun:test";

import {
    DEFAULT_FOOTER_LAYOUT,
    FOOTER_STANDARD_COLUMNS,
    FOOTER_STANDARD_TERMINAL,
} from "../../clients/tui/footer-layout.ts";
import { fitFooter } from "../../clients/tui/footer-fit.ts";
import { footerItemContents } from "../../clients/tui/footer-items.ts";
import { tuiRetryLine, tuiRetryLineFromActivity } from "../../clients/tui/retry-line.ts";
import { applyAgentUpdate, beginTuiTurn, createTuiState } from "../../clients/tui/state.ts";
import type { AgentUpdate, ModelActivityUpdate } from "../../src/engine/protocol.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const CARD_INSET = FOOTER_STANDARD_TERMINAL - FOOTER_STANDARD_COLUMNS;
const cardWidth = (terminalColumns: number): number => terminalColumns - CARD_INSET;

function retryingState(now = NOW) {
    return applyAgentUpdate(createTuiState(), {
        type: "model_activity",
        phase: "retrying",
        model: "gpt-6.1-terra",
        nextAttempt: 3,
        maxAttempts: 7,
        delayMs: 8_000,
        retryAt: new Date(now + 8_000).toISOString(),
        failure: { kind: "connection" },
        seq: 1,
    });
}

function eventCleared(event: AgentUpdate, now = NOW): boolean {
    return applyAgentUpdate(retryingState(now), event).modelActivity === undefined;
}

describe("TUI retry activity", () => {
    const model: AgentUpdate = {
        type: "model_substitution",
        model: "gpt-6.1-terra",
        requested: "gpt-6.1-terra",
        using: "gpt-6.1-terra-mini",
        reason: "overloaded",
        scope: "model",
        source: "turn",
        seq: 2,
    };

    test("clears when the attempted model answers or works", () => {
        expect(eventCleared({ type: "assistant_delta", text: "hello", seq: 2 })).toBe(true);
        expect(eventCleared({ type: "assistant_thinking", text: "hm", seq: 2 })).toBe(true);
        expect(eventCleared({ type: "assistant_thinking_progress", characters: 8, seq: 2 })).toBe(true);
        expect(eventCleared({ type: "tool_started", tool: "read", args: { path: "a.md" }, seq: 2 })).toBe(true);
    });

    test("clears when the turn changes model", () => {
        expect(eventCleared(model)).toBe(true);
    });

    test("keeps the retry through an effort change", () => {
        expect(eventCleared({ ...model, scope: "effort" })).toBe(false);
    });

    test("keeps the retry through a subagent fallback", () => {
        expect(eventCleared({ ...model, source: "subagent" })).toBe(false);
    });

    test("survives updates that do not mean the attempt answered", () => {
        expect(eventCleared({
            type: "tool_finished",
            tool: "read",
            seq: 2,
        })).toBe(false);
        expect(eventCleared({
            type: "context",
            measurement: { tokens: 100, estimated: true },
            seq: 2,
        })).toBe(false);
        expect(eventCleared({ type: "status", state: "working", seq: 2 })).toBe(false);
    });
});

function footerRows(line: { text: string; alternates: readonly string[] }, width: number): string[] {
    const fit = fitFooter(DEFAULT_FOOTER_LAYOUT, footerItemContents({
        status: { text: line.text, color: "#ffffff", alternates: line.alternates },
        keys: "Ctrl+X h keys",
        limits: ["5h 72% left · week 96% left"],
        place: { workspace: "/srv/crows-nest", branch: "main" },
        activity: [{ text: "  ", tone: "accent" }],
        activityColumns: 8,
        panes: [],
    }), true, width);
    return fit.rows.map((row) => row.map((chunk) => chunk.text).join(""));
}

function expectNoOverflow(rows: readonly string[], width: number): void {
    for (const row of rows) {
        expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
    }
}

describe("TUI retry footer line", () => {
    test("waiting names the attempt, the wait, the failure and the turn clock", () => {
        const line = tuiRetryLine({
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW + 8_000,
            failureKind: "connection",
        }, "12m04s", NOW);
        expect(line.text).toBe("retrying 3/7 in 8s · network error · 12m04s");
        expect(line.alternates).toEqual(["retrying 3/7 in 8s · 12m04s"]);
    });

    test("in flight names the attempt, the silence, the failure and the turn clock", () => {
        const line = tuiRetryLine({
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW - 80_000,
            failureKind: "connection",
        }, "12m52s", NOW);
        expect(line.text).toBe("retrying 3/7 · no reply 1m20s · network error · 12m52s");
        expect(line.alternates).toEqual(["retrying 3/7 · no reply 1m20s · 12m52s"]);
    });

    test("a sub-second wait reads <1s so the footer never says in 0s", () => {
        const line = tuiRetryLine({
            nextAttempt: 2,
            maxAttempts: 7,
            retryAt: NOW + 400,
            failureKind: "server",
            statusCode: 503,
        }, "0s", NOW);
        expect(line.text).toBe("retrying 2/7 in <1s · 503 · 0s");
    });

    test("at 120 columns the footer keeps the failure label", () => {
        const line = tuiRetryLine({
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW + 8_000,
            failureKind: "connection",
        }, "12m04s", NOW);
        const width = cardWidth(120);
        const rows = footerRows(line, width);
        expectNoOverflow(rows, width);
        expect(rows[0]).toContain("retrying 3/7 in 8s · network error · 12m04s");
    });

    test("at 80 columns the footer drops the failure label first and never wraps", () => {
        const line = tuiRetryLine({
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW + 8_000,
            failureKind: "connection",
        }, "12m04s", NOW);
        const width = cardWidth(80);
        const rows = footerRows(line, width);
        expectNoOverflow(rows, width);
        expect(rows[0]).toContain("retrying 3/7 in 8s · 12m04s");
        expect(rows.join("\n")).not.toContain("network error");
        expect(rows[1]).not.toContain("retrying");
    });

    test("the in-flight line also fits at 80 columns without its failure label", () => {
        const line = tuiRetryLine({
            nextAttempt: 3,
            maxAttempts: 7,
            retryAt: NOW - 80_000,
            failureKind: "connection",
        }, "12m52s", NOW);
        const width = cardWidth(80);
        const rows = footerRows(line, width);
        expectNoOverflow(rows, width);
        expect(rows[0]).toContain("retrying 3/7 · no reply 1m20s · 12m52s");
        expect(rows.join("\n")).not.toContain("network error");
    });
});

function activity(
    retryAt: string,
    failure: ModelActivityUpdate["failure"],
): ModelActivityUpdate {
    return {
        type: "model_activity",
        phase: "retrying",
        model: "gpt-6.1-terra",
        nextAttempt: 3,
        maxAttempts: 7,
        delayMs: 8_000,
        retryAt,
        failure,
        seq: 1,
    } as const;
}

describe("TUI retry line from the host event", () => {
    test("a retryAt in the past reads the silence since it", () => {
        const line = tuiRetryLineFromActivity(
            activity(new Date(NOW - 80_000).toISOString(), { kind: "connection" }),
            "12m52s",
            NOW,
        );
        expect(line.text).toBe("retrying 3/7 · no reply 1m20s · network error · 12m52s");
    });

    test("an unreadable retryAt leaves the attempt in flight with no silence", () => {
        const line = tuiRetryLineFromActivity(
            activity("not a date", { kind: "connection" }),
            "12m04s",
            NOW,
        );
        expect(line.text).toBe("retrying 3/7 · network error · 12m04s");
    });

    test("a server failure without a status code reads server error", () => {
        const line = tuiRetryLineFromActivity(
            activity(new Date(NOW + 8_000).toISOString(), { kind: "server" }),
            "0s",
            NOW,
        );
        expect(line.text).toBe("retrying 3/7 in 8s · server error · 0s");
        expect(tuiRetryLineFromActivity(
            activity(new Date(NOW + 8_000).toISOString(), { kind: "server", statusCode: 503 }),
            "0s",
            NOW,
        ).text).toBe("retrying 3/7 in 8s · 503 · 0s");
    });
});

test("the turn begins with no retry activity", () => {
    expect(beginTuiTurn(createTuiState(), "go").modelActivity).toBeUndefined();
});

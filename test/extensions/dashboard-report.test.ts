import { expect, test } from "bun:test";
import type {
    VeraClientSession,
    VeraClientSessionFacts,
    VeraClientSessionUsageRow,
} from "../../src/sdk/extensions.ts";
import { buildDashboardReport } from "../../examples/extensions/context/dashboard-report.ts";

function usageRow(
    overrides: Partial<VeraClientSessionUsageRow> = {},
): VeraClientSessionUsageRow {
    return {
        provider: "anthropic",
        model: "opus",
        calls: 2,
        durationMs: 1_000,
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 5,
        reasoningTokens: 1,
        totalTokens: 126,
        cost: 0.5,
        callsWithoutCost: 0,
        ...overrides,
    };
}

function session(
    id: string,
    overrides: Partial<VeraClientSession> = {},
    facts?: VeraClientSessionFacts,
): VeraClientSession {
    return {
        id,
        title: id,
        workspace: "/workspace",
        kind: "interactive",
        status: "idle",
        live: false,
        ...overrides,
        ...(facts === undefined ? {} : { facts }),
    };
}

test("health totals sum every loaded session's usage", () => {
    const report = buildDashboardReport([
        session("a", {}, { usage: { rows: [usageRow()] } }),
        session("b", {}, {
            usage: { rows: [usageRow({ provider: "openai", model: "gpt" })] },
        }),
    ], { sort: "context", partial: false });

    expect(report.health.sessions).toBe(2);
    expect(report.health.calls).toBe(4);
    expect(report.health.tokens.totalTokens).toBe(252);
    expect(report.health.tokens.cachedInputTokens).toBe(10);
    expect(report.health.cost).toBeCloseTo(1);
    expect(report.health.partial).toBe(false);
});

test("an unpriced call leaves the cost absent rather than zero", () => {
    const report = buildDashboardReport([
        session("a", {}, {
            usage: {
                rows: [usageRow({ cost: undefined, callsWithoutCost: 2 })],
            },
        }),
    ], { sort: "cost", partial: false });

    expect(report.health.cost).toBeUndefined();
    expect(report.health.unpricedCalls).toBe(2);
    expect(report.sessions[0]?.cost).toBeUndefined();
    expect(report.usageByModel[0]?.cost).toBeUndefined();
});

test("a partial listing reports what it loaded against the listing size", () => {
    const report = buildDashboardReport([session("a")], {
        sort: "context",
        partial: true,
        totalSessions: 40,
    });

    expect(report.health.loadedSessions).toBe(1);
    expect(report.health.totalSessions).toBe(40);
    expect(report.health.partial).toBe(true);
});

test("sessions missing the sort fact rank below sessions that have it", () => {
    const report = buildDashboardReport([
        session("no-facts"),
        session("small", {}, {
            context: { tokens: 10, estimated: false },
        }),
        session("large", {}, {
            context: { tokens: 900, estimated: false },
        }),
    ], { sort: "context", partial: false });

    expect(report.sessions.map((row) => row.id)).toEqual([
        "large",
        "small",
        "no-facts",
    ]);
    expect(report.sessions[2]?.contextTokens).toBeUndefined();
});

test("largest contexts omit a percentage when the window is unknown", () => {
    const report = buildDashboardReport([
        session("known", {}, {
            context: { tokens: 50, capacity: 200, estimated: false },
        }),
        session("unknown", {}, {
            context: { tokens: 80, estimated: true },
        }),
    ], { sort: "context", partial: false });

    expect(report.largestContexts.map((row) => row.id)).toEqual([
        "unknown",
        "known",
    ]);
    expect(report.largestContexts[0]?.percentOfCapacity).toBeUndefined();
    expect(report.largestContexts[1]?.percentOfCapacity).toBe(25);
});

test("usage groups by provider and model across sessions", () => {
    const report = buildDashboardReport([
        session("a", {}, { usage: { rows: [usageRow()] } }),
        session("b", {}, {
            usage: {
                rows: [
                    usageRow(),
                    usageRow({ model: "haiku", totalTokens: 3, calls: 1 }),
                ],
            },
        }),
    ], { sort: "tokens", partial: false });

    expect(report.usageByModel.map((row) => row.model)).toEqual([
        "opus",
        "haiku",
    ]);
    const opus = report.usageByModel[0];
    expect(opus?.sessions).toBe(2);
    expect(opus?.calls).toBe(4);
    expect(opus?.tokens.totalTokens).toBe(252);
    expect(report.usageByModel[1]?.sessions).toBe(1);
});

test("failures group by provider, model and kind", () => {
    const report = buildDashboardReport([
        session("a", { status: "failed" }, {
            failure: {
                at: "2026-08-20T10:00:00.000Z",
                provider: "anthropic",
                model: "opus",
                kind: "http_error",
                detail: "overloaded",
            },
        }),
        session("b", { status: "failed" }, {
            failure: {
                at: "2026-08-20T12:00:00.000Z",
                provider: "anthropic",
                model: "opus",
                kind: "http_error",
                detail: "credit balance is too low",
            },
        }),
        session("c", {}, {
            failure: {
                at: "2026-08-20T09:00:00.000Z",
                provider: "openai",
                model: "gpt",
                kind: "timeout",
                detail: "deadline exceeded",
            },
        }),
    ], { sort: "context", partial: false });

    expect(report.failures).toHaveLength(2);
    const grouped = report.failures[0];
    expect(grouped?.occurrences).toBe(2);
    expect(grouped?.sessions).toBe(2);
    expect(grouped?.lastDetail).toBe("credit balance is too low");
    expect(grouped?.allowance).toBe(true);
    expect(report.failures[1]?.allowance).toBe(false);
    expect(report.health.failed).toBe(2);
});

test("active rows carry the live sessions with their model and context", () => {
    const report = buildDashboardReport([
        session("running", { live: true, status: "working" }, {
            model: { provider: "anthropic", model: "opus" },
            context: { tokens: 4_000, capacity: 200_000, estimated: false },
        }),
        session("idle"),
    ], { sort: "context", partial: false });

    expect(report.active.map((row) => row.id)).toEqual(["running"]);
    expect(report.active[0]?.model).toBe("anthropic/opus");
    expect(report.active[0]?.contextTokens).toBe(4_000);
    expect(report.active[0]?.failing).toBe(false);
    expect(report.health.active).toBe(1);
});

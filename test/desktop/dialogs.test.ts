import { expect, test } from "bun:test";

import {
    diagnosticFacts,
    diagnosticsText,
    NOT_REPORTED,
    SOCKET_NOT_KEPT,
    type DiagnosticSession,
} from "../../clients/ui/src/overlays/diagnostics.ts";
import {
    doctorChecks,
    doctorSummary,
    extensionOutcome,
    EXTENSION_FAILURE_LIMIT,
    providerOutcome,
    type DoctorCheck,
} from "../../clients/ui/src/overlays/doctor.ts";
import type { HostModelsResult } from "../../clients/ui/src/protocol/bridge.ts";
import type { SessionWatch } from "../../clients/ui/src/session/model.ts";
import type { UiState } from "../../clients/ui/src/state/connection.ts";

const ready = { pid: 42, buildId: "abc1234def5678", home: "/Users/someone/.vera", attachedAt: 0 };
const identity = { pid: 42, protocol_version: 3 };

function watch(overrides: Partial<SessionWatch> = {}): SessionWatch {
    return {
        agentId: "agent-1",
        phase: "attached",
        loaded: true,
        history: [{ kind: "user", key: "u1", text: "hello" }],
        live: [{ kind: "text", key: "t1", text: "hi" }],
        status: "idle",
        hasOlder: false,
        loadingOlder: false,
        queue: [{ content: "later", state: "held" }],
        images: [],
        requests: [],
        ...overrides,
    };
}

function session(overrides: Partial<SessionWatch> = {}): DiagnosticSession {
    return { agentId: "agent-1", title: "Parser fix", folder: "/Users/someone/crow", chat: false, watch: watch(overrides) };
}

function valueOf(facts: ReturnType<typeof diagnosticFacts>, label: string): string | undefined {
    return facts.find((fact) => fact.label === label)?.value;
}

function checkOf(checks: readonly DoctorCheck[], id: string): DoctorCheck {
    const check = checks.find((candidate) => candidate.id === id);
    if (check === undefined) throw new Error(`no check ${id}`);
    return check;
}

const attached: UiState = { phase: "attached", ready, identity, sessions: 4 };
const disconnected: UiState = { phase: "disconnected", ready, failure: "The host stopped answering." };

test("@core session diagnostics list the session and host facts", () => {
    const facts = diagnosticFacts(session({ approval: { mode: "ask", pending: false, modes: [], grants: [], preferences: [] } }), attached, "darwin");
    expect(facts.filter((fact) => fact.section === "Session").map((fact) => fact.label)).toEqual([
        "Session id",
        "Title",
        "Folder",
        "Watch phase",
        "Run status",
        "Model",
        "Approval mode",
        "Context",
        "Queued prompts",
        "Open requests",
        "Loaded blocks",
    ]);
    expect(valueOf(facts, "Session id")).toBe("agent-1");
    expect(valueOf(facts, "Model")).toBe(NOT_REPORTED);
    expect(valueOf(facts, "Approval mode")).toBe("ask");
    expect(valueOf(facts, "Context")).toBe(NOT_REPORTED);
    expect(valueOf(facts, "Queued prompts")).toBe("1");
    expect(valueOf(facts, "Open requests")).toBe("0");
    expect(valueOf(facts, "Loaded blocks")).toBe("2");
});

test("session facts read the model and context when the session has reported them", () => {
    const facts = diagnosticFacts(
        session({
            context: { tokens: 12_300, capacity: 200_000, estimated: true, components: [] },
            models: {
                requestId: "r1",
                pending: false,
                settings: { provider: "tidewater", model: "crow-1", effort: "high", efforts: [], shortlist: [], catalog: [] },
            },
        }),
        attached,
        "darwin",
    );
    expect(valueOf(facts, "Model")).toBe("tidewater crow-1, effort high");
    expect(valueOf(facts, "Context")).toBe("12K of 200K tokens (estimated)");
});

test("@core with no session only the host facts are listed", () => {
    const facts = diagnosticFacts(undefined, attached, "darwin");
    expect(facts.every((fact) => fact.section === "Host")).toBe(true);
    expect(valueOf(facts, "Host pid")).toBe("42");
    expect(valueOf(facts, "Build")).toBe("abc1234def5678");
    expect(valueOf(facts, "Protocol version")).toBe("3");
    expect(valueOf(facts, "Home")).toBe("/Users/someone/.vera");
    expect(valueOf(facts, "Socket path")).toBe(SOCKET_NOT_KEPT);
    expect(valueOf(facts, "Platform")).toBe("darwin");
});

test("host facts say what is missing when the host is not running", () => {
    const facts = diagnosticFacts(undefined, { phase: "starting" }, "");
    expect(valueOf(facts, "Connection")).toBe("Starting");
    expect(valueOf(facts, "Host pid")).toBe("Not running");
    expect(valueOf(facts, "Build")).toBe("Unknown");
    expect(valueOf(facts, "Protocol version")).toBe(NOT_REPORTED);
    expect(valueOf(facts, "Platform")).toBe("Unknown");
});

test("@core the copied text is one label: value line per fact", () => {
    const facts = diagnosticFacts(undefined, disconnected, "linux");
    const lines = diagnosticsText(facts).split("\n");
    expect(lines).toHaveLength(facts.length);
    expect(lines[0]).toBe("Connection: Disconnected");
    expect(lines).toContain("Host pid: 42");
    expect(lines).toContain(`Socket path: ${SOCKET_NOT_KEPT}`);
    expect(lines.every((line) => /^[^:]+: .+$/.test(line))).toBe(true);
});

test("@core doctor reports the attached host as healthy", () => {
    const checks = doctorChecks({
        connection: attached,
        extensions: { kind: "loaded" },
        providers: { kind: "answered", connected: 2 },
    });
    expect(checkOf(checks, "host")).toMatchObject({ result: "ok", detail: "Host running · build abc1234 · protocol v3" });
    expect(checkOf(checks, "protocol").result).toBe("ok");
    expect(checkOf(checks, "sessions")).toMatchObject({ result: "ok", detail: "4 sessions listed by the host." });
    expect(checkOf(checks, "providers")).toMatchObject({ result: "ok", detail: "2 providers are connected." });
    expect(doctorSummary(checks)).toBe("Everything checks out.");
});

test("@core doctor fails the host checks when disconnected", () => {
    const checks = doctorChecks({
        connection: disconnected,
        extensions: { kind: "loaded" },
        providers: { kind: "answered", connected: 1 },
    });
    expect(checkOf(checks, "host").result).toBe("fail");
    expect(checkOf(checks, "protocol").result).toBe("fail");
    expect(checkOf(checks, "sessions").result).toBe("fail");
    expect(doctorSummary(checks)).toBe("3 checks want attention.");
});

test("doctor warns while the host is starting and has not listed sessions", () => {
    const checks = doctorChecks({
        connection: { phase: "starting" },
        extensions: undefined,
        providers: undefined,
    });
    expect(checkOf(checks, "host").result).toBe("warn");
    expect(checkOf(checks, "protocol").result).toBe("warn");
    expect(checkOf(checks, "extensions").result).toBe("pending");
    expect(checkOf(checks, "providers").result).toBe("pending");
    expect(doctorSummary(checks)).toBe("Checking…");
    const attachedWithoutList = doctorChecks({
        connection: { phase: "attached", ready, identity },
        extensions: { kind: "loaded" },
        providers: { kind: "answered", connected: 1 },
    });
    expect(checkOf(attachedWithoutList, "sessions").result).toBe("warn");
});

test("extension failures warn with a count, and an unreadable answer fails", () => {
    const failures = [
        { extensionId: "crow-tools", message: "manifest is missing" },
        { extensionId: "/Users/someone/ext", message: "path does not exist" },
    ];
    const warned = doctorChecks({ connection: attached, extensions: extensionOutcome({ ok: true, failures }), providers: undefined });
    expect(checkOf(warned, "extensions")).toMatchObject({ result: "warn", detail: "2 extensions did not load. Open Extensions for the reasons." });

    const failed = doctorChecks({
        connection: attached,
        extensions: extensionOutcome({ ok: false, reason: "The host did not answer." }),
        providers: undefined,
    });
    expect(checkOf(failed, "extensions")).toMatchObject({ result: "fail", detail: "The host did not answer." });
});

test("extension failures are capped and the total is kept", () => {
    const failures = Array.from({ length: EXTENSION_FAILURE_LIMIT + 5 }, (_, index) => ({
        extensionId: `ext-${index}`,
        message: "broken",
    }));
    const outcome = extensionOutcome({ ok: true, failures });
    expect(outcome).toEqual({
        kind: "failed",
        shown: failures.slice(0, EXTENSION_FAILURE_LIMIT),
        total: EXTENSION_FAILURE_LIMIT + 5,
    });
    expect(extensionOutcome({ ok: true, failures: [] })).toEqual({ kind: "loaded" });
});

test("provider answers: connected is ok, none connected warns, no answer fails", () => {
    const connected: HostModelsResult = {
        ok: true,
        settings: {
            model: "crow-1",
            availableModels: [],
            pooled: [],
            providerCatalogs: [{ id: "tidewater", label: "Tidewater" }],
        },
    };
    expect(providerOutcome(connected)).toEqual({ kind: "answered", connected: 1 });

    const none: HostModelsResult = { ok: true, settings: { model: "crow-1", availableModels: [], pooled: [], providerCatalogs: [] } };
    const warned = doctorChecks({ connection: attached, extensions: undefined, providers: providerOutcome(none) });
    expect(checkOf(warned, "providers")).toMatchObject({ result: "warn" });
    expect(checkOf(warned, "providers").detail).toContain("/provider");

    const silent = doctorChecks({
        connection: attached,
        extensions: undefined,
        providers: providerOutcome({ ok: false, reason: "The host did not answer." }),
    });
    expect(checkOf(silent, "providers")).toMatchObject({ result: "fail", detail: "The host did not answer." });

    expect(providerOutcome({ ok: true, settings: { availableModels: [] } })).toEqual({
        kind: "unreadable",
        reason: "The host did not list its models.",
    });
});

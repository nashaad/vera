import { expect, test } from "bun:test";
import { accessModeUnderAgent } from "../../src/agents/access.ts";
import type { AgentSnapshot } from "../../src/agents/snapshot.ts";

const MODES = ["readonly", "ask", "auto", "full_access", "reviewer"];

function agent(fields: Partial<AgentSnapshot>): AgentSnapshot {
    return { name: "scribe", instructions: "", ...fields };
}

test("no agent, or an agent with no posture or limits, keeps the current mode", () => {
    expect(accessModeUnderAgent(undefined, "auto", MODES)).toBe("auto");
    expect(accessModeUnderAgent(agent({}), "full_access", MODES)).toBe("full_access");
});

test("a posture narrower than the current mode applies", () => {
    expect(accessModeUnderAgent(agent({ posture: "readonly" }), "auto", MODES)).toBe("readonly");
    expect(accessModeUnderAgent(agent({ posture: "ask" }), "full_access", MODES)).toBe("ask");
});

test("a posture equal to or wider than the current mode changes nothing", () => {
    expect(accessModeUnderAgent(agent({ posture: "ask" }), "ask", MODES)).toBe("ask");
    expect(accessModeUnderAgent(agent({ posture: "full_access" }), "ask", MODES)).toBe("ask");
});

test("a custom posture or a custom current mode is never taken as narrower", () => {
    expect(accessModeUnderAgent(agent({ posture: "reviewer" }), "auto", MODES)).toBe("auto");
    expect(accessModeUnderAgent(agent({ posture: "readonly" }), "reviewer", MODES)).toBe("reviewer");
});

test("a custom posture is never taken when the current mode is built in", () => {
    expect(accessModeUnderAgent(
        agent({ posture: "reviewer", forbiddenAccess: ["auto"] }),
        "auto",
        MODES,
    )).toBe("readonly");
});

test("a custom mode that equals the current mode stays", () => {
    expect(accessModeUnderAgent(agent({ posture: "reviewer" }), "reviewer", MODES)).toBe("reviewer");
});

test("a forbidden current mode falls back to the narrowest allowed mode", () => {
    expect(accessModeUnderAgent(agent({ forbiddenAccess: ["auto"] }), "auto", MODES)).toBe("readonly");
    expect(accessModeUnderAgent(agent({ forbiddenAccess: ["readonly", "auto"] }), "auto", MODES)).toBe("ask");
});

test("a forbidden posture is skipped", () => {
    expect(accessModeUnderAgent(
        agent({ posture: "readonly", forbiddenAccess: ["readonly", "auto"] }),
        "auto",
        MODES,
    )).toBe("ask");
});

test("a forbidden current mode never falls back to a wider posture or mode", () => {
    expect(accessModeUnderAgent(
        agent({ posture: "auto", forbiddenAccess: ["ask"] }),
        "ask",
        MODES,
    )).toBe("readonly");
    expect(accessModeUnderAgent(
        agent({ posture: "full_access", forbiddenAccess: ["auto", "ask"] }),
        "auto",
        MODES,
    )).toBe("readonly");
    expect(accessModeUnderAgent(
        agent({ forbiddenAccess: ["readonly"] }),
        "readonly",
        MODES,
    )).toBeUndefined();
});

test("a forbidden custom current mode has no narrower mode", () => {
    expect(accessModeUnderAgent(agent({ forbiddenAccess: ["reviewer"] }), "reviewer", MODES))
        .toBeUndefined();
});

test("no mode is offered when every narrower mode is forbidden", () => {
    expect(accessModeUnderAgent(
        agent({ posture: "readonly", forbiddenAccess: ["readonly", "ask"] }),
        "ask",
        MODES,
    )).toBeUndefined();
});

test("a posture outside the supplied modes is never returned", () => {
    expect(accessModeUnderAgent(agent({ posture: "ask" }), "auto", ["readonly", "auto"])).toBe("auto");
    expect(accessModeUnderAgent(
        agent({ posture: "ask", forbiddenAccess: ["auto"] }),
        "auto",
        ["readonly", "auto"],
    )).toBe("readonly");
    expect(accessModeUnderAgent(
        agent({ posture: "reviewer", forbiddenAccess: ["reviewer"] }),
        "reviewer",
        ["readonly", "ask", "auto"],
    )).toBeUndefined();
});

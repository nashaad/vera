import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AssignmentService } from "../../clients/desktop/src/assignments.ts";
import { AssignmentStore } from "../../clients/desktop/src/model-assignments/assignment-store.ts";
import { runAssignmentTask } from "../../clients/desktop/src/model-assignments/run-task.ts";
import { changeArgument, parseAssignmentTask, parseAssignmentTaskReply } from "../../clients/desktop/src/model-assignments/task-protocol.ts";
import { slotOf, type AssignmentsView } from "../../clients/ui/src/protocol/assignments.ts";

const homes: string[] = [];
const startedIn = process.cwd();

function trialHome(config: Record<string, unknown> = {}): string {
    const home = mkdtempSync(join(tmpdir(), "vera-assignment-store-"));
    homes.push(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({ schema_version: 1, model: "seed", ...config }));
    writeFileSync(join(home, "pool.json"), JSON.stringify({
        models: {
            "openrouter/big-1": { added: true, learned: { probe: { ok: true, seen: "2026-09-06" } } },
            "openrouter/small-1": { added: true },
        },
    }));
    return home;
}

function written(home: string): Record<string, unknown> {
    return (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { model_assignments?: Record<string, unknown> })
        .model_assignments ?? {};
}

function view(result: { readonly ok: boolean; readonly view?: AssignmentsView }): AssignmentsView {
    if (!result.ok || result.view === undefined) throw new Error(`expected a view, got ${JSON.stringify(result)}`);
    return result.view;
}

afterEach(() => {
    process.chdir(startedIn);
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("@core assignments are written to the home's config.json whatever folder the app started in", () => {
    const home = trialHome();
    const elsewhere = mkdtempSync(join(tmpdir(), "vera-assignment-cwd-"));
    homes.push(elsewhere);
    mkdirSync(join(elsewhere, ".vera"), { recursive: true });
    writeFileSync(join(elsewhere, "config.json"), "{ not json");
    process.chdir(elsewhere);

    const store = new AssignmentStore(home);
    const after = view(store.edit({ assignment: "extra", provider: "openrouter", model: "big-1", reasoningEffort: "high" }));
    expect(written(home).extra).toEqual({ models: [{ name: "big_1_openrouter", provider: "openrouter", model: "big-1", reasoning_effort: "high" }] });
    expect(slotOf(after, "extra")).toMatchObject({ bound: true, source: "assignment", declared: [{ provider: "openrouter", model: "big-1", effort: "high" }] });
    // An unset job runs on its tier.
    expect(slotOf(after, "reviewer")).toMatchObject({ bound: false, source: "intent", inherits: "extra" });
    expect(readFileSync(join(elsewhere, "config.json"), "utf8")).toBe("{ not json");
});

test("@core the classifier keeps its failsafe when its model changes, and loses both when unset", () => {
    const home = trialHome();
    const store = new AssignmentStore(home);
    view(store.edit({ assignment: "reviewer", provider: "openrouter", model: "big-1" }));
    view(store.edit({ assignment: "reviewer", provider: "openrouter", model: "small-1", failsafe: true }));
    const changed = view(store.edit({ assignment: "reviewer", provider: "openrouter", model: "big-1", reasoningEffort: "low" }));
    expect(slotOf(changed, "reviewer")?.declared.map((entry) => entry.model)).toEqual(["big-1", "small-1"]);
    const noFailsafe = view(store.edit({ assignment: "reviewer", failsafe: true }));
    expect(slotOf(noFailsafe, "reviewer")?.declared.map((entry) => entry.model)).toEqual(["big-1"]);
    const unset = view(store.edit({ assignment: "reviewer" }));
    expect(slotOf(unset, "reviewer")?.bound).toBe(false);
    expect(written(home).reviewer).toBeUndefined();
});

test("a failsafe needs a classifier first", () => {
    const store = new AssignmentStore(trialHome());
    const result = store.edit({ assignment: "reviewer", provider: "openrouter", model: "big-1", failsafe: true });
    expect(result).toEqual({ ok: false, reason: "Assign the classifier before choosing its failsafe." });
});

test("@core subagents add in order, move, drop and fall back to the spawning session's model", () => {
    const home = trialHome();
    const store = new AssignmentStore(home);
    view(store.edit({ assignment: "subagents", provider: "openrouter", model: "big-1" }));
    view(store.edit({ assignment: "subagents", provider: "openrouter", model: "small-1" }));
    const moved = view(store.edit({ assignment: "subagents", provider: "openrouter", model: "small-1", move: -1 }));
    expect(slotOf(moved, "subagents")?.declared.map((entry) => entry.model)).toEqual(["small-1", "big-1"]);
    const self = view(store.edit({ assignment: "subagents", allowSelf: true }));
    expect(slotOf(self, "subagents")?.allowSelf).toBe(true);
    view(store.edit({ assignment: "subagents", provider: "openrouter", model: "small-1", remove: true }));
    const last = view(store.edit({ assignment: "subagents", provider: "openrouter", model: "big-1", remove: true }));
    expect(slotOf(last, "subagents")).toMatchObject({ declared: [], allowSelf: true });
    expect(written(home).subagents).toEqual({ models: [], allow_self: true });
    view(store.edit({ assignment: "subagents", allowSelf: false }));
    expect(written(home).subagents).toBeUndefined();
});

test("assigning one model to all keeps the subagent list and the failsafe", () => {
    const home = trialHome();
    const store = new AssignmentStore(home);
    view(store.edit({ assignment: "reviewer", provider: "openrouter", model: "big-1" }));
    view(store.edit({ assignment: "reviewer", provider: "openrouter", model: "big-1", failsafe: true }));
    view(store.edit({ assignment: "reviewer", provider: "openrouter", model: "small-1", failsafe: true }));
    view(store.edit({ assignment: "subagents", provider: "openrouter", model: "big-1" }));
    const result = store.assignAll("openrouter", "small-1");
    if (!result.ok) throw new Error(result.reason);
    expect(result.assigned).toHaveLength(6);
    expect(result.favorite).toBe(false);
    expect(slotOf(result.view, "subagents")?.declared.map((entry) => entry.model)).toEqual(["small-1", "big-1"]);
    expect(slotOf(result.view, "reviewer")?.declared.map((entry) => entry.model)).toEqual(["small-1"]);
    expect(slotOf(result.view, "snappy")?.declared.map((entry) => entry.model)).toEqual(["small-1"]);
});

test("a model outside the favorites is assigned and reported as needing to become one", () => {
    const store = new AssignmentStore(trialHome());
    const result = store.edit({ assignment: "eco", provider: "openrouter", model: "new-1" });
    expect(result.ok && result.favorite).toBe(true);
});

test("with verification on, an unverified model is refused and nothing is written", () => {
    const home = trialHome({ verify_model_assignments: true });
    const store = new AssignmentStore(home);
    expect(store.edit({ assignment: "eco", provider: "openrouter", model: "small-1" }))
        .toEqual({ ok: false, reason: "Verify this model before assigning it as a default." });
    expect(store.assignAll("openrouter", "small-1").ok).toBe(false);
    expect(written(home)).toEqual({});
});

test("a config.json that stops loading keeps the last view and refuses writes", () => {
    const home = trialHome();
    const store = new AssignmentStore(home);
    view(store.edit({ assignment: "eco", provider: "openrouter", model: "big-1" }));
    writeFileSync(join(home, "config.json"), "{ not json");
    const read = store.read();
    if (!read.ok) throw new Error(read.reason);
    expect(read.notice).toContain("config.json could not be read");
    expect(slotOf(read, "eco")?.bound).toBe(true);
    expect(store.edit({ assignment: "eco", provider: "openrouter", model: "small-1" }).ok).toBe(false);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{ not json");
});

test("a change from the window is checked before it reaches the config", () => {
    expect(changeArgument({ assignment: "eco", provider: "openrouter", model: "big-1", effort: "high" }))
        .toEqual({ assignment: "eco", provider: "openrouter", model: "big-1", effort: "high" });
    expect(changeArgument({ assignment: "subagents", provider: "openrouter", model: "big-1", move: 1 }))
        .toEqual({ assignment: "subagents", provider: "openrouter", model: "big-1", move: 1 });
    expect(changeArgument({ assignment: "eco" })).toEqual({ assignment: "eco" });
    for (const bad of [
        null,
        "eco",
        { assignment: "session" },
        { assignment: "eco", model: "big-1" },
        { assignment: "eco", provider: "Open Router", model: "big-1" },
        { assignment: "eco", provider: "openrouter", model: "big-1", effort: "HIGH!" },
        { assignment: "eco", allowSelf: true },
        { assignment: "eco", provider: "openrouter", model: "big-1", failsafe: true },
        { assignment: "subagents", move: 1 },
        { assignment: "subagents", provider: "openrouter", model: "big-1", move: 2 },
        { assignment: "subagents", allowSelf: "yes" },
    ]) {
        expect(changeArgument(bad)).toBeUndefined();
    }
});

// Each task gets a fresh store and only what survives the copy between processes, as in the app.
function inTaskProcesses(home: string): AssignmentService {
    return new AssignmentService(home, async (task) => {
        const received = parseAssignmentTask(structuredClone(task));
        if (received === undefined) throw new Error("The task did not read.");
        const reply = parseAssignmentTaskReply(structuredClone(runAssignmentTask(received)));
        if (reply === undefined) throw new Error("The answer did not read.");
        return reply;
    });
}

test("@core across task processes, a config.json that stops loading keeps the last view and refuses writes", async () => {
    const home = trialHome();
    const assignments = inTaskProcesses(home);
    const change = changeArgument({ assignment: "eco", provider: "openrouter", model: "big-1", effort: "high" });
    if (change === undefined) throw new Error("The change did not read.");
    const edited = await assignments.edit(change);
    expect(edited.ok && slotOf(edited.view, "eco")?.declared).toEqual([{ provider: "openrouter", model: "big-1", effort: "high" }]);
    expect(written(home).eco).toBeDefined();

    writeFileSync(join(home, "config.json"), "{ not json");
    const read = await assignments.read();
    if (!read.ok) throw new Error(read.reason);
    expect(read.notice).toContain("config.json could not be read");
    expect(slotOf(read, "eco")?.bound).toBe(true);
    expect((await assignments.edit({ assignment: "eco", provider: "openrouter", model: "small-1" })).ok).toBe(false);
    expect((await assignments.assignAll("openrouter", "small-1")).ok).toBe(false);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{ not json");

    expect(read.notice).toContain("Showing the last settings that loaded.");
    const fresh = await inTaskProcesses(home).read();
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.notice).not.toContain("Showing the last settings");
    expect(slotOf(fresh, "eco")?.bound).toBe(false);
});

test("a task that fails or answers a different request is reported, not thrown", async () => {
    const failing = new AssignmentService(trialHome(), () => Promise.reject(new Error("The task stopped without answering.")));
    expect(await failing.read()).toEqual({ ok: false, reason: "The task stopped without answering." });
    const crossed = new AssignmentService(trialHome(), async () => ({ kind: "edit", result: { ok: false, reason: "no" } }));
    expect(await crossed.read()).toEqual({ ok: false, reason: "The assignments task answered a different request." });
});

test("assignment tasks and answers of the wrong shape are not read", () => {
    for (const task of [
        null,
        { kind: "read" },
        { kind: "read", home: 1 },
        { kind: "edit", home: "/h", change: { assignment: "session" } },
        { kind: "assign-all", home: "/h", provider: "Open Router", model: "m" },
        { kind: "read", home: "/h", lastGood: { path: 1, config: {} } },
        { kind: "write", home: "/h" },
    ]) {
        expect(parseAssignmentTask(task)).toBeUndefined();
    }
    for (const reply of [
        null,
        { kind: "read" },
        { kind: "read", result: { ok: true, slots: [{ id: "eco" }] } },
        { kind: "edit", result: { ok: true, view: { ok: true, slots: [] } } },
        { kind: "assign-all", result: { ok: true, view: { ok: true, slots: [] }, favorite: false, assigned: [1] } },
        { kind: "read", result: { ok: false, reason: "no" }, lastGood: "config" },
    ]) {
        expect(parseAssignmentTaskReply(reply)).toBeUndefined();
    }
});

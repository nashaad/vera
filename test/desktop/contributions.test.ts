import { expect, test } from "bun:test";

import { defaultLayout } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout } from "../../clients/ui/src/layout/resolve.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, CORE_VIEWS, registerCoreContributions } from "../../clients/ui/src/registry/core.ts";

const container = { id: "x.notes", title: "Notes", icon: "notes", location: "panel" } as const;
const view = { id: "x.todo", title: "Todo", container: "x.notes" };

test("@core core contributions register through the same registry an extension would use", () => {
    const registry = new ContributionRegistry();
    registerCoreContributions(registry);
    const snapshot = registry.snapshot();
    expect(snapshot.containers.map((entry) => entry.id).sort()).toEqual(Object.values(CORE_CONTAINERS).sort());
    expect(snapshot.views.map((entry) => entry.id).sort()).toEqual(Object.values(CORE_VIEWS).sort());
    const files = snapshot.views.find((entry) => entry.id === CORE_VIEWS.files);
    expect(snapshot.containers.find((entry) => entry.id === files?.container)?.location).toBe("rightPane");
});

test("a registration returns a disposer that removes only that registration", () => {
    const registry = new ContributionRegistry();
    const disposeContainer = registry.registerContainer(container);
    const disposeView = registry.registerView(view);
    expect(registry.snapshot().views).toEqual([view]);
    disposeView();
    disposeView();
    expect(registry.snapshot().views).toEqual([]);
    expect(registry.snapshot().containers).toEqual([container]);
    disposeContainer();
    expect(registry.snapshot().containers).toEqual([]);
});

test("a stale disposer does not remove a later registration of the same id", () => {
    const registry = new ContributionRegistry();
    const dispose = registry.registerView(view);
    dispose();
    const again = { ...view, title: "Todo again" };
    registry.registerView(again);
    dispose();
    expect(registry.snapshot().views).toEqual([again]);
});

test("duplicate and malformed registrations are rejected", () => {
    const registry = new ContributionRegistry();
    registry.registerContainer(container);
    registry.registerView(view);
    expect(() => registry.registerContainer(container)).toThrow("already registered");
    expect(() => registry.registerView(view)).toThrow("already registered");
    expect(() => registry.registerContainer({ ...container, id: "" })).toThrow("needs an id");
    expect(() => registry.registerContainer({ ...container, id: "y", location: "nowhere" as never })).toThrow("unknown location");
    expect(() => registry.registerView({ ...view, id: "y", container: "" })).toThrow("default container");
});

test("the snapshot is the same object until something changes", () => {
    const registry = new ContributionRegistry();
    registry.registerContainer(container);
    const first = registry.snapshot();
    expect(registry.snapshot()).toBe(first);
    registry.registerView(view);
    expect(registry.snapshot()).not.toBe(first);
});

test("subscribers hear registrations and unregistrations until they unsubscribe", () => {
    const registry = new ContributionRegistry();
    let heard = 0;
    const unsubscribe = registry.subscribe(() => {
        heard += 1;
    });
    const dispose = registry.registerView(view);
    dispose();
    expect(heard).toBe(2);
    unsubscribe();
    registry.registerView(view);
    expect(heard).toBe(2);
});

test("@core an unavailable container leaves the snapshot with its views, and comes back when available", () => {
    const registry = new ContributionRegistry();
    registerCoreContributions(registry);
    const all = registry.snapshot();
    registry.setUnavailable(new Set([CORE_CONTAINERS.review, CORE_CONTAINERS.output]));
    const reduced = registry.snapshot();
    expect(reduced.containers.map((entry) => entry.id)).not.toContain(CORE_CONTAINERS.review);
    expect(reduced.containers.map((entry) => entry.id)).not.toContain(CORE_CONTAINERS.output);
    expect(reduced.views.map((entry) => entry.id)).not.toContain(CORE_VIEWS.review);
    expect(reduced.views.map((entry) => entry.id)).not.toContain(CORE_VIEWS.output);
    expect(reduced.containers.length).toBe(all.containers.length - 2);
    registry.setUnavailable(new Set());
    expect(registry.snapshot().containers.map((entry) => entry.id).sort()).toEqual(all.containers.map((entry) => entry.id).sort());
});

test("setting the same unavailable ids again changes nothing and tells no one", () => {
    const registry = new ContributionRegistry();
    registerCoreContributions(registry);
    registry.setUnavailable(new Set([CORE_CONTAINERS.plan]));
    const before = registry.snapshot();
    let heard = 0;
    registry.subscribe(() => heard++);
    registry.setUnavailable(new Set([CORE_CONTAINERS.plan]));
    expect(heard).toBe(0);
    expect(registry.snapshot()).toBe(before);
    registry.setUnavailable(new Set());
    expect(heard).toBe(1);
});

test("@core layout actions keep a saved arrangement for a container that is unavailable", () => {
    const registry = new ContributionRegistry();
    registerCoreContributions(registry);
    const moved = reduceLayout(defaultLayout(), { type: "moveContainer", container: CORE_CONTAINERS.review, location: "panel" }, registry.snapshot());
    expect(moved.containerLocation[CORE_CONTAINERS.review]).toBe("panel");
    registry.setUnavailable(new Set([CORE_CONTAINERS.review]));
    const snapshot = registry.snapshot();
    expect(resolveLayout(moved, snapshot).locations.panel.all.map((entry) => entry.id)).not.toContain(CORE_CONTAINERS.review);
    const after = reduceLayout(moved, { type: "moveContainer", container: CORE_CONTAINERS.plan, location: "panel" }, snapshot);
    expect(after.containerLocation[CORE_CONTAINERS.review]).toBe("panel");
    const toggled = reduceLayout(after, { type: "toggleLocation", location: "rightPane" }, snapshot);
    expect(toggled.containerLocation[CORE_CONTAINERS.review]).toBe("panel");
    registry.setUnavailable(new Set());
    expect(resolveLayout(toggled, registry.snapshot()).locations.panel.all.map((entry) => entry.id)).toContain(CORE_CONTAINERS.review);
});

test("a pane reveal for an unavailable container is ignored", () => {
    const registry = new ContributionRegistry();
    registerCoreContributions(registry);
    registry.setUnavailable(new Set([CORE_CONTAINERS.files]));
    const state = defaultLayout();
    expect(reduceLayout(state, { type: "activateContainer", container: CORE_CONTAINERS.files }, registry.snapshot())).toBe(state);
});

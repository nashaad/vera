import { expect, test } from "bun:test";

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

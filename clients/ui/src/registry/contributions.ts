import {
    isLocationId,
    type ContainerContribution,
    type RegistrySnapshot,
    type ViewContribution,
} from "../layout/model.ts";

// Core views and containers register here with the shape an extension will use later.
export class ContributionRegistry {
    private readonly containers = new Map<string, ContainerContribution>();
    private readonly views = new Map<string, ViewContribution>();
    private readonly listeners = new Set<() => void>();
    private cached: RegistrySnapshot | undefined;

    registerContainer(container: ContainerContribution): () => void {
        if (container.id.length === 0 || container.title.length === 0) {
            throw new Error("A view container needs an id and a title.");
        }
        if (!isLocationId(container.location)) {
            throw new Error(`View container ${container.id} names an unknown location.`);
        }
        if (this.containers.has(container.id)) {
            throw new Error(`View container ${container.id} is already registered.`);
        }
        this.containers.set(container.id, container);
        this.changed();
        return () => {
            if (this.containers.get(container.id) !== container) return;
            this.containers.delete(container.id);
            this.changed();
        };
    }

    registerView(view: ViewContribution): () => void {
        if (view.id.length === 0 || view.title.length === 0 || view.container.length === 0) {
            throw new Error("A view needs an id, a title and a default container.");
        }
        if (this.views.has(view.id)) throw new Error(`View ${view.id} is already registered.`);
        this.views.set(view.id, view);
        this.changed();
        return () => {
            if (this.views.get(view.id) !== view) return;
            this.views.delete(view.id);
            this.changed();
        };
    }

    // The same object until something registers or unregisters.
    snapshot(): RegistrySnapshot {
        this.cached ??= {
            containers: [...this.containers.values()],
            views: [...this.views.values()],
        };
        return this.cached;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(): void {
        this.cached = undefined;
        for (const listener of [...this.listeners]) listener();
    }
}

import type { ContributionRegistry } from "./contributions.ts";

export const CORE_VIEWS = {
    host: "core.host",
    sessions: "core.sessions",
    output: "core.output",
} as const;

export const CORE_CONTAINERS = {
    vera: "core.vera",
    sessions: "core.sessions",
    output: "core.output",
} as const;

export function registerCoreContributions(registry: ContributionRegistry): void {
    registry.registerContainer({ id: CORE_CONTAINERS.sessions, title: "Sessions", icon: "sessions", location: "sidebar" });
    registry.registerContainer({ id: CORE_CONTAINERS.vera, title: "Vera", icon: "vera", location: "rightPane" });
    registry.registerContainer({ id: CORE_CONTAINERS.output, title: "Output", icon: "output", location: "panel" });
    registry.registerView({ id: CORE_VIEWS.sessions, title: "Sessions", container: CORE_CONTAINERS.sessions });
    registry.registerView({ id: CORE_VIEWS.host, title: "Host", container: CORE_CONTAINERS.vera });
    registry.registerView({ id: CORE_VIEWS.output, title: "Output", container: CORE_CONTAINERS.output });
}

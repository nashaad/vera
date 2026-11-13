import type { ContributionRegistry } from "./contributions.ts";

export const CORE_VIEWS = {
    sessions: "core.sessions",
    output: "core.output",
    review: "core.review",
    plan: "core.plan",
    files: "core.files",
    browser: "core.browser",
} as const;

export const CORE_CONTAINERS = {
    sessions: "core.sessions",
    output: "core.output",
    review: "core.review",
    plan: "core.plan",
    files: "core.files",
    browser: "core.browser",
} as const;

export function registerCoreContributions(registry: ContributionRegistry): void {
    registry.registerContainer({ id: CORE_CONTAINERS.sessions, title: "Sessions", icon: "sessions", location: "sidebar" });
    registry.registerContainer({ id: CORE_CONTAINERS.output, title: "Output", icon: "output", location: "panel" });
    registry.registerContainer({ id: CORE_CONTAINERS.review, title: "Review", icon: "review", location: "rightPane" });
    registry.registerContainer({ id: CORE_CONTAINERS.plan, title: "Plan", icon: "plan", location: "rightPane" });
    registry.registerContainer({ id: CORE_CONTAINERS.files, title: "Files", icon: "files", location: "rightPane" });
    registry.registerContainer({ id: CORE_CONTAINERS.browser, title: "Browser", icon: "browser", location: "rightPane" });
    registry.registerView({ id: CORE_VIEWS.sessions, title: "Sessions", container: CORE_CONTAINERS.sessions });
    registry.registerView({ id: CORE_VIEWS.output, title: "Output", container: CORE_CONTAINERS.output });
    registry.registerView({ id: CORE_VIEWS.review, title: "Review", container: CORE_CONTAINERS.review });
    registry.registerView({ id: CORE_VIEWS.plan, title: "Plan", container: CORE_CONTAINERS.plan });
    registry.registerView({ id: CORE_VIEWS.files, title: "Files", container: CORE_CONTAINERS.files });
    registry.registerView({ id: CORE_VIEWS.browser, title: "Browser", container: CORE_CONTAINERS.browser });
}

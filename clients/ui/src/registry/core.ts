import { BROWSER_TAB_LIMIT } from "../browser/native-types.ts";
import { CHAT_TAB_LIMIT } from "../chat/limits.ts";
import { CHAT_COMMANDS } from "../commands/chat-commands.ts";
import type { ContributionRegistry } from "./contributions.ts";

export const CORE_VIEWS = {
    sessions: "core.sessions",
    output: "core.output",
    review: "core.review",
    changes: "core.changes",
    plan: "core.plan",
    files: "core.files",
    browser: "core.browser",
    chat: "core.chat",
    subagents: "core.subagents",
} as const;

export const CORE_CONTAINERS = {
    sessions: "core.sessions",
    output: "core.output",
    review: "core.review",
    changes: "core.changes",
    plan: "core.plan",
    files: "core.files",
    browser: "core.browser",
    chat: "core.chat",
    subagents: "core.subagents",
} as const;

// A kind of tab the right pane opens. Its container and its one view share the id.
export interface PaneKind {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    // The most tabs of this kind open at once; no limit when absent.
    readonly maxTabs?: number;
    // Tabs of this kind are not saved with the layout.
    readonly transientTabs?: boolean;
    // One letter, with Cmd or Ctrl; the shortcut shows the kind's most recent tab, or opens one.
    readonly shortcut?: { readonly key: string; readonly alt?: boolean; readonly shift?: boolean };
    // A kind whose tab needs something to show starts one by running a command; its tile and launcher row use this title and icon.
    readonly entry?: { readonly title: string; readonly icon: string; readonly command: string };
}

// Tiles, the launcher, the tab strip, saving and closing read this list and nothing per kind.
// A new kind is an entry here, its renderer in views/registry.tsx and its icon in workbench/ContainerIcon.tsx.
// Kinds that come from the pages extensions add join it at run time through registerPaneKind (see pagepane/).
export const PANE_KINDS: readonly PaneKind[] = [
    { id: CORE_CONTAINERS.review, title: "Review", icon: "review" },
    { id: CORE_CONTAINERS.changes, title: "Changes", icon: "changes" },
    { id: CORE_CONTAINERS.plan, title: "Plan", icon: "plan" },
    { id: CORE_CONTAINERS.files, title: "Files", icon: "files" },
    { id: CORE_CONTAINERS.browser, title: "Browser", icon: "browser", maxTabs: BROWSER_TAB_LIMIT, transientTabs: true },
    {
        id: CORE_CONTAINERS.chat,
        title: "Chat",
        icon: "chat",
        maxTabs: CHAT_TAB_LIMIT,
        transientTabs: true,
        entry: { title: "Help", icon: "help", command: CHAT_COMMANDS.help },
    },
    { id: CORE_CONTAINERS.subagents, title: "Subagents", icon: "subagents", maxTabs: 1, transientTabs: true },
];

// What a container's tile and launcher row show and run: the kind's entry when it has one, else a new empty tab.
export function paneEntry(
    container: string,
    fallback: { readonly title: string; readonly icon: string },
    kinds: readonly PaneKind[] = PANE_KINDS,
): { readonly title: string; readonly icon: string; readonly command: string | undefined } {
    const entry = kinds.find((kind) => kind.id === container)?.entry;
    return entry ?? { title: fallback.title, icon: fallback.icon, command: undefined };
}

// The command a kind's shortcut runs.
export function paneKindCommand(kind: string): string {
    return `layout.show.${kind}`;
}

export function registerCoreContributions(registry: ContributionRegistry, kinds: readonly PaneKind[] = PANE_KINDS): void {
    registry.registerContainer({ id: CORE_CONTAINERS.sessions, title: "Sessions", icon: "sessions", location: "sidebar" });
    registry.registerContainer({ id: CORE_CONTAINERS.output, title: "Output", icon: "output", location: "panel" });
    registry.registerView({ id: CORE_VIEWS.sessions, title: "Sessions", container: CORE_CONTAINERS.sessions });
    registry.registerView({ id: CORE_VIEWS.output, title: "Output", container: CORE_CONTAINERS.output });
    for (const kind of kinds) registerPaneKind(registry, kind);
}

// Registers a kind's container and view; the returned function removes both.
export function registerPaneKind(registry: ContributionRegistry, kind: PaneKind): () => void {
    const removeContainer = registry.registerContainer({
        id: kind.id,
        title: kind.title,
        icon: kind.icon,
        location: "rightPane",
        ...(kind.maxTabs === undefined ? {} : { maxTabs: kind.maxTabs }),
        ...(kind.transientTabs === true ? { transientTabs: true } : {}),
    });
    const removeView = registry.registerView({ id: kind.id, title: kind.title, container: kind.id });
    return () => {
        removeView();
        removeContainer();
    };
}

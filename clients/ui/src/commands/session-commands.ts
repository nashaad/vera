import { showToast } from "../overlays/toasts.ts";
import { activeSession } from "../session/activeSession.ts";
import { conversationText } from "../session/conversationText.ts";
import { cyclePaneLayout, setPaneLayout, type PaneLayout } from "../session/paneLayout.ts";
import { openSessionSheet, type SessionSheet } from "../session/sessionSheets.ts";
import type { CommandRegistry } from "./registry.ts";

export const SESSION_COMMANDS = {
    rewind: "session.rewind",
    compact: "session.compact",
    subagents: "session.subagents",
    tasks: "session.tasks",
    copy: "session.copyConversation",
    cycleLayout: "session.cycleLayout",
    setLayout: "session.setLayout",
} as const;

const SHEETS: ReadonlyArray<readonly [string, string, SessionSheet]> = [
    [SESSION_COMMANDS.rewind, "Rewind or Fork", "rewind"],
    [SESSION_COMMANDS.compact, "Compact Conversation", "compact"],
    [SESSION_COMMANDS.subagents, "Show Subagents", "subagents"],
    [SESSION_COMMANDS.tasks, "Show Background Tasks", "tasks"],
];

const LAYOUTS: readonly PaneLayout[] = ["single", "split", "stack"];

function isPaneLayout(value: unknown): value is PaneLayout {
    return LAYOUTS.some((layout) => layout === value);
}

// Session commands do nothing while no session page is open.
export function registerSessionCommands(registry: CommandRegistry): () => void {
    const disposers = [
        ...SHEETS.map(([id, title, sheet]) => registry.register({
            id,
            title,
            run: () => {
                if (activeSession() !== undefined) openSessionSheet(sheet);
            },
        })),
        registry.register({
            id: SESSION_COMMANDS.copy,
            title: "Copy Conversation",
            run: () => {
                const session = activeSession();
                if (session === undefined) return;
                const text = conversationText(session.title, [...session.watch.history, ...session.watch.live]);
                void navigator.clipboard.writeText(text).then(
                    () => showToast("Conversation copied", "success"),
                    () => showToast("The conversation could not be copied", "danger"),
                );
            },
        }),
        registry.register({ id: SESSION_COMMANDS.cycleLayout, title: "Cycle Agent Panes", run: () => cyclePaneLayout() }),
        registry.register({
            id: SESSION_COMMANDS.setLayout,
            title: "Set Agent Panes",
            needsArgs: true,
            run: (args) => {
                if (isPaneLayout(args)) setPaneLayout(args);
            },
        }),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}

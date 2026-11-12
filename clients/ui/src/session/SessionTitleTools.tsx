import type { MouseEvent } from "react";
import { createPortal } from "react-dom";

import type { MenuEntry } from "../commands/menus.ts";
import { SESSION_COMMANDS } from "../commands/session-commands.ts";
import { MoreIcon } from "../components/Icons.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { shortcutLabel } from "../workbench/hints.ts";
import { useActiveSession, type ActiveSession } from "./activeSession.ts";
import { CompactSheet } from "./CompactSheet.tsx";
import { ContextPill } from "./ContextPill.tsx";
import { usePaneLayout, type PaneLayout } from "./paneLayout.ts";
import { RewindSheet } from "./RewindSheet.tsx";
import { closeSessionSheet, openSessionSheet, useSessionSheet, type SessionSheet } from "./sessionSheets.ts";
import { SubagentsSheet } from "./SubagentsSheet.tsx";
import { TasksIndicator } from "./TasksIndicator.tsx";
import { TasksSheet } from "./TasksSheet.tsx";

const PANE_LABELS: ReadonlyArray<readonly [PaneLayout, string]> = [
    ["single", "One Pane"],
    ["split", "Subagent Beside"],
    ["stack", "Subagent Below"],
];

function sessionMenu(layout: PaneLayout): readonly MenuEntry[] {
    return [
        { kind: "item", label: "Copy Conversation", command: SESSION_COMMANDS.copy },
        { kind: "separator" },
        { kind: "item", label: "Rewind or Fork…", command: SESSION_COMMANDS.rewind },
        { kind: "item", label: "Compact…", command: SESSION_COMMANDS.compact },
        { kind: "item", label: "Subagents", command: SESSION_COMMANDS.subagents },
        { kind: "separator" },
        ...PANE_LABELS.map(([value, label]): MenuEntry => ({
            kind: "item",
            label,
            command: SESSION_COMMANDS.setLayout,
            args: value,
            checked: value === layout,
        })),
    ];
}

// The title bar's tools for the open session: running tasks, context use and the session menu.
export function SessionTitleTools() {
    const session = useActiveSession();
    const sheet = useSessionSheet();
    const { openMenu } = useWorkbench();
    const panes = usePaneLayout();
    if (session === undefined) return null;
    const more = (event: MouseEvent<HTMLButtonElement>): void => {
        const box = event.currentTarget.getBoundingClientRect();
        openMenu(sessionMenu(panes.layout), { x: box.left, y: box.bottom });
    };
    const cycle = shortcutLabel(SESSION_COMMANDS.cycleLayout, window.veraDesktop?.platform ?? "");
    return (
        <span className="title-tools">
            <TasksIndicator session={session} onOpen={() => openSessionSheet("tasks")} />
            <ContextPill session={session} onCompact={() => openSessionSheet("compact")} />
            <button
                type="button"
                className="header-button"
                aria-label="Session menu"
                title={cycle === "" ? "Session menu" : `Session menu (agent panes: ${cycle})`}
                data-session-menu="true"
                onClick={more}
            >
                <MoreIcon />
            </button>
            {sheet === undefined ? null : createPortal(<OpenSheet sheet={sheet} session={session} />, document.body)}
        </span>
    );
}

function OpenSheet({ sheet, session }: { readonly sheet: SessionSheet; readonly session: ActiveSession }) {
    switch (sheet) {
        case "compact":
            return <CompactSheet session={session} onClose={closeSessionSheet} />;
        case "rewind":
            return <RewindSheet session={session} onClose={closeSessionSheet} />;
        case "tasks":
            return <TasksSheet session={session} onClose={closeSessionSheet} />;
        case "subagents":
            return <SubagentsSheet session={session} onClose={closeSessionSheet} />;
    }
}

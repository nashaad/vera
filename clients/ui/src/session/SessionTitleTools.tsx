import type { MouseEvent } from "react";
import { createPortal } from "react-dom";

import type { MenuEntry } from "../commands/menus.ts";
import { SESSION_COMMANDS } from "../commands/session-commands.ts";
import { MoreIcon } from "../components/Icons.tsx";
import { useSurface } from "../state/useSurfaces.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { useActiveSession, type ActiveSession } from "./activeSession.ts";
import { requestCompaction } from "./compact.ts";
import { ContextPill } from "./ContextPill.tsx";
import { RenameSheet } from "./RenameSheet.tsx";
import { RewindSheet } from "./RewindSheet.tsx";
import { closeSessionSheet, openSessionSheet, useSessionSheet, type SessionSheet } from "./sessionSheets.ts";
import { TasksIndicator } from "./TasksIndicator.tsx";
import { TasksSheet } from "./TasksSheet.tsx";

const SESSION_MENU: readonly MenuEntry[] = [
    { kind: "item", label: "Copy Conversation", command: SESSION_COMMANDS.copy },
    { kind: "separator" },
    { kind: "item", label: "Rewind or Fork…", command: SESSION_COMMANDS.rewind },
    { kind: "item", label: "Compact", command: SESSION_COMMANDS.compact },
    { kind: "item", label: "Subagents", command: SESSION_COMMANDS.subagents },
];

// The title bar's tools for the open session: running tasks, context use and the session menu.
export function SessionTitleTools() {
    const session = useActiveSession();
    const sheet = useSessionSheet();
    const { openMenu } = useWorkbench();
    const contextPill = useSurface("contextPill");
    if (session === undefined) return null;
    const more = (event: MouseEvent<HTMLButtonElement>): void => {
        const box = event.currentTarget.getBoundingClientRect();
        openMenu(SESSION_MENU, { x: box.left, y: box.bottom });
    };
    return (
        <span className="title-tools">
            <TasksIndicator session={session} onOpen={() => openSessionSheet("tasks")} />
            {contextPill ? <ContextPill session={session} onCompact={() => requestCompaction(session)} /> : null}
            <button
                type="button"
                className="header-button"
                aria-label="Session menu"
                title="Session menu"
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
        case "rewind":
            return <RewindSheet session={session} onClose={closeSessionSheet} />;
        case "tasks":
            return <TasksSheet session={session} onClose={closeSessionSheet} />;
        case "rename":
            return <RenameSheet session={session} onClose={closeSessionSheet} />;
    }
}

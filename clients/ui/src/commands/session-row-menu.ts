import type { SessionRow } from "../protocol/sessions.ts";
import type { MenuEntry } from "./menus.ts";
import { SESSION_ROW_COMMANDS, type SessionTarget } from "./session-window-commands.ts";

// The menu on a sidebar row. Close is offered only while the host runs the session.
export function sessionRowMenu(row: SessionRow, pinned: boolean): readonly MenuEntry[] {
    const target: SessionTarget = { agentId: row.id, title: row.name, workspace: row.workspace, chat: row.chat };
    const item = (label: string, command: string): MenuEntry => ({ kind: "item", label, command, args: target });
    return [
        item("Rename…", SESSION_ROW_COMMANDS.rename),
        item(pinned ? "Unpin Session" : "Pin Session", SESSION_ROW_COMMANDS.togglePin),
        item("Open Files Pane", SESSION_ROW_COMMANDS.openFiles),
        { kind: "separator" },
        item("Clone Session", SESSION_ROW_COMMANDS.clone),
        ...(row.live ? [item("Close Session", SESSION_ROW_COMMANDS.close)] : []),
    ];
}

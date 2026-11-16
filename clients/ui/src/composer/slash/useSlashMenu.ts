import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";

import { useWorkbench } from "../../workbench/context.tsx";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { useSlashCatalog, type SlashSession } from "./host.ts";
import { buildSlashEntries, defaultSlashIndex, extensionListAction, pendingExtensionListFailureNotice, resolveSlashLine, suggestSlash, type SlashEntry } from "./model.ts";
import { runSlashEntry, type SlashRunContext } from "./run.ts";
import type { SlashMenuView } from "./SlashMenu.tsx";

export interface SlashMenuInput {
    readonly text: string;
    readonly setText: Dispatch<SetStateAction<string>>;
    // Undefined on New Chat, where extension commands come from the host and skills are unavailable.
    readonly session: SlashSession | undefined;
    readonly hostBridge?: DesktopBridge;
    readonly onNewChatExtension?: (line: string) => void;
    // Shows one sentence under the composer, or clears it.
    readonly notify: (text: string | undefined) => void;
}

export interface SlashMenu {
    // Undefined while the menu is closed.
    readonly view: SlashMenuView | undefined;
    // Handles the keys the open menu owns; true when the event was used.
    readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    readonly onBlur: () => void;
    // Runs a typed line as a command. False when it is an ordinary message to send.
    readonly runLine: (line: string) => boolean;
}

const NEW_CHAT_NOTE = "Skills work inside a session.";

interface Moved {
    readonly text: string;
    readonly index: number;
}

// The slash menu and slash lines of one composer. The menu is open while the box holds a
// slash and a name with no space; once a space is typed the rest is the command's arguments.
export function useSlashMenu({ text, setText, session, hostBridge, onNewChatExtension, notify }: SlashMenuInput): SlashMenu {
    const { run } = useWorkbench();
    const catalog = useSlashCatalog(session, text.trimStart().startsWith("/"), hostBridge);
    const entries = useMemo(() => buildSlashEntries(catalog.extensions, catalog.skills), [catalog]);
    const suggestions = useMemo(() => suggestSlash(entries, text), [entries, text]);
    const pendingLine = useRef<string | undefined>(undefined);
    // Escape and leaving the box close the menu for this text; typing more opens it again.
    const [dismissed, setDismissed] = useState<string | undefined>(undefined);
    const [moved, setMoved] = useState<Moved | undefined>(undefined);
    const open = suggestions.length > 0 && dismissed !== text;
    const active = moved?.text === text
        ? Math.min(moved.index, suggestions.length - 1)
        : defaultSlashIndex(suggestions, text);

    const execute = (entry: SlashEntry, args: string, line: string): void => {
        if (session === undefined && entry.action.kind === "extension" && onNewChatExtension !== undefined) {
            notify(undefined);
            onNewChatExtension(line);
            return;
        }
        const context: SlashRunContext = {
            session,
            run,
            notify,
            restore: () => setText((current) => (current.length === 0 ? line : current)),
        };
        notify(undefined);
        setText("");
        void runSlashEntry(entry, args, context);
    };

    const move = (step: number): void => {
        setMoved({ text, index: (active + step + suggestions.length) % suggestions.length });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
        const chosen = suggestions[active];
        if (!open || chosen === undefined || event.nativeEvent.isComposing) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            execute(chosen, "", `/${chosen.name}`);
        } else if (event.key === "Tab" && !event.shiftKey) {
            event.preventDefault();
            setText(`/${chosen.name} `);
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(text);
        } else {
            return false;
        }
        return true;
    };

    const runLine = (line: string): boolean => {
        const resolved = resolveSlashLine(entries, line);
        if (resolved.kind === "prompt") {
            const listAction = extensionListAction(line, catalog.extensionCommandsLoaded, catalog.extensionCommandsLoading);
            if (listAction === "none") return false;
            pendingLine.current = line;
            notify(listAction === "retry" ? "Extension commands could not be loaded. Press Enter to retry." : undefined);
            if (listAction === "retry") catalog.retryExtensionCommands();
            return true;
        }
        if (resolved.kind === "unknown") {
            const listAction = extensionListAction(line, catalog.extensionCommandsLoaded, catalog.extensionCommandsLoading);
            if (listAction !== "none") {
                pendingLine.current = line;
                notify(listAction === "retry" ? "Extension commands could not be loaded. Press Enter to retry." : undefined);
                if (listAction === "retry") catalog.retryExtensionCommands();
                return true;
            }
            notify(session === undefined ? `${resolved.message} ${NEW_CHAT_NOTE}` : resolved.message);
            return true;
        }
        execute(resolved.entry, resolved.args, line);
        return true;
    };

    useEffect(() => {
        const line = pendingLine.current;
        if (line === undefined) return;
        if (!catalog.extensionCommandsLoaded) {
            const failureNotice = pendingExtensionListFailureNotice(true, false, catalog.extensionCommandsFailed);
            if (failureNotice !== undefined) notify(failureNotice);
            return;
        }
        pendingLine.current = undefined;
        notify(undefined);
        runLine(line);
    }, [catalog.extensionCommandsLoaded, catalog.extensionCommandsFailed, entries]);

    const view: SlashMenuView | undefined = open
        ? {
            entries: suggestions,
            active,
            onPick: (entry) => execute(entry, "", `/${entry.name}`),
            onHover: (index) => setMoved({ text, index }),
        }
        : undefined;

    return { view, onKeyDown, onBlur: () => setDismissed(text), runLine };
}

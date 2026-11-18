import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";

import { runBtw, type BtwTabs } from "../../chat/btw.ts";
import { readSidekickOffered, useSidekickOffered } from "../../chat/included.ts";
import { closeChatTab, hasRoomForChatTab, openChatTab, showChatTab, type ChatTabHost } from "../../chat/open.ts";
import { useWorkbench } from "../../workbench/context.tsx";
import type { DesktopBridge } from "../../protocol/bridge.ts";
import { useSlashCatalog, type SlashSession } from "./host.ts";
import { BTW_SLASH_ENTRY, buildSlashEntries, defaultSlashIndex, extensionListAction, pendingExtensionListFailureNotice, resolveSlashLine, suggestSlash, type SlashEntry } from "./model.ts";
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
    const workbench = useWorkbench();
    const { run, hidden } = workbench;
    const latest = useRef(workbench);
    latest.current = workbench;
    const slashStarted = text.trimStart().startsWith("/");
    const catalog = useSlashCatalog(session, slashStarted, hostBridge);
    // The sidekick opens from the main pane's composer; a Chat tab's composer has none of its own.
    const sidekick = session !== undefined && session.pane === "main" ? session : undefined;
    const offered = useSidekickOffered(sidekick?.bridge, slashStarted && sidekick !== undefined);
    const entries = useMemo(
        () => buildSlashEntries(catalog.extensions, catalog.skills, hidden, sidekick !== undefined && offered === true),
        [catalog, hidden, sidekick, offered],
    );
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
        const restore = (): void => setText((current) => (current.length === 0 ? line : current));
        if (session === undefined && entry.action.kind === "extension" && onNewChatExtension !== undefined) {
            notify(undefined);
            onNewChatExtension(line);
            return;
        }
        const context: SlashRunContext = {
            session,
            run,
            notify,
            restore,
            ...(sidekick === undefined ? {} : {
                btw: (args: string) => runBtw(args, {
                    bridge: sidekick.bridge,
                    primary: sidekick.agentId,
                    folder: sidekick.folder,
                    chat: sidekick.chat === true,
                    tabs: sidekickTabs(latest),
                    offered: () => readSidekickOffered(sidekick.bridge),
                    notify,
                    restore,
                }),
            }),
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
        // A line typed before the first read of the extension's state answers still reaches /btw, which checks it itself.
        const early = sidekick !== undefined && offered === undefined ? /^\s*\/btw(?:\s+([\s\S]*))?$/.exec(line) : null;
        if (early !== null) {
            execute(BTW_SLASH_ENTRY, early[1]?.trim() ?? "", line);
            return true;
        }
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

function sidekickTabs(latest: { readonly current: ChatTabHost }): BtwTabs {
    return {
        room: () => hasRoomForChatTab(latest.current),
        open: (seed) => openChatTab(latest.current, seed),
        show: (tab) => showChatTab(latest.current, tab),
        close: (tab) => closeChatTab(latest.current, tab),
    };
}

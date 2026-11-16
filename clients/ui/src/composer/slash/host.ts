import { useEffect, useRef, useState } from "react";

import type { DesktopBridge } from "../../protocol/bridge.ts";
import { freshRequestId } from "../requests.ts";
import type { ExtensionCommandInfo, SkillCommandInfo } from "./model.ts";
import { listExtensionCommandsLine, listSkillsLine, parseSlashReply } from "./wire.ts";

// What the slash menu needs of the open session: its watch connection and whether it is busy.
export interface SlashSession {
    readonly bridge: DesktopBridge;
    readonly agentId: string;
    readonly send: (line: string) => void;
    readonly attached: boolean;
    readonly running: boolean;
}

const REPLY_TIMEOUT_MS = 10_000;

// Writes one line on the session's watch connection and resolves with the first reply that
// `parse` accepts, or undefined if none arrives in time.
export function askSession<Reply extends { readonly requestId: string }>(
    session: Pick<SlashSession, "bridge" | "agentId" | "send">,
    requestId: string,
    line: string,
    parse: (text: string) => Reply | undefined,
    timeoutMs: number = REPLY_TIMEOUT_MS,
): Promise<Reply | undefined> {
    return new Promise((resolve) => {
        const finish = (reply: Reply | undefined): void => {
            clearTimeout(timer);
            off();
            resolve(reply);
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        const off = session.bridge.onEvent((event) => {
            if (event.type !== "session_frame" || event.pane !== "main" || event.agentId !== session.agentId) return;
            const reply = parse(event.text);
            if (reply !== undefined && reply.requestId === requestId) finish(reply);
        });
        session.send(line);
    });
}

export interface SlashCatalog {
    readonly extensions: readonly ExtensionCommandInfo[];
    readonly skills: readonly SkillCommandInfo[];
    readonly extensionCommandsLoaded: boolean;
    readonly extensionCommandsLoading: boolean;
    readonly extensionCommandsFailed: boolean;
    readonly retryExtensionCommands: () => void;
}

const EMPTY: SlashCatalog = {
    extensions: [],
    skills: [],
    extensionCommandsLoaded: false,
    extensionCommandsLoading: false,
    extensionCommandsFailed: false,
    retryExtensionCommands: () => undefined,
};

// Reads the session's extension commands and skills each time a slash line is started, so a skill
// added since the last look shows up. The previous answer stays while the new one loads.
export function useSlashCatalog(session: SlashSession | undefined, open: boolean, hostBridge?: DesktopBridge): SlashCatalog {
    const [catalog, setCatalog] = useState<SlashCatalog>(EMPTY);
    const [requestVersion, setRequestVersion] = useState(0);
    const agentId = session?.agentId;
    const reading = useRef(session);
    reading.current = session;
    const usable = session?.attached === true;

    useEffect(() => setCatalog(EMPTY), [agentId]);

    useEffect(() => {
        const target = reading.current;
        if (!open) return undefined;
        let live = true;
        if (target === undefined) {
            if (hostBridge === undefined) return undefined;
            setCatalog((current) => ({ ...current, extensionCommandsLoading: true, extensionCommandsFailed: false }));
            const requestId = freshRequestId("slash-extensions");
            let off = (): void => undefined;
            const timer = setTimeout(() => {
                off();
                if (live) setCatalog((current) => ({ ...current, extensionCommandsLoading: false, extensionCommandsFailed: true }));
            }, REPLY_TIMEOUT_MS);
            off = hostBridge.onEvent((event) => {
                if (event.type !== "frame") return;
                const reply = parseSlashReply(event.text);
                if (reply?.requestId !== requestId) return;
                if (reply.type === "extension_failed") {
                    clearTimeout(timer);
                    off();
                    if (live) setCatalog((current) => ({ ...current, extensionCommandsLoading: false, extensionCommandsFailed: true }));
                    return;
                }
                if (reply.type !== "extension_commands") return;
                clearTimeout(timer);
                off();
                if (live) setCatalog((current) => ({
                    ...current,
                    extensions: reply.commands,
                    extensionCommandsLoaded: true,
                    extensionCommandsLoading: false,
                    extensionCommandsFailed: false,
                }));
            });
            try {
                hostBridge.send(listExtensionCommandsLine(requestId));
            } catch {
                clearTimeout(timer);
                off();
                setCatalog((current) => ({ ...current, extensionCommandsLoading: false, extensionCommandsFailed: true }));
            }
            return () => {
                live = false;
                clearTimeout(timer);
                off();
            };
        }
        if (!usable) return undefined;
        const skillsId = freshRequestId("slash-skills");
        const commandsId = freshRequestId("slash-extensions");
        setCatalog((current) => ({ ...current, extensionCommandsLoading: true, extensionCommandsFailed: false }));
        void askSession(target, skillsId, listSkillsLine(skillsId), parseSlashReply).then((reply) => {
            if (live && reply?.type === "skills") setCatalog((current) => ({ ...current, skills: reply.skills }));
        });
        void askSession(target, commandsId, listExtensionCommandsLine(commandsId), parseSlashReply).then((reply) => {
            if (!live) return;
            setCatalog((current) => reply?.type === "extension_commands"
                ? { ...current, extensions: reply.commands, extensionCommandsLoaded: true, extensionCommandsLoading: false, extensionCommandsFailed: false }
                : { ...current, extensionCommandsLoading: false, extensionCommandsFailed: true });
        }).catch(() => {
            if (live) setCatalog((current) => ({ ...current, extensionCommandsLoading: false, extensionCommandsFailed: true }));
        });
        return () => {
            live = false;
        };
    }, [open, usable, agentId, hostBridge, requestVersion]);

    return {
        ...catalog,
        retryExtensionCommands: () => setRequestVersion((version) => version + 1),
    };
}

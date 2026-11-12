import type { DesktopBridge } from "../protocol/bridge.ts";
import type { SessionWatch } from "../session/model.ts";
import { NewChatComposer } from "./NewChatComposer.tsx";
import { SessionComposer } from "./SessionComposer.tsx";

export interface SessionComposerProps {
    readonly mode: "session";
    readonly bridge: DesktopBridge;
    readonly agentId: string;
    readonly watch: SessionWatch;
    readonly send: (line: string) => void;
    readonly folder: string | undefined;
    readonly chat: boolean;
}

export interface NewChatComposerProps {
    readonly mode: "new";
    readonly bridge: DesktopBridge;
    // The folder the new session starts in until another is chosen.
    readonly folder?: string;
}

export type ComposerProps = SessionComposerProps | NewChatComposerProps;

export function Composer(props: ComposerProps) {
    return props.mode === "session" ? <SessionComposer {...props} /> : <NewChatComposer {...props} />;
}

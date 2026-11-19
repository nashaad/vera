import type { DraftCaptureOwner } from "./draft-capture-owner.ts";
import type { DesktopBridge, SessionPane } from "../protocol/bridge.ts";
import type { SessionWatch } from "../session/model.ts";
import type { AgentStart } from "../session/agentGate.ts";
import { NewChatComposer } from "./NewChatComposer.tsx";
import { SessionComposer } from "./SessionComposer.tsx";

export interface SessionComposerProps {
    readonly mode: "session";
    readonly bridge: DesktopBridge;
    readonly agentId: string;
    // The connection the session is watched on; the main pane unless a Chat tab shows it.
    readonly pane?: SessionPane;
    readonly watch: SessionWatch;
    readonly send: (line: string) => void;
    readonly folder: string | undefined;
    readonly chat: boolean;
    // Runs after the host moved the session to another folder.
    readonly onMoved: () => void;
    // What the session has answered about the agent it was opened for; a held first prompt waits on it.
    readonly agentStart: AgentStart;
}

export interface NewChatComposerProps {
    readonly mode: "new";
    readonly bridge: DesktopBridge;
    readonly active?: boolean;
    readonly captureOwner?: DraftCaptureOwner;
    // The folder the new session starts in until another is chosen.
    readonly folder?: string;
}

export type ComposerProps = SessionComposerProps | NewChatComposerProps;

export function Composer(props: ComposerProps) {
    return props.mode === "session" ? <SessionComposer {...props} /> : <NewChatComposer {...props} />;
}

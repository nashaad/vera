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
}

export interface NewChatComposerProps {
    readonly mode: "new";
    readonly bridge: DesktopBridge;
}

export type ComposerProps = SessionComposerProps | NewChatComposerProps;

export function Composer(props: ComposerProps) {
    return props.mode === "session" ? <SessionComposer {...props} /> : <NewChatComposer {...props} />;
}

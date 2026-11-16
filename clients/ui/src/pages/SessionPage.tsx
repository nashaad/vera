import { useCallback, useEffect } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import { clearActiveSession, publishActiveSession } from "../session/activeSession.ts";
import { CompanionPane } from "../session/CompanionPane.tsx";
import { Conversation, SessionMessage, type ConversationState } from "../session/Conversation.tsx";
import { usePaneLayout } from "../session/paneLayout.ts";
import { SessionRail } from "../session/SessionRail.tsx";
import { companionFor } from "../session/subagents.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useIsShown } from "../workbench/context.tsx";
import type { SessionRoute } from "./routes.ts";

export interface SessionPageProps {
    readonly route: SessionRoute;
}

export function SessionPage({ route }: SessionPageProps) {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    if (bridge === undefined) {
        return <SessionMessage title={route.title} text="This window has no host bridge." />;
    }
    return <SessionView bridge={bridge} route={route} />;
}

function SessionView({ bridge, route }: { readonly bridge: DesktopBridge; readonly route: SessionRoute }) {
    const { connection } = useViewEnvironment();
    const connected = connection.phase === "attached";
    const panes = usePaneLayout();
    const rightPaneShown = useIsShown("rightPane");
    const companion = panes.layout === "single" ? undefined : companionFor(route.agentId, panes.companion, connection.sessionRows);
    const publish = useCallback((state: ConversationState) => {
        publishActiveSession({ bridge, agentId: route.agentId, ...state });
    }, [bridge, route.agentId]);
    useEffect(() => () => clearActiveSession(route.agentId), [route.agentId]);

    return (
        <Conversation
            bridge={bridge}
            agentId={route.agentId}
            pane="main"
            title={route.title}
            workspace={route.workspace}
            chat={route.chat === true}
            onState={publish}
            rail={rightPaneShown ? null : <SessionRail />}
            {...(companion === undefined ? {} : {
                companion: {
                    layout: panes.layout,
                    node: <CompanionPane key={companion} bridge={bridge} agentId={companion} connected={connected} />,
                },
            })}
        />
    );
}

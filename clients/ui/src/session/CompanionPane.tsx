import { AgentIcon, ArrowRightIcon, XIcon } from "../components/Icons.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { useRouter } from "../pages/router.tsx";
import { sessionPlace } from "../pages/routes.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { closeCompanion } from "./paneLayout.ts";
import { SubagentTranscript } from "./SubagentTranscript.tsx";
import { useSessionWatch } from "./useSessionWatch.ts";

export interface CompanionPaneProps {
    readonly bridge: DesktopBridge;
    readonly agentId: string;
    readonly connected: boolean;
}

// A subagent's conversation beside or below its parent's, read only; its prompts go through the parent.
export function CompanionPane({ bridge, agentId, connected }: CompanionPaneProps) {
    const { connection } = useViewEnvironment();
    const router = useRouter();
    const { watch } = useSessionWatch(bridge, agentId, connected, "companion");
    const row = connection.sessionRows?.find((candidate) => candidate.id === agentId);
    const title = watch.title ?? row?.name ?? "Subagent";

    const goTo = (): void => {
        closeCompanion();
        router.navigate({ kind: "session", agentId, title, ...(row === undefined ? {} : sessionPlace(row.workspace, row.chat)) });
    };

    return (
        <section className="agent-companion" aria-label={title} data-companion={agentId} data-phase={watch.phase}>
            <header className="companion-head">
                <AgentIcon className="companion-icon" />
                <span className="companion-title" title={title}>{title}</span>
                {watch.status === "idle" ? null : <span className="companion-state">{watch.status}</span>}
                <span className="spacer" />
                <button type="button" className="header-button" aria-label="Go to subagent" title="Go to subagent" onClick={goTo}>
                    <ArrowRightIcon />
                </button>
                <button type="button" className="header-button" aria-label="Close pane" title="Close pane" onClick={closeCompanion}>
                    <XIcon />
                </button>
            </header>
            <SubagentTranscript watch={watch} folder={row?.workspace} />
        </section>
    );
}

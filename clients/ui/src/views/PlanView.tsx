import { useMemo } from "react";

import { CheckIcon } from "../components/Icons.tsx";
import { showToast } from "../overlays/toasts.ts";
import { CORE_VIEWS } from "../registry/core.ts";
import { useActiveSession, type ActiveSession } from "../session/activeSession.ts";
import { currentTurnChecklist, latestChecklist } from "../session/changes.ts";
import { gateView } from "../session/liveSession.ts";
import type { Checklist } from "../session/model.ts";
import { StartOffer } from "../session/StartSession.tsx";
import type { ViewProps } from "./env.tsx";

export function PlanView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its plan.</p>;
    return <PlanBody session={session} visible={visible} />;
}

function PlanBody({ session, visible }: { readonly session: ActiveSession; readonly visible: boolean }) {
    const { history, live } = session.watch;
    const gate = gateView(CORE_VIEWS.plan, session.watch);
    const checklist = useMemo<Checklist | undefined>(
        () => (visible ? latestChecklist([...history, ...live]) : undefined),
        [visible, history, live],
    );
    if (gate.kind === "start") return <StartOffer text="This session is not running. Start it to see its plan." onStart={session.start} />;
    if (gate.kind === "unavailable") return <p className="view-empty">{gate.reason}</p>;
    if (checklist === undefined) {
        return <p className="view-empty">No plan in this session yet. Plans appear when Vera writes a checklist.</p>;
    }
    const total = checklist.items.length;
    const done = checklist.items.filter((item) => item.done).length;
    const highlight = session.watch.status !== "idle" && currentTurnChecklist([...history, ...live]) === checklist;
    const openPlan = async (): Promise<void> => {
        const opened = await session.bridge.revealFolder(checklist.path).catch(() => false);
        if (!opened) showToast("The plan file could not be opened", "danger");
    };
    return (
        <div className="plan">
            <div className="plan-head">
                <span className="plan-title">{checklist.title ?? "Plan"}</span>
                <span className="plan-progress">{done} of {total} done</span>
            </div>
            {total === 0 ? null : <progress className="plan-bar" max={total} value={done} aria-label="Plan progress" />}
            <ol className="plan-items">
                {checklist.items.map((item, index) => (
                    <li
                        key={index}
                        className="plan-item"
                        data-done={item.done}
                        data-just-done={highlight && item.justDone}
                    >
                        <span className="plan-mark" aria-hidden="true">
                            {item.done ? <CheckIcon className="plan-check" /> : null}
                        </span>
                        <span className="plan-text">{item.text}</span>
                    </li>
                ))}
            </ol>
            <button type="button" className="plan-path" title={`Open plan file: ${checklist.path}`} aria-label="Open plan file" onClick={() => void openPlan()}>{checklist.path}</button>
        </div>
    );
}

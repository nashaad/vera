import { useMemo } from "react";

import type { SessionWatch } from "./model.ts";
import { Transcript } from "./Transcript.tsx";
import { watchOpening } from "./transcript.ts";
import { usePinnedScroll } from "./usePinnedScroll.ts";
import { useSlowOpening } from "./useSlowOpening.ts";

export interface SubagentTranscriptProps {
    readonly watch: SessionWatch;
    // The folder the child works in, for paths in its tool lines.
    readonly folder?: string | undefined;
}

// A subagent's conversation, read only. The companion pane and the Subagents tab both show it.
export function SubagentTranscript({ watch, folder }: SubagentTranscriptProps) {
    const blocks = useMemo(() => [...watch.history, ...watch.live], [watch.history, watch.live]);
    const scroller = usePinnedScroll();
    const slowOpening = useSlowOpening(watch);
    const message = watch.phase === "failed" || watch.phase === "closed"
        ? watch.error ?? "The subagent closed."
        : !watchOpening(watch)
            ? "The subagent has not said anything yet."
            : slowOpening
                ? "Opening the subagent."
                : undefined;

    return (
        <div className="transcript-scroll" ref={scroller.ref} onScroll={scroller.onScroll}>
            <div className="transcript">
                <div className="transcript-inner">
                    {blocks.length === 0 ? (
                        message === undefined ? null : <p className="transcript-empty">{message}</p>
                    ) : (
                        <Transcript
                            blocks={blocks}
                            running={watch.status !== "idle"}
                            status={watch.status}
                            {...(watch.retry === undefined ? {} : { retry: watch.retry })}
                            {...(folder ? { folder } : {})}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

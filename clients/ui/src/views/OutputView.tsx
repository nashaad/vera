import { useLayoutEffect, useRef } from "react";

import { useOutputLog } from "../state/outputLog.ts";
import { useViewEnvironment, type ViewProps } from "./env.tsx";

function clock(time: number): string {
    return new Date(time).toLocaleTimeString([], { hour12: false });
}

export function OutputView(_props: ViewProps) {
    const { log } = useViewEnvironment();
    const entries = useOutputLog(log);
    const scroller = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);

    // Follows new lines only while the person is already at the bottom.
    useLayoutEffect(() => {
        const element = scroller.current;
        if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
    }, [entries]);

    if (entries.length === 0) return <p className="view-empty">No connection events yet.</p>;
    return (
        <div
            ref={scroller}
            className="output"
            onScroll={(event) => {
                const element = event.currentTarget;
                pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
            }}
        >
            {entries.map((entry) => (
                <div key={entry.id} className="output-line" data-kind={entry.kind}>
                    <span className="output-time">{clock(entry.time)}</span>
                    <span className="output-text">{entry.text}</span>
                </div>
            ))}
        </div>
    );
}

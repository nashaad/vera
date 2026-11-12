import { ListIcon } from "../components/Icons.tsx";
import type { QueuedPrompt } from "./model.ts";

export interface QueueStripProps {
    readonly queue: readonly QueuedPrompt[];
    readonly onRelease: () => void;
}

// The prompts waiting for the running turn to end; the first one is the next to release.
export function QueueStrip({ queue, onRelease }: QueueStripProps) {
    const first = queue[0];
    if (first === undefined) return null;
    const count = queue.length;
    return (
        <div className="queue-strip">
            <ListIcon className="queue-icon" />
            <span className="queue-body">
                <span className="queue-count">{count === 1 ? "1 message queued" : `${count} messages queued`}</span>
                <span className="queue-first">“{first.content}”</span>
            </span>
            <button type="button" className="queue-release" onClick={onRelease}>
                <kbd className="kbd">esc</kbd>
                <span>release oldest</span>
            </button>
        </div>
    );
}

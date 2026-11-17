import type { AnnexPagesAnswer } from "../protocol/bridge.ts";
import { recordRecent, RECENT_TITLE_LIMIT } from "../browser/recents.ts";

interface AnnexFrameProps {
    readonly annex: AnnexPagesAnswer;
    // An annex path, with any query, such as /x/<extension>/<page>?id=1.
    readonly entry: string;
    readonly title: string;
    // Changes when the frame should load again.
    readonly round: number;
    readonly name?: string;
}

// One of the pages the host's annex serves, drawn in a frame. The Browser and every page pane draw it.
export function AnnexFrame({ annex, entry, title, round, name }: AnnexFrameProps) {
    return (
        <iframe
            key={`${annex.url}${entry}:${round}`}
            className="browser-frame"
            title={title}
            name={name}
            src={`${annex.url}${entry.slice(1)}`}
            onLoad={() => recordRecent({ kind: "annex", target: entry, title: title.slice(0, RECENT_TITLE_LIMIT) })}
            sandbox="allow-scripts allow-same-origin allow-forms"
        />
    );
}

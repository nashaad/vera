import type { AnnexPagesAnswer } from "../protocol/bridge.ts";
import { recordRecent, RECENT_TITLE_LIMIT } from "../browser/recents.ts";

interface AnnexFrameProps {
    readonly annex: AnnexPagesAnswer;
    // An annex path, with any query, such as /x/<extension>/<page>?id=1.
    readonly entry: string;
    readonly title: string;
    // Changes when the frame should load again.
    readonly round: number;
}

export function AnnexFrame({ annex, entry, title, round }: AnnexFrameProps) {
    return (
        <iframe
            key={`${annex.url}${entry}:${round}`}
            className="browser-frame"
            title={title}
            src={`${annex.url}${entry.slice(1)}`}
            onLoad={() => recordRecent({ kind: "annex", target: entry, title: title.slice(0, RECENT_TITLE_LIMIT) })}
            sandbox="allow-scripts allow-same-origin allow-forms"
        />
    );
}

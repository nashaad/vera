import { XIcon } from "../components/Icons.tsx";
import type { StandingPermission } from "../session/permissions.ts";

export interface ApprovalStandingProps {
    readonly heading: string;
    readonly entries: readonly StandingPermission[];
    readonly onRemove: (entry: StandingPermission) => void;
}

const SHOWN = 5;

// The first few standing permissions, each with a button to remove it. Nothing renders when there are none.
export function ApprovalStanding({ heading, entries, onRemove }: ApprovalStandingProps) {
    if (entries.length === 0) return null;
    const shown = entries.slice(0, SHOWN);
    const more = entries.length - shown.length;
    return (
        <div className="approval-standing">
            <div className="menu-label">{heading}</div>
            {shown.map((entry) => (
                <div key={entry.id} className="approval-standing-row">
                    <span className="approval-standing-text">{entry.description}</span>
                    <button
                        type="button"
                        className="approval-remove"
                        title="Remove"
                        aria-label={`Remove ${entry.description}`}
                        onClick={() => onRemove(entry)}
                    >
                        <XIcon className="approval-remove-icon" />
                    </button>
                </div>
            ))}
            {more > 0 ? <p className="approval-more">and {more} more</p> : null}
        </div>
    );
}

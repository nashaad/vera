import { WarningIcon } from "../components/Icons.tsx";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface FailuresSheetProps {
    readonly onClose: () => void;
}

export function FailuresSheet({ onClose }: FailuresSheetProps) {
    return (
        <OverlaySheet title="Model Failures" Icon={WarningIcon} onClose={onClose} name="failures">
            <div className="empty-state">
                <p className="empty-state-title">This window cannot read the failure record</p>
                <p className="empty-state-text">
                    Vera records model failures. Run /failure-report in the terminal UI for a report, or open
                    /diagnostics there and look under Model failures. A failed turn also shows its notice in the session.
                </p>
            </div>
        </OverlaySheet>
    );
}

import { BellIcon } from "../components/Icons.tsx";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface NudgesSheetProps {
    readonly onClose: () => void;
}

export function NudgesSheet({ onClose }: NudgesSheetProps) {
    return (
        <OverlaySheet title="Standing Nudges" Icon={BellIcon} onClose={onClose} name="nudges">
            <div className="empty-state">
                <p className="empty-state-title">Standing nudges are managed in the terminal for now</p>
                <p className="empty-state-text">
                    A nudge is a short reminder Vera repeats every few turns. Run /nudges in the terminal UI to add,
                    edit or remove them; they apply to sessions in this window too. This window cannot list them yet.
                </p>
            </div>
        </OverlaySheet>
    );
}

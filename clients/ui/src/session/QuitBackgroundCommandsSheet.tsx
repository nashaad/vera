import { WarningIcon } from "../components/Icons.tsx";
import { OverlaySheet } from "../overlays/OverlaySheet.tsx";

export function quitBackgroundCommandWarningText(count: number): string {
    const command = count === 1 ? "command is" : "commands are";
    return `${count} background ${command} running.`;
}

export function QuitBackgroundCommandsSheet({
    count,
    onCancel,
    onKeepRunning,
    onStop,
}: {
    readonly count: number;
    readonly onCancel: () => void;
    readonly onKeepRunning: () => void;
    readonly onStop: () => void;
}) {
    return (
        <OverlaySheet
            title="Quit Vera?"
            Icon={WarningIcon}
            onClose={onCancel}
            name="quit-background-commands"
            foot={(
                <>
                    <div className="session-sheet-foot-row">
                        <button type="button" className="session-button" onClick={onCancel}>Cancel</button>
                        <button type="button" className="session-button" onClick={onKeepRunning}>Keep running</button>
                        <button type="button" className="button-primary session-sheet-action" onClick={onStop}>Stop and quit</button>
                    </div>
                    <p className="session-sheet-text">Keep running: stops after ten idle minutes.</p>
                </>
            )}
        >
            <p>{quitBackgroundCommandWarningText(count)}</p>
        </OverlaySheet>
    );
}

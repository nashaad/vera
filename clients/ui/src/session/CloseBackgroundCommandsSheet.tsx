import { OverlaySheet } from "../overlays/OverlaySheet.tsx";
import type { SessionTarget } from "../commands/session-window-commands.ts";
import { WarningIcon } from "../components/Icons.tsx";

export interface BackgroundCommandWarning {
    readonly target: SessionTarget;
    readonly count: number;
    readonly confirm: () => void;
}

export function backgroundCommandWarningText(count: number): string {
    const command = count === 1 ? "command is" : "commands are";
    const them = count === 1 ? "it" : "them";
    return `${count} background ${command} running in this conversation. Closing stops ${them}.`;
}

export function CloseBackgroundCommandsSheet({
    warning,
    onCancel,
    onConfirm,
}: {
    readonly warning: BackgroundCommandWarning;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
}) {
    return (
        <OverlaySheet
            title={`Close ${warning.target.title}?`}
            Icon={WarningIcon}
            onClose={onCancel}
            name="close-background-commands"
            foot={(
                <>
                    <button type="button" className="session-button" onClick={onCancel}>Cancel</button>
                    <button type="button" className="button-primary session-sheet-action" onClick={onConfirm}>Stop and close</button>
                </>
            )}
        >
            <p>{backgroundCommandWarningText(warning.count)}</p>
        </OverlaySheet>
    );
}

import { BranchIcon, FolderIcon, LaptopIcon } from "../components/Icons.tsx";
import { CHAT_FOLDER_LABEL, folderName } from "../protocol/sessionGroups.ts";
import { ChatFolderChip, type ChatFolderChipProps } from "./ChatFolderChip.tsx";
import { FolderPicker, type FolderPickerActions } from "./FolderPicker.tsx";
import { FOLDER_MISSING_TITLE } from "./rules.ts";

export const NO_FOLDER_LABEL = "No folder";

export interface ContextChipsProps {
    readonly folder: string | undefined;
    readonly branch: string | undefined;
    // A chat names no folder; its chip says Chat and shows no path.
    readonly chat?: boolean;
    // The session's folder was deleted or moved; the chip keeps the name and turns to a warning.
    readonly missing?: boolean;
    // Present in New Chat, where the folder can be changed; absent in a session, where it is fixed.
    readonly picker?: FolderPickerActions;
    // Present on a chat that can be moved into a folder.
    readonly move?: ChatFolderChipProps;
}

export function ContextChips({ folder, branch, chat = false, missing = false, picker, move }: ContextChipsProps) {
    return (
        <div className="context-chips">
            <span className="chip">
                <LaptopIcon className="chip-icon" />
                This Mac
            </span>
            {picker !== undefined ? (
                <FolderPicker
                    label={folder === undefined ? NO_FOLDER_LABEL : folderName(folder)}
                    folder={folder}
                    {...picker}
                />
            ) : chat && move !== undefined ? (
                <ChatFolderChip {...move} />
            ) : chat ? (
                <span className="chip">
                    <FolderIcon className="chip-icon" />
                    <span className="chip-label">{CHAT_FOLDER_LABEL}</span>
                </span>
            ) : folder === undefined ? null : (
                <span className="chip" title={missing ? FOLDER_MISSING_TITLE : folder} data-missing={missing ? "true" : undefined}>
                    <FolderIcon className="chip-icon" />
                    <span className="chip-label">{folderName(folder)}</span>
                </span>
            )}
            {branch === undefined ? null : (
                <span className="chip chip-ghost" title={branch}>
                    <BranchIcon className="chip-icon" />
                    <span className="chip-label">{branch}</span>
                </span>
            )}
        </div>
    );
}

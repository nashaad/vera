import { BranchIcon, FolderIcon, LaptopIcon } from "../components/Icons.tsx";
import { folderName } from "../protocol/sessionGroups.ts";
import { FolderPicker, type FolderPickerActions } from "./FolderPicker.tsx";

export interface ContextChipsProps {
    readonly folder: string | undefined;
    readonly branch: string | undefined;
    // Present in New Chat, where the folder can be changed; absent in a session, where it is fixed.
    readonly picker?: FolderPickerActions;
}

export function ContextChips({ folder, branch, picker }: ContextChipsProps) {
    return (
        <div className="context-chips">
            <span className="chip">
                <LaptopIcon className="chip-icon" />
                This Mac
            </span>
            {picker !== undefined ? (
                <FolderPicker
                    label={folder === undefined ? "Choose folder" : folderName(folder)}
                    folder={folder}
                    {...picker}
                />
            ) : folder === undefined ? null : (
                <span className="chip" title={folder}>
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

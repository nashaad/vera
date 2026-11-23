import { useState, type MouseEvent } from "react";

import type { MenuEntry } from "../commands/menus.ts";
import { MoreIcon } from "../components/Icons.tsx";
import { showToast, type ToastTone } from "../overlays/toasts.ts";
import { ContextMenu } from "../workbench/ContextMenu.tsx";
import { fileName } from "./changes.ts";
import { copyText } from "./copyText.ts";

export const DIFF_FILE_COPY_PATH = "diff-file-copy-path";
export const DIFF_FILE_OPEN = "diff-file-open";
export const DIFF_FILE_OPEN_IN_FILES = "diff-file-open-in-files";
export const DIFF_FILE_TOGGLE = "diff-file-toggle";

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\/;

export function isAbsolutePath(path: string): boolean {
    return path.startsWith("/") || DRIVE_PATH.test(path) || UNC_PATH.test(path);
}

export function fileMenuEntries(open: boolean, canOpen: boolean, canOpenInFiles = false): readonly MenuEntry[] {
    return [
        { kind: "item", label: "Copy path", command: DIFF_FILE_COPY_PATH },
        ...(canOpenInFiles ? [{ kind: "item" as const, label: "Open file", command: DIFF_FILE_OPEN_IN_FILES }] : []),
        { kind: "item", label: "Open in default app", command: DIFF_FILE_OPEN, disabled: !canOpen },
        { kind: "item", label: open ? "Collapse file" : "Expand file", command: DIFF_FILE_TOGGLE },
    ];
}

export interface FileMenuDeps {
    readonly onToggle: () => void;
    readonly reveal?: ((path: string) => Promise<boolean>) | undefined;
    readonly copy?: ((text: string) => Promise<boolean>) | undefined;
    readonly notify?: ((text: string, tone: ToastTone) => void) | undefined;
}

export async function runFileMenuCommand(command: string, path: string, deps: FileMenuDeps): Promise<void> {
    const copy = deps.copy ?? copyText;
    const notify = deps.notify ?? showToast;
    if (command === DIFF_FILE_COPY_PATH) {
        const copied = await copy(path).catch(() => false);
        if (!copied) notify("The path could not be copied", "danger");
        return;
    }
    if (command === DIFF_FILE_OPEN) {
        if (deps.reveal === undefined || !isAbsolutePath(path)) return;
        const opened = await deps.reveal(path).catch(() => false);
        if (!opened) notify(`Could not open ${fileName(path)}`, "danger");
        return;
    }
    if (command === DIFF_FILE_TOGGLE) deps.onToggle();
}

export interface DiffFileMenuProps {
    readonly path: string;
    readonly open: boolean;
    readonly onToggle: () => void;
    readonly reveal?: ((path: string) => Promise<boolean>) | undefined;
    readonly openInFiles?: (() => void) | undefined;
}

export function DiffFileMenu({ path, open, onToggle, reveal, openInFiles }: DiffFileMenuProps) {
    const [at, setAt] = useState<{ readonly x: number; readonly y: number }>();
    const show = (event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        setAt({ x: box.left, y: box.bottom + 4 });
    };
    return <>
        <button
            type="button"
            className="icon-button diff-file-more"
            aria-label={`File actions for ${path}`}
            aria-haspopup="menu"
            title="File actions"
            onClick={show}
        >
            <MoreIcon />
        </button>
        {at === undefined ? null : (
            <ContextMenu
                entries={fileMenuEntries(open, reveal !== undefined && isAbsolutePath(path), openInFiles !== undefined)}
                x={at.x}
                y={at.y}
                onRun={(command) => {
                    if (command === DIFF_FILE_OPEN_IN_FILES) openInFiles?.();
                    else void runFileMenuCommand(command, path, { reveal, onToggle });
                }}
                onClose={() => setAt(undefined)}
            />
        )}
    </>;
}

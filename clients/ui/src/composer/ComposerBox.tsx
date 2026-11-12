import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";

import { ArrowUpIcon, PlusIcon, SquareIcon } from "../components/Icons.tsx";
import { pastedImagePaths } from "./images.ts";
import { useComposerFit } from "./useComposerFit.ts";

export type SendButtonMode = "send" | "stop";

export interface ComposerBoxProps {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    readonly disabled: boolean;
    readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    readonly buttonMode: SendButtonMode;
    readonly buttonEnabled: boolean;
    readonly onPress: () => void;
    // Files dropped on the box or pasted into it, and image paths pasted as text.
    readonly onFiles: (files: readonly File[]) => void;
    readonly onPaths: (paths: readonly string[]) => void;
    readonly onAttach: () => void;
    readonly attachEnabled: boolean;
    // Controls drawn after the attach button, such as the approval pill.
    readonly barStart?: ReactNode;
    // Controls drawn just before the send button, such as the model and effort pills.
    readonly barEnd?: ReactNode;
}

export function ComposerBox({
    text,
    onText,
    placeholder,
    disabled,
    onKeyDown,
    buttonMode,
    buttonEnabled,
    onPress,
    onFiles,
    onPaths,
    onAttach,
    attachEnabled,
    barStart,
    barEnd,
}: ComposerBoxProps) {
    const [dropping, setDropping] = useState(false);
    const bar = useRef<HTMLDivElement>(null);
    useComposerFit(bar);
    const stop = buttonMode === "stop";

    const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
        if (!attachEnabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
    };
    const onDrop = (event: DragEvent<HTMLDivElement>): void => {
        setDropping(false);
        if (!attachEnabled || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        onFiles([...event.dataTransfer.files]);
    };
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        if (!attachEnabled) return;
        if (event.clipboardData.files.length > 0) {
            event.preventDefault();
            onFiles([...event.clipboardData.files]);
            return;
        }
        const paths = pastedImagePaths(event.clipboardData.getData("text/plain"));
        if (paths.length === 0) return;
        event.preventDefault();
        onPaths(paths);
    };

    return (
        <div
            className="composer"
            data-dropping={dropping}
            onDragOver={onDragOver}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
        >
            <textarea
                className="composer-input"
                rows={2}
                autoFocus
                value={text}
                placeholder={placeholder}
                disabled={disabled}
                onChange={(event) => onText(event.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
            />
            <div className="composer-bar" ref={bar}>
                <button
                    type="button"
                    className="round-button"
                    title="Attach images"
                    aria-label="Attach images"
                    disabled={!attachEnabled}
                    onClick={onAttach}
                >
                    <PlusIcon className="round-icon" />
                </button>
                {barStart}
                <span className="grow" />
                {barEnd}
                <button
                    type="button"
                    className="send-button"
                    data-mode={buttonMode}
                    title={stop ? "Stop this turn" : "Send"}
                    aria-label={stop ? "Stop this turn" : "Send"}
                    disabled={!buttonEnabled}
                    onClick={onPress}
                >
                    {stop ? <SquareIcon className="send-icon" /> : <ArrowUpIcon className="send-icon" />}
                </button>
            </div>
        </div>
    );
}

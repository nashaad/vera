import { useEffect, useState } from "react";

import { MAX_FILE_PREVIEW_BYTES, type DesktopBridge, type FilePreview as Preview } from "../protocol/bridge.ts";
import { byteSize, gutterText, lineCount } from "./files.ts";
import { useTurnsEnded } from "./useTurnsEnded.ts";

export interface FilePreviewProps {
    readonly bridge: DesktopBridge;
    readonly path: string;
    readonly visible: boolean;
    readonly running: boolean;
}

interface Shown {
    readonly path: string;
    readonly preview: Preview;
}

// Read again when the pane comes back into view and when a turn ends, keeping the last text on screen meanwhile.
export function FilePreview({ bridge, path, visible, running }: FilePreviewProps) {
    const [shown, setShown] = useState<Shown | undefined>(undefined);
    const turnsEnded = useTurnsEnded(running);

    useEffect(() => {
        if (!visible) return;
        let current = true;
        void bridge.readFilePreview(path).then((preview) => {
            if (current) setShown({ path, preview });
        });
        return () => {
            current = false;
        };
    }, [bridge, path, visible, turnsEnded]);

    const preview = shown?.path === path ? shown.preview : undefined;
    return (
        <div className="file-preview">
            <PreviewBody preview={preview} />
        </div>
    );
}

function PreviewBody({ preview }: { readonly preview: Preview | undefined }) {
    if (preview === undefined) return <p className="file-preview-note">Reading…</p>;
    if (!preview.ok) return <p className="file-preview-note">{preview.reason}</p>;
    if (preview.text === "") return <p className="file-preview-note">Empty file</p>;
    return (
        <>
            {preview.cut ? (
                <p className="file-preview-note">Showing the first {byteSize(MAX_FILE_PREVIEW_BYTES)} of {byteSize(preview.size)}.</p>
            ) : null}
            <div className="file-preview-text">
                <pre className="file-preview-gutter" aria-hidden="true">{gutterText(lineCount(preview.text))}</pre>
                <pre className="file-preview-lines">{preview.text}</pre>
            </div>
        </>
    );
}

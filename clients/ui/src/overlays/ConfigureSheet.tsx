import { useState } from "react";

import { FileIcon } from "../components/Icons.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { OverlaySheet } from "./OverlaySheet.tsx";

export interface ConfigureSheetProps {
    readonly onClose: () => void;
}

interface ConfigFile {
    readonly name: string;
    readonly path: string;
    readonly holds: string;
}

// Names and contents as the configuration docs describe them.
const CONFIG_FILES: readonly ConfigFile[] = [
    {
        name: "Home config",
        path: "config.json in the Vera home",
        holds: "Provider, model, permission, extension, and hook defaults for this home.",
    },
    {
        name: "TUI preferences",
        path: "tui.json in the Vera home",
        holds: "Theme, layout, animation, live reasoning rows, and the keybindings block.",
    },
    {
        name: "Project config",
        path: ".vera/config.json in the attached workspace",
        holds: "Configuration for the workspace the session is attached to.",
    },
];

export function ConfigureSheet({ onClose }: ConfigureSheetProps) {
    const { connection } = useViewEnvironment();
    const [revealFailed, setRevealFailed] = useState(false);
    const home = connection.ready?.home;
    const bridge = window.veraDesktop as DesktopBridge | undefined;

    const reveal = () => {
        if (home === undefined || bridge === undefined) return;
        setRevealFailed(false);
        bridge.revealFolder(home).then(
            (opened) => setRevealFailed(!opened),
            () => setRevealFailed(true),
        );
    };

    return (
        <OverlaySheet title="Configuration Files" Icon={FileIcon} onClose={onClose} name="configure">
            <p className="dialog-text">
                This window does not edit configuration. Use <code>/configure</code> in a terminal to open a file in your editor.
            </p>
            <ul className="dialog-rows">
                {CONFIG_FILES.map((file) => (
                    <li key={file.name} className="dialog-row">
                        <FileIcon className="dialog-row-icon" />
                        <span className="dialog-row-body">
                            <span className="dialog-row-name">{file.name}</span>
                            <span className="dialog-row-detail"><code>{file.path}</code></span>
                            <span className="dialog-row-detail">{file.holds}</span>
                        </span>
                    </li>
                ))}
            </ul>
            <div className="dialog-actions">
                <button type="button" className="ghost-btn" disabled={home === undefined || bridge === undefined} onClick={reveal}>
                    Show the Vera home
                </button>
                {home === undefined ? <span className="dialog-text">The host has not reported its home yet.</span> : null}
            </div>
            {revealFailed ? <p className="dialog-note" data-tone="danger" role="alert">Vera could not open the home folder.</p> : null}
        </OverlaySheet>
    );
}

import { useCallback } from "react";

import type { CommandRegistry } from "../commands/registry.ts";
import { AgentSheet } from "./AgentSheet.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { ConfigureSheet } from "./ConfigureSheet.tsx";
import { DiagnosticsSheet } from "./DiagnosticsSheet.tsx";
import { DoctorSheet } from "./DoctorSheet.tsx";
import { ExtensionsSheet } from "./ExtensionsSheet.tsx";
import { FailuresSheet } from "./FailuresSheet.tsx";
import { NudgesSheet } from "./NudgesSheet.tsx";
import { ShortcutsSheet } from "./ShortcutsSheet.tsx";
import { closeOverlay, useOverlay } from "./store.ts";
import { ThemesSheet } from "./ThemesSheet.tsx";
import { Toasts } from "./Toasts.tsx";

export function Overlays({ commands }: { readonly commands: CommandRegistry }) {
    const overlay = useOverlay();
    const onClose = useCallback(() => closeOverlay(), []);
    return (
        <>
            {overlay === "palette" ? <CommandPalette mode="commands" commands={commands} onClose={onClose} /> : null}
            {overlay === "sessions" ? <CommandPalette mode="sessions" commands={commands} onClose={onClose} /> : null}
            {overlay === "shortcuts" ? <ShortcutsSheet onClose={onClose} /> : null}
            {overlay === "agent" ? <AgentSheet onClose={onClose} /> : null}
            {overlay === "themes" ? <ThemesSheet onClose={onClose} /> : null}
            {overlay === "extensions" ? <ExtensionsSheet onClose={onClose} /> : null}
            {overlay === "diagnostics" ? <DiagnosticsSheet onClose={onClose} /> : null}
            {overlay === "doctor" ? <DoctorSheet onClose={onClose} /> : null}
            {overlay === "configure" ? <ConfigureSheet onClose={onClose} /> : null}
            {overlay === "failures" ? <FailuresSheet onClose={onClose} /> : null}
            {overlay === "nudges" ? <NudgesSheet onClose={onClose} /> : null}
            <Toasts />
        </>
    );
}

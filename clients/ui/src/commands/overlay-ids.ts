// Window-wide sheets and the palette. One is open at a time; opening another replaces it.
export type Overlay =
    | "palette"
    | "sessions"
    | "shortcuts"
    | "agent"
    | "themes"
    | "extensions"
    | "diagnostics"
    | "doctor"
    | "configure"
    | "failures"
    | "nudges";

export const OVERLAY_COMMANDS: Readonly<Record<Overlay, { readonly id: string; readonly title: string }>> = {
    palette: { id: "palette.commands", title: "Command Palette" },
    sessions: { id: "palette.sessions", title: "Go to Session" },
    shortcuts: { id: "help.shortcuts", title: "Keyboard Shortcuts" },
    agent: { id: "session.chooseAgent", title: "Choose Agent" },
    themes: { id: "theme.choose", title: "Choose Theme" },
    extensions: { id: "help.extensions", title: "Extensions" },
    diagnostics: { id: "help.diagnostics", title: "Session Diagnostics" },
    doctor: { id: "help.doctor", title: "Check Vera's Health" },
    configure: { id: "help.configure", title: "Configuration Files" },
    failures: { id: "help.failures", title: "Model Failures" },
    nudges: { id: "help.nudges", title: "Standing Nudges" },
};

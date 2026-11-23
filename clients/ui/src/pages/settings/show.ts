import { OVERLAY_COMMANDS } from "../../commands/overlay-ids.ts";
import { FLAG_SPECS, type FlagChoice, type FlagGroup, type FlagKey, type FlagSpec } from "../../state/desktopFlags.ts";

export interface ShowRow {
    readonly key: FlagKey;
    readonly name: string;
    readonly description: string;
}

export const SHOW_CHOICE_LABELS: Readonly<Record<FlagChoice, string>> = { auto: "Auto", on: "On", off: "Off" };

export const SHOW_GROUP_TITLES: Readonly<Record<FlagGroup, string>> = {
    window: "Parts of the window",
    developer: "For developers",
};

const AUTO = "Auto shows";

export const SHOW_ROWS: readonly ShowRow[] = [
    { key: "search", name: "Search", description: `The Search page, its sidebar entry and its command. ${AUTO} them once a session exists.` },
    { key: "work", name: "Work", description: `The Work page, its sidebar entry and its command. ${AUTO} them once there are two sessions.` },
    { key: "customize", name: "Plugins", description: `The Plugins page, its sidebar entry and its command. ${AUTO} them once a folder has a session.` },
    { key: "review", name: "Review", description: `The Review pane and the Review button in a session. ${AUTO} them once the open session has changed files.` },
    { key: "changes", name: "Changes", description: `The Changes pane and its menu entry. ${AUTO} it in a session that has a folder.` },
    { key: "plan", name: "Plan", description: `The Plan pane. ${AUTO} it once the open session has a checklist.` },
    { key: "files", name: "Files", description: `The Files pane and its menu entry. ${AUTO} them in a session that has a folder.` },
    { key: "output", name: "Output", description: `The Output panel and its toggle. ${AUTO} them once the connection log holds a warning or an error.` },
    { key: "browser", name: "Browser", description: "The Browser pane and its commands." },
    { key: "contextPill", name: "Context use", description: `Context use in the title bar. ${AUTO} it once the open session has reported it.` },
    { key: "showReasoning", name: "Reasoning", description: "The model's reasoning text in the transcript." },
    { key: "doctor", name: OVERLAY_COMMANDS.doctor.title, description: `The health check in the Help menu and the palette. ${AUTO} it once the connection to the host has failed.` },
    { key: "devices", name: "Devices", description: "The Devices page and its sidebar entry." },
    { key: "tour", name: "Tour", description: "The Tour page and its sidebar entry." },
    { key: "coverage", name: "Coverage", description: "The Coverage page and its command." },
    { key: "diagnostics", name: OVERLAY_COMMANDS.diagnostics.title, description: "The diagnostics sheet and its command." },
    { key: "failures", name: OVERLAY_COMMANDS.failures.title, description: "The model failures sheet and its command." },
    { key: "configure", name: OVERLAY_COMMANDS.configure.title, description: "The configuration files sheet and its command." },
    { key: "nudges", name: OVERLAY_COMMANDS.nudges.title, description: "The standing nudges sheet and its command." },
    { key: "extensions", name: OVERLAY_COMMANDS.extensions.title, description: "The extensions sheet and its command." },
    { key: "buildLine", name: "Host build", description: "The host build line at the foot of the sidebar." },
];

export function choicesFor(spec: FlagSpec): readonly FlagChoice[] {
    return spec.auto ? ["auto", "on", "off"] : ["on", "off"];
}

export function rowsIn(group: FlagGroup): readonly (ShowRow & { readonly spec: FlagSpec })[] {
    return FLAG_SPECS.filter((spec) => spec.group === group).map((spec) => {
        const row = SHOW_ROWS.find((candidate) => candidate.key === spec.key);
        if (row === undefined) throw new Error(`No Show row for ${spec.key}.`);
        return { ...row, spec };
    });
}

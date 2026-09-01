
export type TuiKeyScope =
    | "global"
    | "conversation"
    | "composer"
    | "unfocused"
    | "workspace"
    | "picker"
    | "model_picker"
    | "model_assignment_picker"
    | "session_picker"
    | "secret_prompt"
    | "provider_form"
    | "preferences_list"
    | "approval"
    | "question"
    | "help"
    | "dials"
    | "diagnostics"
    | "search";

export const TUI_KEY_SCOPES: readonly TuiKeyScope[] = [
    "global",
    "conversation",
    "composer",
    "unfocused",
    "workspace",
    "picker",
    "model_picker",
    "model_assignment_picker",
    "session_picker",
    "secret_prompt",
    "provider_form",
    "preferences_list",
    "approval",
    "question",
    "help",
    "diagnostics",
    "search",
];

export function isTuiKeyScope(value: unknown): value is TuiKeyScope {
    return typeof value === "string"
        && (TUI_KEY_SCOPES as readonly string[]).includes(value);
}

const OVERLAY_SCOPES: readonly TuiKeyScope[] = [
    "picker",
    "model_picker",
    "model_assignment_picker",
    "session_picker",
    "secret_prompt",
    "provider_form",
    "preferences_list",
    "approval",
    "question",
    "help",
    "dials",
    "diagnostics",
    "search",
];

const PICKER_SCOPES: readonly TuiKeyScope[] = [
    "picker",
    "model_picker",
    "model_assignment_picker",
    "session_picker",
];

const HALF_PAGE_IDS: ReadonlySet<string> = new Set([
    "half_page_down",
    "half_page_up",
]);

export interface TuiBinding {
    readonly id: string;
    readonly keys: readonly string[];
    readonly scope: TuiKeyScope;
    readonly description: string;
    readonly hint?: string;
    readonly anyModifiers?: true;
    readonly overrides?: readonly string[];
    readonly extensionId?: string;
    readonly remappable?: boolean;
}

export interface TuiKeymapConflict {
    readonly chord: string;
    readonly left: string;
    readonly right: string;
}

const WORKSPACE_JUMP_BINDINGS: readonly TuiBinding[] = Array.from(
    { length: 9 },
    (_unused, index): TuiBinding => {
        const position = index + 1;
        return {
            id: `workspace_jump_${position}`,
            keys: [`${position}`],
            scope: "workspace",
            description: `Jump to row ${position} of the workspace list`,
        };
    },
);

export const WORKSPACE_JUMP_IDS: readonly string[] = WORKSPACE_JUMP_BINDINGS
    .map((binding) => binding.id);

export const TUI_KEYMAP: readonly TuiBinding[] = [
    {
        id: "open_palette",
        keys: ["ctrl+p"],
        scope: "global",
        description: "Open the command palette",
        hint: "ctrl+p commands",
        anyModifiers: true,
        remappable: true,
    },
    {
        id: "interrupt",
        keys: ["ctrl+c"],
        scope: "global",
        description: "Clear a draft, stop the current turn, or quit when idle",
        hint: "ctrl+c stop",
        anyModifiers: true,
    },
    {
        id: "toggle_thinking",
        keys: ["ctrl+o"],
        scope: "global",
        description: "Show or hide the model's reasoning",
        hint: "ctrl+o reasoning",
    },
    {
        id: "toggle_session_header",
        keys: ["ctrl+shift+h"],
        scope: "global",
        description: "Show or hide the focused session header",
        hint: "ctrl+shift+h header",
    },
    {
        id: "cycle_agent_layout",
        keys: ["ctrl+\\", "ctrl+/", "ctrl+_"],
        scope: "global",
        description: "Cycle split and single-agent layouts",
        extensionId: "cycle-agent-layout",
    },
    {
        id: "switch_pane",
        keys: ["ctrl+g"],
        scope: "global",
        description: "Cycle focus between the visible panes",
        hint: "ctrl+g pane",
        extensionId: "switch-agent-pane",
    },
    {
        // Every terminal reports ctrl+e, so the side bar is reachable without the kitty keyboard protocol.
        id: "toggle_workspace_sidebar",
        keys: ["ctrl+e"],
        scope: "global",
        description: "Show or hide the agent sidebar",
        hint: "ctrl+e agent sidebar",
    },
    {
        id: "cycle_live_session_prev",
        keys: ["ctrl+shift+[", "ctrl+shift+{", "ctrl+{"],
        scope: "global",
        description: "Switch to the previous live session",
        hint: "ctrl+shift+[ prev session",
    },
    {
        id: "cycle_live_session_next",
        keys: ["ctrl+shift+]", "ctrl+shift+}", "ctrl+}"],
        scope: "global",
        description: "Switch to the next live session",
        hint: "ctrl+shift+] next session",
    },
    ...WORKSPACE_JUMP_BINDINGS,
    {
        id: "toggle_workspace_pin",
        keys: ["p"],
        scope: "workspace",
        description: "Pin or unpin the selected session",
    },
    {
        id: "workspace_new_session",
        keys: ["ctrl+n"],
        scope: "workspace",
        description: "Start a new chat without stopping the current one",
        hint: "^n new",
    },
    {
        id: "workspace_rename_session",
        keys: ["r"],
        scope: "workspace",
        description: "Rename the selected session",
        hint: "r rename",
        remappable: true,
    },
    {
        id: "workspace_resume_picker",
        keys: ["ctrl+r"],
        scope: "workspace",
        description: "Open the full list of conversations",
        hint: "^r all sessions",
        remappable: true,
    },
    {
        id: "toggle_tool_details",
        keys: ["ctrl+t"],
        scope: "conversation",
        description: "Show or hide tool details",
        hint: "ctrl+t details",
    },
    {
        id: "scroll_line_up",
        keys: ["ctrl+up"],
        scope: "conversation",
        description: "Scroll the transcript up one line",
    },
    {
        id: "scroll_line_down",
        keys: ["ctrl+down"],
        scope: "conversation",
        description: "Scroll the transcript down one line",
    },
    // Ctrl-D/U are the familiar half-page transcript movement keys. The shifted letter aliases remain for terminals using the kitty keyboard protocol, while the arrow bindings work ev…
    {
        id: "scroll_half_page_up",
        keys: ["ctrl+shift+up", "ctrl+shift+u", "ctrl+u"],
        scope: "conversation",
        description: "Scroll the transcript half a page up",
    },
    {
        id: "scroll_half_page_down",
        keys: ["ctrl+shift+down", "ctrl+shift+d", "ctrl+d"],
        scope: "conversation",
        description: "Scroll the transcript half a page down",
    },
    {
        id: "jump_to_bottom",
        keys: ["ctrl+end", "ctrl+shift+g"],
        scope: "conversation",
        description: "Follow the transcript from the bottom again",
        hint: "ctrl+end",
    },
    {
        id: "search_conversation",
        keys: ["ctrl+f"],
        scope: "global",
        description: "Find in this conversation",
        hint: "ctrl+f find",
        remappable: true,
    },
    {
        id: "search_sessions",
        keys: ["ctrl+shift+f"],
        scope: "global",
        description: "Search every session",
        hint: "ctrl+shift+f search",
        remappable: true,
    },
    {
        id: "open_model_picker",
        keys: ["ctrl+shift+m"],
        scope: "global",
        description: "Open the model picker",
        hint: "ctrl+shift+m model",
        remappable: true,
    },
    {
        id: "jump.open",
        keys: ["ctrl+shift+j"],
        scope: "global",
        description: "Open the jump menu: back, needs you, parent and children",
        hint: "ctrl+shift+j jump",
        remappable: true,
    },
    {
        id: "cycle-reasoning",
        keys: ["ctrl+y"],
        scope: "global",
        description: "Cycle the current model's reasoning level",
        hint: "ctrl+y",
        extensionId: "cycle-reasoning",
    },
    {
        id: "dials.open",
        keys: ["shift+tab", "backtab"],
        scope: "global",
        description: "Open the dial strip: model and reasoning effort",
        hint: "shift+tab HUD",
        remappable: true,
    },
    {
        id: "dials.pair.prev",
        keys: ["left"],
        scope: "dials",
        description: "Move to the pair on the left",
        remappable: true,
    },
    {
        id: "dials.pair.next",
        keys: ["right"],
        scope: "dials",
        description: "Move to the pair on the right",
        remappable: true,
    },
    {
        id: "dials.effort.up",
        keys: ["up"],
        scope: "dials",
        description: "Raise the reasoning effort on the highlighted pair",
        remappable: true,
    },
    {
        id: "dials.effort.down",
        keys: ["down"],
        scope: "dials",
        description: "Lower the reasoning effort on the highlighted pair",
        remappable: true,
    },
    {
        id: "complete_command",
        keys: ["tab"],
        scope: "composer",
        description: "Complete the slash command being typed",
    },
    {
        id: "close_session",
        keys: ["ctrl+w"],
        scope: "composer",
        description: "Stop this conversation and keep the file",
        hint: "ctrl+w close",
    },
    {
        id: "focus_composer",
        keys: ["i", "right"],
        scope: "unfocused",
        description: "Put the cursor back in the composer",
    },
    {
        id: "half_page_down",
        keys: ["ctrl+d"],
        scope: "picker",
        description: "Move the cursor half a page down",
    },
    {
        id: "half_page_up",
        keys: ["ctrl+u"],
        scope: "picker",
        description: "Move the cursor half a page up",
    },
    {
        id: "toggle_pooled",
        keys: ["ctrl+s"],
        scope: "model_picker",
        description: "Pin the selected model to your shortlist, or unpin it",
        hint: "^s pin",
    },
    {
        id: "toggle_subagent_assignment",
        keys: ["p"],
        scope: "model_assignment_picker",
        description: "Assign the selected model to subagents, or remove it",
        hint: "p assign",
    },
    {
        id: "undo_pool_change",
        keys: ["ctrl+z"],
        scope: "model_picker",
        description: "Undo the last shortlist add or remove",
        hint: "^z undo",
    },
    {
        id: "refresh_catalog",
        keys: ["ctrl+f"],
        scope: "model_picker",
        description: "Ask the highlighted row's provider for its model list now",
        hint: "^f refresh",
        overrides: ["search_conversation"],
    },
    {
        id: "verify_pool",
        keys: ["ctrl+shift+v"],
        scope: "model_picker",
        description: "Probe the models you keep, and record what they can do",
        hint: "^⇧v verify all",
    },
    {
        id: "verify_model",
        keys: ["ctrl+v"],
        scope: "model_picker",
        description: "Probe the selected model and record what it can do",
        hint: "^v verify",
    },
    {
        id: "move_pooled_up",
        keys: ["shift+up"],
        scope: "model_picker",
        description: "Move the selected shortlisted model up the order",
        hint: "⇧↑ move up",
        remappable: true,
    },
    {
        id: "move_pooled_down",
        keys: ["shift+down"],
        scope: "model_picker",
        description: "Move the selected shortlisted model down the order",
        hint: "⇧↓ move down",
        remappable: true,
    },
    {
        id: "name_pooled",
        keys: ["ctrl+n"],
        scope: "model_picker",
        description: "Name the selected shortlisted model",
        hint: "^n name",
    },
    {
        id: "open_providers",
        keys: ["ctrl+e"],
        scope: "model_picker",
        description: "Connect or disconnect a provider",
        hint: "^e providers",
        overrides: ["toggle_workspace_sidebar"],
    },
    {
        id: "declare_provider",
        keys: ["ctrl+shift+n"],
        scope: "model_picker",
        description: "Declare a provider Vera does not ship",
        hint: "^⇧n declare",
    },
    {
        id: "edit_endpoint",
        keys: ["ctrl+r"],
        scope: "model_picker",
        description: "Change where the selected provider answers",
        hint: "^r endpoint",
    },
    {
        id: "forget_provider",
        keys: ["delete"],
        scope: "model_picker",
        description: "Forget the selected provider's stored credential",
        hint: "del forget",
    },
    {
        id: "reveal_all_models",
        keys: ["ctrl+a"],
        scope: "model_picker",
        description: "Show every model, including the folded ones",
        hint: "^a show all",
    },
    {
        id: "switch_tab",
        keys: ["tab", "shift+tab"],
        scope: "model_picker",
        description: "Switch between the shortlist and all models",
        hint: "tab switch",
        overrides: ["dials.open"],
    },
    {
        id: "rename_session",
        keys: ["ctrl+r"],
        scope: "session_picker",
        description: "Rename the selected session",
        hint: "^r rename",
    },
    {
        id: "background_switch",
        keys: ["tab"],
        scope: "session_picker",
        description: "Keep the current conversation running and switch",
        hint: "tab keep running",
        overrides: ["dials.open"],
    },
    {
        id: "trash_session",
        keys: ["delete"],
        scope: "session_picker",
        description: "Move the selected session to the trash",
        hint: "del trash",
    },
    {
        id: "write_notes",
        keys: ["tab"],
        scope: "question",
        description: "Type notes alongside the highlighted answer",
        hint: "tab notes",
    },
    {
        id: "expand_call",
        keys: ["ctrl+r"],
        scope: "approval",
        description: "Show the whole call being approved",
        hint: "ctrl+r expand",
    },
    {
        id: "clear_secret",
        keys: ["ctrl+u"],
        scope: "secret_prompt",
        description: "Clear the entered key",
        hint: "^u clear",
    },
    {
        id: "next_form_field",
        keys: ["tab"],
        scope: "provider_form",
        description: "Move to the next field",
        hint: "tab field",
    },
    {
        id: "previous_form_field",
        keys: ["shift+tab", "backtab"],
        scope: "provider_form",
        description: "Move to the previous field",
        overrides: ["dials.open"],
    },
    {
        id: "revoke_permission",
        keys: ["delete", "backspace"],
        scope: "preferences_list",
        description: "Revoke the selected grant or preference",
        hint: "[del] remove",
    },
    {
        id: "collapse_all",
        keys: ["shift+left"],
        scope: "model_picker",
        description: "Close every section in the list",
        hint: "⇧← fold all",
    },
    {
        id: "expand_all",
        keys: ["shift+right"],
        scope: "model_picker",
        description: "Open every section in the list",
        hint: "⇧→ open all",
    },
    {
        id: "next_help_tab",
        keys: ["tab", "right"],
        scope: "help",
        description: "Move to the next help tab",
        hint: "tab next",
    },
    {
        id: "cycle_search_filter",
        keys: ["tab"],
        scope: "search",
        description: "Cycle search between messages, tools and files",
        hint: "tab filter",
    },
    {
        id: "toggle_search_scope",
        keys: ["ctrl+w"],
        scope: "search",
        description: "Cycle the search scope",
        hint: "ctrl+w scope",
    },
    {
        id: "switch_diagnostics_scope",
        keys: ["tab", "shift+tab", "backtab"],
        scope: "diagnostics",
        description: "Show this session's diagnostics or the whole host's",
        hint: "tab scope",
        overrides: ["dials.open"],
    },
    {
        id: "check_provider_health",
        keys: ["v"],
        scope: "diagnostics",
        description: "Ask the shortlist whether a provider can answer right now",
        hint: "v check",
    },
];

let ACTIVE_KEYMAP: readonly TuiBinding[] = TUI_KEYMAP;

export function installTuiKeymap(bindings: readonly TuiBinding[]): void {
    ACTIVE_KEYMAP = bindings;
}

export function activeTuiKeymap(): readonly TuiBinding[] {
    return ACTIVE_KEYMAP;
}

export interface TuiChordKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export function tuiChord(key: TuiChordKey): string | undefined {
    return key.meta || key.option || key.super || key.hyper
        ? undefined
        : coreChord(key);
}

export function isTuiComposerClearKey(key: TuiChordKey): boolean {
    return key.option !== true
        && (key.meta === true || key.super === true)
        && (key.name === "delete" || key.name === "backspace");
}

export function tuiComposerWordDeleteDirection(
    key: TuiChordKey,
): "backward" | "forward" | undefined {
    if (key.option !== true) return undefined;
    if (key.name === "backspace") return "backward";
    if (key.name === "delete") return "forward";
    return undefined;
}

export function isTuiDialTabKey(key: TuiChordKey): boolean {
    return key.name === "tab" || key.name === "backtab";
}

function coreChord(key: TuiChordKey): string {
    return [
        ...(key.ctrl ? ["ctrl"] : []),
        ...(key.shift ? ["shift"] : []),
        key.name,
    ].join("+");
}

export function tuiBindingId(
    scope: TuiKeyScope,
    key: TuiChordKey,
): string | undefined {
    const exact = tuiChord(key);
    const loose = coreChord(key);
    const matches = ACTIVE_KEYMAP.filter((binding) => {
        if (!appliesIn(binding, scope)) {
            return false;
        }
        const chord = binding.anyModifiers === true ? loose : exact;
        return chord !== undefined && binding.keys.includes(chord);
    });
    return matches.find((binding) => binding.scope === scope)?.id
        ?? matches[0]?.id;
}

export function tuiKeyHint(id: string): string {
    return ACTIVE_KEYMAP.find((binding) => binding.id === id)?.hint ?? "";
}

export function tuiKeyChord(id: string): string {
    return ACTIVE_KEYMAP.find((binding) => binding.id === id)?.keys[0] ?? "";
}

export function tuiClaimedChords(scope: TuiKeyScope): readonly string[] {
    return ACTIVE_KEYMAP.filter((binding) => appliesIn(binding, scope))
        .flatMap((binding) => binding.keys);
}

export function tuiChordOwner(
    chord: string,
    scope: TuiKeyScope = "global",
): TuiBinding | undefined {
    return ACTIVE_KEYMAP.find((binding) =>
        appliesIn(binding, scope) && binding.keys.includes(chord)
    );
}

export function tuiKeymapConflicts(
    bindings: readonly TuiBinding[] = TUI_KEYMAP,
): readonly string[] {
    return tuiKeymapConflictPairs(bindings)
        .map(({ chord, left, right }) => `${chord}: ${left} and ${right}`);
}

export function tuiKeymapConflictPairs(
    bindings: readonly TuiBinding[] = TUI_KEYMAP,
): readonly TuiKeymapConflict[] {
    const conflicts: TuiKeymapConflict[] = [];
    for (const [index, binding] of bindings.entries()) {
        for (const other of bindings.slice(index + 1)) {
            if (!overlaps(binding.scope, other.scope)) {
                continue;
            }
            if (standsDownFor(binding, other) || standsDownFor(other, binding)) {
                continue;
            }
            for (const chord of binding.keys) {
                if (other.keys.includes(chord)) {
                    if (
                        binding.overrides?.includes(other.id) === true
                        || other.overrides?.includes(binding.id) === true
                    ) {
                        continue;
                    }
                    conflicts.push({
                        chord,
                        left: binding.id,
                        right: other.id,
                    });
                }
            }
        }
    }
    return conflicts;
}

function standsDownFor(binding: TuiBinding, other: TuiBinding): boolean {
    return binding.extensionId !== undefined
        && OVERLAY_SCOPES.includes(other.scope);
}

function appliesIn(binding: TuiBinding, scope: TuiKeyScope): boolean {
    if (binding.scope === scope) {
        return true;
    }
    if (binding.extensionId !== undefined && OVERLAY_SCOPES.includes(scope)) {
        return false;
    }
    if (binding.scope === "global") {
        return true;
    }
    if (binding.scope === "picker" && PICKER_SCOPES.includes(scope)) {
        return true;
    }
    return HALF_PAGE_IDS.has(binding.id)
        && (scope === "workspace" || scope === "search");
}

function overlaps(left: TuiKeyScope, right: TuiKeyScope): boolean {
    if (left === right || left === "global" || right === "global") {
        return true;
    }
    const pickerish = (scope: TuiKeyScope) => PICKER_SCOPES.includes(scope);
    return left === "picker" ? pickerish(right) : right === "picker"
        && pickerish(left);
}

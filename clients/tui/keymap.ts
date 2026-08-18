/**
 * Every named key action in the TUI, in one table.
 *
 * Bindings used to be written wherever they were handled: raw byte parsing for
 * ctrl+c and ctrl+p, the global keypress handler, a `key.ctrl && key.name` test
 * inside each overlay, and a separate registry that only extensions could write
 * to. Nothing compared them, so a chord claimed twice was decided by whichever
 * handler happened to run first, and the hint text that told the user about it
 * was prose typed next to the handler rather than anything derived from it.
 *
 * What belongs here is a key with a name a user could look up: ctrl+p, delete,
 * shift+tab. What does not is structural input, meaning cursor movement, text
 * entry, and the enter/escape pair that every overlay reads as accept and
 * cancel. Those are not bindings anyone rebinds or forgets; putting them in the
 * table would triple it and describe the same thing in every row.
 */

/**
 * Where a binding applies.
 *
 * `picker` is the shared behaviour of every settings pane, and the panes that
 * name themselves carry it too, which is how ctrl+d reaches all of them while
 * ctrl+s reaches only the model pane.
 *
 * `unfocused` is the state where no overlay is open and the composer does not
 * hold focus, so its keys cannot collide with the composer's own.
 */
export type TuiKeyScope =
    | "global"
    | "conversation"
    | "composer"
    | "unfocused"
    | "picker"
    | "model_picker"
    | "session_picker"
    | "secret_prompt"
    | "provider_form"
    | "preferences_list"
    | "approval"
    | "question"
    | "help"
    | "dials";

/** Every scope name, for validating one that arrived from an extension. */
export const TUI_KEY_SCOPES: readonly TuiKeyScope[] = [
    "global",
    "conversation",
    "composer",
    "unfocused",
    "picker",
    "model_picker",
    "session_picker",
    "secret_prompt",
    "provider_form",
    "preferences_list",
    "approval",
    "question",
    "help",
];

export function isTuiKeyScope(value: unknown): value is TuiKeyScope {
    return typeof value === "string"
        && (TUI_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * The scopes that only exist while an overlay owns the screen.
 *
 * An extension's chord stands down for as long as one is open, so a binding an
 * extension owns is not reachable here and cannot collide with what the
 * overlay claims.
 */
const OVERLAY_SCOPES: readonly TuiKeyScope[] = [
    "picker",
    "model_picker",
    "session_picker",
    "secret_prompt",
    "provider_form",
    "preferences_list",
    "approval",
    "question",
    "help",
    "dials",
];

/** The panes that inherit every `picker` binding on top of their own. */
const PICKER_SCOPES: readonly TuiKeyScope[] = [
    "picker",
    "model_picker",
    "session_picker",
];

export interface TuiBinding {
    readonly id: string;
    /** Chords in the `ctrl+shift+name` form that `tuiChord` produces. */
    readonly keys: readonly string[];
    readonly scope: TuiKeyScope;
    /** What it does, in the words the help pane uses. */
    readonly description: string;
    /** How it is written on screen, when a surface shows it. */
    readonly hint?: string;
    /**
     * Fires with any extra modifier attached, rather than only on the exact
     * chord.
     *
     * Set on the escape hatches and nothing else. A terminal that delivers ESC
     * immediately before ctrl+c reports the pair as meta+ctrl+c, and a quit key
     * that depends on how quickly the two bytes arrived is not a quit key.
     */
    readonly anyModifiers?: true;
    /** A broader binding this surface intentionally replaces while it is open. */
    readonly overrides?: readonly string[];
    /**
     * The extension that owns this chord, when one does.
     *
     * Two of Vera's own keys are implemented as bundled extensions, on purpose:
     * they exercise the same public API a user's extension gets. Listing them
     * here is what keeps the table a complete answer to "what is this key", and
     * the id is what stops the conflict check from reporting them against
     * themselves.
     */
    readonly extensionId?: string;
    /**
     * Whether a user may move this chord in `tui.json`.
     *
     * True on picker-opening ids and on movement inside a picker, and nowhere
     * else. Interrupt, enter, escape, cursor movement, text entry and every
     * binding that changes state without showing a picker stay where they are:
     * a remappable silent-state key is how blind cycling gets rebuilt.
     */
    readonly remappable?: boolean;
}

/** A chord collision between two bindings that can both be reached at once. */
export interface TuiKeymapConflict {
    readonly chord: string;
    readonly left: string;
    readonly right: string;
}

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
        id: "cycle_agent_layout",
        keys: ["ctrl+\\", "ctrl+/", "ctrl+_"],
        scope: "global",
        description: "Cycle split and single-agent layouts",
        extensionId: "cycle-agent-layout",
    },
    {
        id: "switch_agent_pane",
        keys: ["ctrl+g"],
        scope: "global",
        description: "Switch focus between visible agents",
        extensionId: "switch-agent-pane",
    },
    {
        id: "toggle_tool_details",
        keys: ["ctrl+e"],
        scope: "conversation",
        description: "Show or hide tool details",
        hint: "ctrl+e details",
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
    // Ctrl-D/U are the familiar half-page transcript movement keys. The
    // shifted letter aliases remain for terminals using the kitty keyboard
    // protocol, while the arrow bindings work everywhere.
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
        // ctrl+shift+g reads as vim's G, and carries the same kitty-protocol
        // caveat as the half-page chords above. ctrl+end is the chord an
        // external keyboard has a key for, and the hint names it because it is
        // the one that works everywhere.
        keys: ["ctrl+end", "ctrl+shift+g"],
        scope: "conversation",
        description: "Follow the transcript from the bottom again",
        hint: "ctrl+end",
    },
    {
        id: "open_model_picker",
        // Only the kitty-protocol encoding of ctrl+shift+m is bound. Plain
        // ctrl+m is byte-identical to Enter, so binding it would take the
        // submit key.
        keys: ["ctrl+shift+m"],
        scope: "global",
        description: "Open the model picker",
        hint: "ctrl+shift+m model",
        remappable: true,
    },
    {
        id: "cycle-reasoning",
        keys: ["ctrl+t"],
        scope: "global",
        description: "Cycle the current model's reasoning level",
        hint: "ctrl+t",
        extensionId: "cycle-reasoning",
    },
    {
        id: "dials.open",
        keys: ["shift+tab"],
        scope: "global",
        description: "Open the dial strip: model and reasoning effort",
        hint: "shift+tab HUD",
        remappable: true,
    },
    // Movement inside the strip. Remappable, because a strip is a picker and
    // its movement is the movement of a picker; commit and cancel are not,
    // because enter and escape are structural everywhere in the TUI.
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
        id: "focus_composer",
        keys: ["i", "tab"],
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
        id: "undo_pool_change",
        keys: ["ctrl+z"],
        scope: "model_picker",
        description: "Undo the last shortlist add or remove",
        hint: "^z undo",
    },
    {
        id: "verify_pool",
        keys: ["ctrl+v"],
        scope: "model_picker",
        description: "Probe the models you keep, and record what they can do",
        hint: "^v verify all",
    },
    {
        // Reported as ctrl+shift+r only under the kitty keyboard protocol, the
        // same caveat the half-page chords above carry. Elsewhere the shift is
        // dropped and it arrives as plain ctrl+r, which this scope binds to the
        // endpoint form, so the probe is out of reach there.
        id: "verify_model",
        keys: ["ctrl+shift+r"],
        scope: "model_picker",
        description: "Probe the selected model and record what it can do",
        hint: "^⇧r verify",
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
    },
    {
        // Connect-pane only, like `forget_provider`. `ctrl+n` already names a
        // pool entry in this scope, so the shifted chord carries the new row.
        id: "declare_provider",
        keys: ["ctrl+shift+n"],
        scope: "model_picker",
        description: "Declare a provider Vera does not ship",
        hint: "^⇧n declare",
    },
    {
        // Connect-pane only. Unshifted, because a terminal outside the kitty
        // keyboard protocol never reports the shift on a ctrl+letter chord,
        // and this is the only way to reach a provider's host.
        id: "edit_endpoint",
        keys: ["ctrl+r"],
        scope: "model_picker",
        description: "Change where the selected provider answers",
        hint: "^r endpoint",
    },
    {
        // The connect pane's rows are the only ones this acts on, so the model
        // list ignores it rather than binding a second meaning to the key.
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
        // Terminals disagree on shift+tab: some report the shifted name, some
        // send the dedicated backtab key.
        id: "previous_form_field",
        keys: ["shift+tab", "backtab"],
        scope: "provider_form",
        description: "Move to the previous field",
        // The form owns shift+tab while it is open, the way the model picker
        // does. The strip is unreachable from inside an overlay anyway.
        overrides: ["dials.open"],
    },
    {
        id: "revoke_permission",
        keys: ["delete", "backspace"],
        scope: "preferences_list",
        description: "Revoke the selected grant or preference",
        // Carries the surface's own bracket chrome: a hint is the literal text
        // shown, so a surface that changes how it writes keys changes one row
        // here rather than drifting from it.
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
];

/**
 * The table as it stands after the merge in `keybindings.ts`.
 *
 * `TUI_KEYMAP` is the defaults; this is what the running TUI actually
 * dispatches, hints and documents. Holding it in one place is what keeps the
 * help pane from describing a chord the user moved: every reader below goes
 * through here rather than through the constant.
 */
let ACTIVE_KEYMAP: readonly TuiBinding[] = TUI_KEYMAP;

/** Put the merged, overlaid table in force. Called once at TUI startup. */
export function installTuiKeymap(bindings: readonly TuiBinding[]): void {
    ACTIVE_KEYMAP = bindings;
}

/** The table in force, defaults included. */
export function activeTuiKeymap(): readonly TuiBinding[] {
    return ACTIVE_KEYMAP;
}

/** The shape every key handler in the TUI already receives, in some form. */
export interface TuiChordKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
    readonly option?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

/**
 * The chord a key event names, or nothing when it carries a modifier the TUI
 * does not bind.
 *
 * Meta, option, super and hyper are excluded rather than encoded: a terminal
 * reports them inconsistently across platforms and emulators, so binding one
 * would work for some users and silently not for others.
 */
export function tuiChord(key: TuiChordKey): string | undefined {
    return key.meta || key.option || key.super || key.hyper
        ? undefined
        : coreChord(key);
}

/** The chord with the modifiers the TUI does not bind stripped rather than refused. */
function coreChord(key: TuiChordKey): string {
    return [
        ...(key.ctrl ? ["ctrl"] : []),
        ...(key.shift ? ["shift"] : []),
        key.name,
    ].join("+");
}

/**
 * The binding id a key means in a scope, or nothing when it means nothing there.
 *
 * Asking the table rather than testing `key.ctrl && key.name` at the handler is
 * the whole point: the handler stops being a place a chord can be claimed
 * without anything else knowing.
 */
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

/** How a binding is written on screen, empty when it is not shown anywhere. */
export function tuiKeyHint(id: string): string {
    return ACTIVE_KEYMAP.find((binding) => binding.id === id)?.hint ?? "";
}

/**
 * A binding's chord on its own, without the label a footer hint carries.
 *
 * Prose names a key mid-sentence, where "^n name" would read as two words of
 * the sentence rather than as one chord, so this returns the chord the way the
 * table spells it.
 */
export function tuiKeyChord(id: string): string {
    return ACTIVE_KEYMAP.find((binding) => binding.id === id)?.keys[0] ?? "";
}

/** The chords a scope has already claimed, including the ones it inherits. */
export function tuiClaimedChords(scope: TuiKeyScope): readonly string[] {
    return ACTIVE_KEYMAP.filter((binding) => appliesIn(binding, scope))
        .flatMap((binding) => binding.keys);
}

/**
 * The binding that already owns a chord in a scope, or nothing when it is free.
 *
 * Extensions register their own bindings at runtime, and this is what tells
 * them a chord is taken. Losing that race used to be invisible: an extension
 * claiming ctrl+p simply never fired, because the raw parser reads that chord
 * before the registry is ever consulted.
 */
export function tuiChordOwner(
    chord: string,
    scope: TuiKeyScope = "global",
): TuiBinding | undefined {
    return ACTIVE_KEYMAP.find((binding) =>
        appliesIn(binding, scope) && binding.keys.includes(chord)
    );
}

/**
 * Two bindings claiming one chord where both can be reached.
 *
 * Held as a function over the table rather than checked once at load so a test
 * can state the invariant, and so the same comparison serves an extension
 * asking whether its chord is free.
 */
export function tuiKeymapConflicts(
    bindings: readonly TuiBinding[] = TUI_KEYMAP,
): readonly string[] {
    return tuiKeymapConflictPairs(bindings)
        .map(({ chord, left, right }) => `${chord}: ${left} and ${right}`);
}

/**
 * The same comparison, kept in the form the overlay validator needs.
 *
 * Startup has to name both sides of a collision and then drop the user entries
 * involved, which it cannot do from a formatted string.
 */
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

/** Whether the first binding is one the second's scope silences outright. */
function standsDownFor(binding: TuiBinding, other: TuiBinding): boolean {
    return binding.extensionId !== undefined
        && OVERLAY_SCOPES.includes(other.scope);
}

/** Whether a binding is reachable in a scope, by its own scope or by descent. */
function appliesIn(binding: TuiBinding, scope: TuiKeyScope): boolean {
    if (binding.scope === scope) {
        return true;
    }
    if (binding.extensionId !== undefined && OVERLAY_SCOPES.includes(scope)) {
        return false;
    }
    // Global is reachable everywhere because the global handler runs first.
    if (binding.scope === "global") {
        return true;
    }
    return binding.scope === "picker" && PICKER_SCOPES.includes(scope);
}

/** Whether two scopes can be active at once, so a chord in both is ambiguous. */
function overlaps(left: TuiKeyScope, right: TuiKeyScope): boolean {
    if (left === right || left === "global" || right === "global") {
        return true;
    }
    const pickerish = (scope: TuiKeyScope) => PICKER_SCOPES.includes(scope);
    return left === "picker" ? pickerish(right) : right === "picker"
        && pickerish(left);
}

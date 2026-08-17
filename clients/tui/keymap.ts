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
    | "help";

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
}

export const TUI_KEYMAP: readonly TuiBinding[] = [
    {
        id: "open_palette",
        keys: ["ctrl+p"],
        scope: "global",
        description: "Open the command palette",
        hint: "ctrl+p commands",
        anyModifiers: true,
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
    // A terminal only reports the shift on a ctrl+letter chord under the kitty
    // keyboard protocol. Elsewhere ctrl+shift+u arrives as plain ctrl+u, which
    // is the composer's clear-line, so these chords go unmatched rather than
    // taking it. The arrow bindings above are the form that works everywhere.
    {
        id: "scroll_half_page_up",
        keys: ["ctrl+shift+up", "ctrl+shift+u"],
        scope: "conversation",
        description: "Scroll the transcript half a page up",
    },
    {
        id: "scroll_half_page_down",
        keys: ["ctrl+shift+down", "ctrl+shift+d"],
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
        id: "cycle-quickslot",
        keys: ["shift+tab"],
        scope: "global",
        description: "Cycle quickslots",
        hint: "shift+tab",
        extensionId: "cycle-quickslot",
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
        description: "Add or remove the selected model from the pool",
        hint: "^s pool",
    },
    {
        id: "undo_pool_change",
        keys: ["ctrl+z"],
        scope: "model_picker",
        description: "Undo the last pool add or remove",
        hint: "^z undo",
    },
    {
        // Reported as ctrl+shift+r only under the kitty keyboard protocol, the
        // same caveat the half-page chords above carry. Elsewhere it arrives
        // as plain ctrl+r, which this scope binds to nothing, so the chord
        // goes unmatched rather than firing a probe nobody asked for.
        id: "verify_pool",
        keys: ["ctrl+v"],
        scope: "model_picker",
        description: "Probe the models you keep, and record what they can do",
        hint: "^v verify all",
    },
    {
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
        description: "Name the selected pool entry",
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
        keys: ["tab"],
        scope: "model_picker",
        description: "Switch between pool and all models",
        hint: "tab switch",
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
    return TUI_KEYMAP.find((binding) => {
        if (!appliesIn(binding, scope)) {
            return false;
        }
        const chord = binding.anyModifiers === true ? loose : exact;
        return chord !== undefined && binding.keys.includes(chord);
    })?.id;
}

/** How a binding is written on screen, empty when it is not shown anywhere. */
export function tuiKeyHint(id: string): string {
    return TUI_KEYMAP.find((binding) => binding.id === id)?.hint ?? "";
}

/**
 * A binding's chord on its own, without the label a footer hint carries.
 *
 * Prose names a key mid-sentence, where "^n name" would read as two words of
 * the sentence rather than as one chord, so this returns the chord the way the
 * table spells it.
 */
export function tuiKeyChord(id: string): string {
    return TUI_KEYMAP.find((binding) => binding.id === id)?.keys[0] ?? "";
}

/** The chords a scope has already claimed, including the ones it inherits. */
export function tuiClaimedChords(scope: TuiKeyScope): readonly string[] {
    return TUI_KEYMAP.filter((binding) => appliesIn(binding, scope))
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
    return TUI_KEYMAP.find((binding) =>
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
    const conflicts: string[] = [];
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
                    conflicts.push(`${chord}: ${binding.id} and ${other.id}`);
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

import { countTuiCharacters } from "../clipboard.ts";
import { SLASH_COMPACT_WIDTH, renderTuiArgumentSuggestions, renderTuiCommandSuggestions, tuiArgumentSuggestions, tuiCommandArgumentHint, tuiCommandSuggestionWidth, tuiSuggestionGaps, tuiSuggestionWindow } from "../commands.ts";
import { findActiveComposeSuggester } from "../compose-suggester.ts";
import { tuiGutterContent } from "../gutter.ts";
import { SUGGESTIONS_RESERVED_ROWS, showStatusNotice } from "../main.ts";
import { focusedAgentState, focusedUiRequest, visibleMentions } from "../main/agents-dials.ts";
import { positionCommandSuggestions } from "../main/chrome.ts";
import { availableCommandSuggestions } from "../main/prompt-routing.ts";
import { TUI_MUTED } from "../state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { MarkdownRenderable, StyledText, fg, type Renderable, type Selection } from "@opentui/core";

export function pooledModelNames(rt: TuiRuntime): readonly string[] {
    const names: string[] = ["self"];
    for (const entry of rt.state.modelSettings?.pooled ?? []) {
        if (entry.poolName !== undefined) {
            names.push(entry.poolName);
        }
        names.push(entry.model);
    }
    return names;
}

export function activeCompletion(rt: TuiRuntime): {
    prefix: string;
    values: readonly string[];
} | undefined {
    const argument = rt.commandRegistry.argumentPrefix(rt.composer.plainText);
    if (argument !== undefined) {
        return {
            prefix: argument.prefix,
            values: argument.kind === "mention"
                ? visibleMentions(rt)
                : pooledModelNames(rt),
        };
    }
    const mentions = visibleMentions(rt);
    if (mentions.length === 0) return undefined;
    const mention = /(?:^|\s)(@\S*)$/.exec(rt.composer.plainText);
    if (mention === null) return undefined;
    return {
        prefix: mention[1] ?? "",
        values: mentions.map((name) => `@${name}`),
    };
}

export function renderCommandSuggestions(rt: TuiRuntime): void {
    const hint = tuiCommandArgumentHint(
        rt.commandRegistry.registeredCommands(),
        rt.composer.plainText,
    );
    rt.slashArgumentHint.content = hint ?? "";
    rt.slashArgumentHint.visible = hint !== undefined;
    rt.slashArgumentHint.left = hint === undefined
        ? 0
        : Bun.stringWidth(rt.composer.plainText);
    const extensionBottomRows = rt.experimentalTuiHost.bottomInsetRows();
    positionCommandSuggestions(rt);
    if (rt.composer.plainText.length === 0) {
        rt.commandSuggestionIndex = 0;
    }
    const completing = activeCompletion(rt);
    if (completing !== undefined) {
        rt.argumentSuggestions = tuiArgumentSuggestions(
            completing.values,
            completing.prefix,
        );
        rt.commandSuggestionIndex = Math.min(
            rt.commandSuggestionIndex,
            Math.max(0, rt.argumentSuggestions.length - 1),
        );
        const window = tuiSuggestionWindow(
            rt.argumentSuggestions.length,
            rt.commandSuggestionIndex,
            Math.max(
                3,
                rt.renderer.height - SUGGESTIONS_RESERVED_ROWS
                    - extensionBottomRows,
            ),
        );
        rt.commandSuggestionsText.content = renderTuiArgumentSuggestions(
            rt.argumentSuggestions.slice(
                window.start,
                window.start + window.rows,
            ),
            rt.commandSuggestionIndex - window.start,
        );
        rt.commandSuggestionsBox.height = Math.max(1, window.rows) + 1;
        rt.commandSuggestionsBox.visible = rt.argumentSuggestions.length > 0
            && overlaysClearOfSuggestions(rt);
        return;
    }
    rt.argumentSuggestions = [];
    const suggestions = availableCommandSuggestions(rt, rt.composer.plainText);
    if (rt.composer.plainText !== "/") {
        rt.commandSuggestionMoved = false;
    }
    rt.commandSuggestionIndex = Math.min(
        rt.commandSuggestionIndex,
        Math.max(0, suggestions.length - 1),
    );
    const selected = rt.composer.plainText === "/"
        ? rt.commandSuggestionIndex
        : -1;
    const grouped = rt.composer.plainText === "/";
    const suggestionWidth = tuiCommandSuggestionWidth(
        rt.renderer.width,
        rt.composerHorizontalInset,
        rt.workspaceSidebarView.railColumns() ?? 0,
    );
    const compact = suggestionWidth < SLASH_COMPACT_WIDTH;
    const window = tuiSuggestionWindow(
        suggestions.length,
        selected,
        Math.max(
            3,
            rt.renderer.height - SUGGESTIONS_RESERVED_ROWS
                - extensionBottomRows
                - tuiSuggestionGaps(suggestions, grouped, compact),
        ),
    );
    const visible = suggestions.slice(
        window.start,
        window.start + window.rows,
    );
    rt.commandSuggestionsText.content = renderTuiCommandSuggestions(
        visible,
        selected < 0 ? -1 : selected - window.start,
        suggestionWidth,
        window.hidden,
        grouped,
        compact,
    );
    rt.commandSuggestionsBox.height = suggestions.length > 0
        ? window.rows + tuiSuggestionGaps(visible, grouped, compact)
            + (window.hidden > 0 ? 1 : 0) + 1
        : 1;
    const suggester = suggestions.length > 0
        ? undefined
        : activeComposeSuggester(rt);
    if (suggester !== undefined) {
        rt.commandSuggestionsText.content = new StyledText([
            fg(TUI_MUTED)(
                `${suggester.hint} · enter switch to ${suggester.agent} · esc dismiss`,
            ),
        ]);
        rt.commandSuggestionsBox.height = 2;
        rt.commandSuggestionsBox.visible = overlaysClearOfSuggestions(rt);
        return;
    }
    rt.commandSuggestionsBox.visible = suggestions.length > 0
        && overlaysClearOfSuggestions(rt);
}

export function activeComposeSuggester(rt: TuiRuntime):
    | {
        readonly id: string;
        readonly source: string;
        readonly agent: string;
        readonly hint: string;
    }
    | undefined
{
    return findActiveComposeSuggester(
        rt.clientExtensionRegistry?.composeSuggesters() ?? [],
        rt.composer.plainText,
        focusedAgentState(rt).agent?.name ?? "default",
        rt.dismissedComposeSuggesters,
    );
}

export function overlaysClearOfSuggestions(rt: TuiRuntime): boolean {
    return focusedUiRequest(rt) === undefined
        && rt.timelinePicker === undefined
        && rt.settingsPicker === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined;
}

export function finishStreamingAssistant(rt: TuiRuntime): void {
    const settle = (node: Renderable): void => {
        if (node instanceof MarkdownRenderable) {
            if (node.streaming) node.streaming = false;
            return;
        }
        const content = tuiGutterContent(node);
        if (content !== node) {
            settle(content);
            return;
        }
        for (const child of node.getChildren()) settle(child);
    };
    for (const node of rt.entryNodes) {
        if (node !== undefined) settle(node);
    }
}

export async function copyTranscriptSelection(rt: TuiRuntime, selection: Selection): Promise<void> {
    const text = selection.getSelectedText();
    if (text.length === 0) {
        return;
    }

    try {
        await rt.copyText(text);
        if (rt.shuttingDown) {
            return;
        }
        const count = countTuiCharacters(text);
        announceCopy(rt, `copied ${count} character${count === 1 ? "" : "s"}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        announceCopy(rt, `copy failed · ${message}`);
    }
}

export function announceCopy(rt: TuiRuntime, message: string): void {
    if (rt.experimentalTuiHost.showNotice(message)) return;
    showStatusNotice(rt, message);
}

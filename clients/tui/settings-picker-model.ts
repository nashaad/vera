import { browseModels } from "./model-browse.ts";
import { providerCatalogsOf, type HostModelCatalogSettings } from "../../src/host/model-catalog-settings.ts";
import { bg, BoxRenderable, fg, StyledText, TextRenderable, type MouseEvent, type RenderContext, type TextChunk } from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import type { SuggestedModel } from "../../src/model/supported-models.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";
import {
    isJobAssignmentId,
    JOB_ASSIGNMENT_INTENTS,
    type ModelAssignmentId,
    type ModelAssignmentRow,
} from "../../src/config/model-assignments.ts";
import type {
    ModelPricing,
    ReasoningLevel,
    ReasoningLevelId,
} from "../../src/model/catalog-shape.ts";
import { BLENDED_RATIO, formatBlendedRate, formatListedPrice, formatListedRates, listedFree } from "../../src/model/listed-rates.ts";
import { INTELLIGENCE_CUTOFFS, passesIntelligenceCutoff, type IntelligenceCutoff } from "../../src/model/intelligence-cutoff.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import {
    isVeraProviderId,
    type VeraCustomProviderConfig,
    type VeraProviderCredential,
    type VeraProviderProtocol,
} from "../../src/config.ts";
import type {
    ModelTurnSettings,
    ReviewerModelDefault,
    ReviewerModelSelection,
} from "../../src/engine/model-settings.ts";
import { TUI_ACCENT, TUI_BACKGROUND, TUI_ELEMENT, TUI_INPUT, TUI_MUTED, TUI_PANEL, TUI_SUCCESS, TUI_TEXT } from "./state.ts";
import {
    dialogBoxHeight,
    halfPageCursor,
    LIST_MIN_ROWS,
    listWindowRows,
    listWindowSlice,
    wheelCursor,
} from "./list-window.ts";
import { DIALOG_CARD_PADDING, DIALOG_GUTTER_WIDTH, attachDialogRowPointer, clipDialogMetaParts, type DialogRowPointer, type DialogMeta, type DialogMetaPart } from "./dialog-chrome.ts";
import { type TuiThemeName } from "./theme.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";
import { tuiKeyHint } from "./keymap.ts";
import {
    insertTuiSingleLinePaste,
    tuiTextareaKey,
} from "./single-line-editor.ts";

import {
    CATALOG_REFRESH_ALL_VALUE,
    CONTEXT_LIMIT_VALUE,
    MODEL_ASSIGNMENT_BROWSE_VALUE,
    MODEL_ASSIGNMENT_SELF_VALUE,
    POOL_VERIFY_UNVERIFIED_VALUE,
    REVIEWER_CLEAR_VALUE,
    SESSION_MODEL_VALUE,
    TUI_TOP_PICKS_SECTION,
    type TuiAnySettingsPickerState,
    type TuiExtensionPickerState,
    type TuiExtensionPickerTransition,
    type TuiModelPickerTab,
    type TuiSettingsMenuTarget,
    type TuiSettingsPickerOption,
    type TuiSettingsPickerSelection,
    type TuiSettingsPickerState,
    type TuiSettingsPickerTransition,
    formatSessionSize,
    modelAssignmentOfValue,
    tuiModelActionOfValue,
    OVERRIDES_RESET_VALUE,
} from "./settings-picker-types.ts";

export function moveTuiSettingsPickerPointer(
    state: TuiAnySettingsPickerState,
    index: number,
): TuiAnySettingsPickerState {
    if (state.kind === "extension") {
        if (index === -1) return { ...state, searchFocused: true, focusedButton: undefined };
        if (index < -1) return { ...state, searchFocused: false, focusedButton: -index - 2 };
        return { ...state, selectedIndex: index, searchFocused: false, focusedButton: undefined };
    }
    if (state.kind !== "model") {
        return { ...state, selectedIndex: index };
    }
    if (index < 0) {
        if (index === -1) {
            return modelPageEntry(state) === undefined
                ? state
                : { ...state, modelFocus: "page_entry" };
        }
        const pageIndex = -index - 2;
        return pageIndex < modelPageActions(state).length
            ? { ...state, modelFocus: "page", modelPageIndex: pageIndex }
            : state;
    }
    if (index < state.options.length) {
        return { ...state, selectedIndex: index, modelFocus: "list" };
    }
    if (index === state.options.length && modelListAction(state) !== undefined) {
        return { ...state, modelFocus: "list_action" };
    }
    const actionIndex = index - state.options.length - 1;
    const actions = modelDetailActions(
        state,
        state.options[state.selectedIndex],
    );
    if (actionIndex >= 0 && actionIndex < actions.length) {
        return {
            ...state,
            modelFocus: "detail",
            modelActionIndex: actionIndex,
        };
    }
    return state;
}

export function mergeTuiModelPickerSettings(
    target: ModelTurnSettings | undefined,
    poolSource: ModelTurnSettings | undefined,
): HostModelCatalogSettings | undefined {
    if (target === undefined) return poolSource;
    if (poolSource === undefined) return target;
    return { ...target,
        ...(poolSource.pooled === undefined ? {} : { pooled: poolSource.pooled }),
        ...(poolSource.availableModels === undefined ? {} : { availableModels: poolSource.availableModels }),
        ...(providerCatalogsOf(poolSource) === undefined ? {} : { providerCatalogs: providerCatalogsOf(poolSource) }),
    };
}

export function hasModelDetail(state: TuiAnySettingsPickerState): boolean {
    // The More page replaces the list, so there is no row left to describe.
    if (state.kind === "model" && state.modelFocus === "page") return false;
    if (state.kind === "overrides_settings") return true;
    if (state.kind === "model" && state.modelBrowse !== undefined) return true;
    const tab = state.kind === "model" ? state.tab ?? "all" : undefined;
    return tab === "pool" || tab === "defaults" || tab === "actions";
}

export const MODEL_DETAIL_MIN_WIDTH = 30;

export const MODEL_LIST_MIN_WIDTH = 28;

/** An overrides row is four columns wide before any prose. */
export const OVERRIDE_LIST_MIN_WIDTH = 54;

export const MODEL_DETAIL_RULE = "│  ";

export const MODEL_LIST_RULE_GAP = 2;

export interface ModelPaneSplit {
    readonly listWidth: number;
    readonly detailWidth: number;
}

export function modelPaneSplit(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    railInset = 0,
): ModelPaneSplit | undefined {
    if (!hasModelDetail(state)) {
        return undefined;
    }
    const cardWidth = pickerCardWidth(renderer, state, railInset);
    const detailWidth = Math.max(
        MODEL_DETAIL_MIN_WIDTH,
        Math.floor(cardWidth * 0.32),
    );
    const listWidth = cardWidth - detailWidth - MODEL_DETAIL_RULE.length;
    const minimum = state.kind === "overrides_settings"
        ? OVERRIDE_LIST_MIN_WIDTH
        : MODEL_LIST_MIN_WIDTH;
    // Too narrow to hold both, so the rows keep their own trailing prose.
    return listWidth < minimum ? undefined : { listWidth, detailWidth };
}

export function pickerContentWidth(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    railInset = 0,
): number {
    return Math.max(
        0,
        pickerCardWidth(renderer, state, railInset) - DIALOG_GUTTER_WIDTH,
    );
}

export function pickerCardWidth(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    railInset = 0,
): number {
    const usableWidth = Math.max(0, renderer.width - railInset);
    const cardWidth = state.kind === "session"
        ? usableWidth
        : state.kind === "model" || (state.kind === "extension" && state.layout === "list-detail")
        ? Math.floor(usableWidth * 0.96)
        : Math.floor(usableWidth * 0.8);
    return Math.max(0, cardWidth - DIALOG_CARD_PADDING * 2);
}

export function stackedBelowListLines(
    state: TuiAnySettingsPickerState,
    width: number,
): number {
    if (state.kind === "model" && state.modelFocus === "page") {
        return 2 + modelPageActions(state).length;
    }
    const option = state.options[state.selectedIndex];
    if (state.kind === "model" && state.tab === "all") {
        return 0;
    }
    const actions = modelDetailActions(state, option);
    return stackedDetailLines(state, option, width).length
        + (actions.length === 0 ? 0 : 2 + actions.length);
}

export function stackedDetailLines(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): readonly (readonly TextChunk[])[] {
    if (
        state.kind === "model"
        && state.tab === "all"
    ) {
        return [];
    }
    if (
        state.kind !== "model" || state.tab !== "defaults"
        || option?.detailFacts === undefined
    ) {
        return [];
    }
    const lines: (readonly TextChunk[])[] = [[]];
    for (const [label, value] of option.detailFacts) {
        lines.push([fg(TUI_MUTED)(label)]);
        lines.push([fg(TUI_TEXT)(clippedTo(value, width))]);
    }
    lines.push([]);
    for (const text of wrappedTo(option.note ?? "", width)) {
        lines.push([fg(TUI_MUTED)(text)]);
    }
    return lines;
}

export function stackedListedPriceLines(
    option: TuiSettingsPickerOption | undefined,
    width: number,
): readonly (readonly TextChunk[])[] {
    const free = listedFree(option?.pricing);
    const full = formatListedRates(option?.pricing);
    const blended = formatBlendedRate(option?.pricing);
    const facts: string[] = [];
    if (free) facts.push("free");
    else if (full !== undefined) facts.push(`full ${full}`);
    if (!free && blended !== undefined) facts.push(`blended ${blended} at ${BLENDED_RATIO}`);
    if (option?.images === true) facts.push("images");
    const labelRoom = Math.min(option?.label.length ?? 0, 12);
    while (facts.length > 1 && facts.join("  ").length + 2 + labelRoom > width) facts.pop();
    const right = clippedTo(facts.join("  "), Math.max(1, width - 2 - labelRoom));
    const label = clippedTo(
        option?.label ?? "",
        Math.max(0, width - right.length - 2),
    );
    const gap = Math.max(1, width - label.length - right.length);
    return [[
        fg(TUI_TEXT)(label),
        fg(TUI_MUTED)(`${" ".repeat(gap)}${right}`),
    ]];
}

export function allModelsPriceNode(
    renderer: RenderContext,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): BoxRenderable {
    return ALL_MODELS_PRICE_CHROME === "fill"
        ? allModelsPriceFillNode(renderer, option, width)
        : allModelsPriceBorderNode(renderer, option, width);
}

export function allModelsPriceFillNode(
    renderer: RenderContext,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        width,
        height: ALL_MODELS_PRICE_FACTS + 2 * ALL_MODELS_PRICE_PAD,
        marginTop: ALL_MODELS_PRICE_MARGIN,
        marginBottom: ALL_MODELS_PRICE_MARGIN,
        flexShrink: 0,
        flexDirection: "column",
        border: false,
        backgroundColor: TUI_INPUT,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: ALL_MODELS_PRICE_PAD,
        paddingBottom: ALL_MODELS_PRICE_PAD,
    });
    const innerWidth = Math.max(1, width - 2);
    for (const chunks of stackedListedPriceLines(option, innerWidth)) {
        box.add(new TextRenderable(renderer, {
            content: new StyledText([...chunks]),
            bg: TUI_INPUT,
            width: "100%",
            height: 1,
        }));
    }
    return box;
}

export function allModelsPriceBorderNode(
    renderer: RenderContext,
    option: TuiSettingsPickerOption | undefined,
    width: number,
): BoxRenderable {
    const box = new BoxRenderable(renderer, {
        width,
        height: ALL_MODELS_PRICE_FACTS,
        marginTop: ALL_MODELS_PRICE_MARGIN,
        marginBottom: ALL_MODELS_PRICE_MARGIN,
        flexShrink: 0,
        flexDirection: "column",
        border: false,
        backgroundColor: TUI_PANEL,
    });
    const innerWidth = Math.max(1, width - 2);
    for (const chunks of stackedListedPriceLines(option, innerWidth)) {
        box.add(new TextRenderable(renderer, {
            content: new StyledText([
                fg(TUI_ELEMENT)("│ "),
                ...chunks,
            ]),
            width,
            height: 1,
        }));
    }
    return box;
}

export function modelDetailNode(
    renderer: RenderContext,
    state: TuiAnySettingsPickerState,
    width: number,
    height: number,
    pointer?: DialogRowPointer,
): BoxRenderable {
    const pane = new BoxRenderable(renderer, {
        width: width + MODEL_DETAIL_RULE.length,
        height,
        flexShrink: 0,
        flexDirection: "column",
    });
    let drawn = 0;
    const line = (
        chunks: readonly TextChunk[] = [],
        pointerIndex?: number,
        limit = height,
    ): void => {
        if (drawn >= height || drawn >= limit) return;
        drawn += 1;
        const node = new TextRenderable(renderer, {
            content: new StyledText([fg(TUI_ELEMENT)(MODEL_DETAIL_RULE), ...chunks]),
            width: width + MODEL_DETAIL_RULE.length,
            height: 1,
        });
        if (pointerIndex !== undefined) {
            attachDialogRowPointer(node, pointer, pointerIndex);
        }
        pane.add(node);
    };
    if (state.kind === "model" && state.modelFocus === "page") {
        const actions = modelPageActions(state);
        const selected = Math.min(
            state.modelPageIndex ?? 0,
            Math.max(0, actions.length - 1),
        );
        line([fg(TUI_TEXT)(clippedTo("More", width))]);
        line();
        actions.forEach((action, index) => {
            line(
                modelActionLineChunks(
                    {
                        label: action.label,
                        chord: action.description ?? "",
                    },
                    width,
                    index === selected,
                ),
                -2 - index,
            );
        });
        return pane;
    }
    const option = state.options[state.selectedIndex];
    if (
        state.kind === "model"
        && (state.tab === "pool" || state.tab === "all")
        && state.options.length === 0
    ) {
        const [title] = modelEmptyMessage(state).split(". ");
        line([fg(TUI_TEXT)(clippedTo(`${title}.`, width))]);
        line();
        for (const text of modelEmptyDetailBody(state, width)) {
            line([fg(TUI_MUTED)(text)]);
        }
        return pane;
    }
    const described = option !== undefined && option.section === undefined;
    if (described && option.detailFacts !== undefined) {
        line([fg(TUI_TEXT)(clippedTo(option.detailTitle ?? "", width))]);
        line();
        for (const [label, value] of option.detailFacts) {
            line([fg(TUI_MUTED)(label)]);
            line([fg(TUI_TEXT)(clippedTo(value, width))]);
        }
        line();
        for (const text of wrappedTo(option.note ?? "", width)) {
            line([fg(TUI_MUTED)(text)]);
        }
        while (drawn < height) {
            line();
        }
        return pane;
    }
    if (described && state.kind === "model" && state.modelBrowse !== undefined) {
        line([fg(TUI_TEXT)(clippedTo(option.label, width))]);
        line([fg(TUI_MUTED)(clippedTo(option.provider ?? "", width))]);
        line();
        const facts = modelDetailFacts(state, option);
        const squeezed = height < 3 + browseFactLines(facts, width);
        for (const fact of facts) {
            const [label, value, tone] = fact;
            const color = tone === "positive" ? TUI_SUCCESS : TUI_TEXT;
            if (squeezed || browseFactFits(fact, width)) line([fg(TUI_MUTED)(`${label}: `), fg(color)(clippedTo(value, Math.max(1, width - label.length - 2)))]);
            else {
                line([fg(TUI_MUTED)(label)]);
                line([fg(color)(clippedTo(value, width))]);
            }
        }
        return pane;
    }
    if (described) {
        const actions = modelDetailActions(state, option);
        const factLimit = Math.max(
            0,
            height - (actions.length === 0 ? 0 : actions.length + 1),
        );
        line(
            [fg(TUI_TEXT)(clippedTo(option.label, width))],
            undefined,
            factLimit,
        );
        line([
            fg(TUI_MUTED)(clippedTo(
                option.model === undefined || option.poolName === undefined
                    ? option.provider ?? ""
                    : `${option.provider ?? ""} · ${option.model}`,
                width,
            )),
        ], undefined, factLimit);
        line([], undefined, factLimit);
        const facts = modelDetailFacts(state, option);
        const leftFacts = facts.slice(0, MODEL_DETAIL_LEFT_FACTS);
        const rightFacts = facts.slice(MODEL_DETAIL_LEFT_FACTS);
        const factRows = modelDetailFactRowCount(facts);
        const col = rightFacts.length === 0
            ? width
            : Math.max(0, Math.floor((width - 2) / 2));
        for (let index = 0; index < factRows; index += 1) {
            const left = leftFacts[index];
            const right = rightFacts[index];
            line(
                factColumnChunks(left?.[0], right?.[0], col, width, true),
                undefined,
                factLimit,
            );
            line(
                factColumnChunks(
                    left?.[1],
                    right?.[1],
                    col,
                    width,
                    false,
                    left?.[2],
                    right?.[2],
                ),
                undefined,
                factLimit,
            );
        }
        line([], undefined, factLimit);
        if (actions.length > 0) {
            while (drawn < factLimit) {
                line();
            }
            const inside = state.kind === "model"
                && state.modelFocus === "detail";
            // One verb per direction, in one place: the panel header, which
            // sits beside what it describes. The footer no longer repeats it.
            const hint = inside ? "← list" : "→ actions";
            line([
                fg(TUI_MUTED)(
                    "Actions".padEnd(
                        Math.max(0, width - Bun.stringWidth(hint)),
                    ),
                ),
                fg(TUI_ACCENT)(hint),
            ]);
        }
        actions.forEach((action, index) => {
            const active = state.kind === "model"
                && state.modelFocus === "detail"
                && modelActionCursor(state, actions) === index;
            line(
                modelActionLineChunks(action, width, active),
                state.options.length + 1 + index,
            );
        });
    }
    while (drawn < height) {
        line();
    }
    return pane;
}

export function wrappedTo(text: string, width: number): readonly string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line.length === 0) {
            line = word;
        } else if (line.length + 1 + word.length <= width) {
            line = `${line} ${word}`;
        } else {
            lines.push(line);
            line = word;
        }
    }
    if (line.length > 0) {
        lines.push(line);
    }
    return lines;
}

export function modelDetailHeight(
    state: TuiAnySettingsPickerState,
    width: number,
): number {
    if (state.kind === "model" && state.modelFocus === "page") {
        return 2 + modelPageActions(state).length;
    }
    if (
        state.kind === "model"
        && (state.tab === "pool" || state.tab === "all")
        && state.options.length === 0
    ) {
        return 2 + modelEmptyDetailBody(state, width).length;
    }
    const option = state.options[state.selectedIndex];
    const described = option !== undefined && option.section === undefined;
    if (described && option.detailFacts !== undefined) {
        return 3 + option.detailFacts.length * 2
            + wrappedTo(option.note ?? "", width).length;
    }
    if (described && state.kind === "model" && state.modelBrowse !== undefined) {
        return 3 + browseFactLines(modelDetailFacts(state, option), width);
    }
    const facts = described ? modelDetailFacts(state, option) : [];
    const factLines = described
        ? modelDetailFactRowCount(facts) * 2 + 1
        : 0;
    const actions = modelDetailActions(state, option).length;
    return (described ? 3 + factLines : 0)
        + (actions === 0 ? 0 : actions + 1);
}

export const MODEL_DETAIL_LEFT_FACTS = 3;

export function modelDetailFactRowCount(facts: readonly ModelDetailFact[]): number {
    return Math.max(
        Math.min(MODEL_DETAIL_LEFT_FACTS, facts.length),
        Math.max(0, facts.length - MODEL_DETAIL_LEFT_FACTS),
    );
}

export type ModelDetailFact = readonly [string, string, ("positive" | undefined)?];

export function factColumnChunks(
    left: string | undefined,
    right: string | undefined,
    col: number,
    width: number,
    labels: boolean,
    leftTone?: "positive",
    rightTone?: "positive",
): readonly TextChunk[] {
    const leftText = clippedTo(left ?? "", col).padEnd(col);
    const rightText = clippedTo(right ?? "", Math.max(0, width - col - 2));
    const paint = (
        text: string,
        tone: "positive" | undefined,
    ): TextChunk =>
        fg(
            tone === "positive"
                ? TUI_SUCCESS
                : labels
                ? TUI_MUTED
                : TUI_TEXT,
        )(text);
    return [
        paint(leftText, leftTone),
        fg(TUI_TEXT)("  "),
        paint(rightText, rightTone),
    ];
}

function browseFactFits(fact: ModelDetailFact, width: number): boolean {
    return fact[0].length + 2 + fact[1].length <= width;
}

/** A browse pane puts label and value on one line whenever both fit. */
function browseFactLines(
    facts: readonly ModelDetailFact[],
    width: number,
): number {
    return facts.reduce((total, fact) => total + (browseFactFits(fact, width) ? 1 : 2), 0);
}

export function modelDetailFacts(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
): readonly ModelDetailFact[] {
    const facts: ModelDetailFact[] = [];
    if (state.kind === "model" && state.tab !== "pool") {
        facts.push(option.pooledRank === undefined
            ? ["Favorites", "not saved"]
            : ["Favorites", "saved", "positive"]);
    }
    const browsing = state.kind === "model" && state.modelBrowse !== undefined;
    if (browsing) {
        facts.push(option.verificationError !== undefined ? ["Verified", `failed: ${option.verificationError}`]
            : option.unverified === false || option.pooledRank !== undefined && option.unverified !== true
                ? ["Verified", "answered a live probe", "positive"] : ["Verified", "not probed yet"]);
        facts.push(["Images", option.images === true ? "yes" : option.images === false ? "no" : "not known"]);
        facts.push(["Model ID", option.model ?? "—"]);
    } else {
        facts.push(option.unverified === true || option.pooledRank === undefined
            ? ["Verified", "not probed yet"] : ["Verified", "answered a live probe", "positive"]);
        facts.push(["Images", option.images === true ? "i" : "not known"]);
    }
    if (option.waScore !== undefined) {
        facts.push(["WA Score", String(option.waScore)]);
    }
    const free = listedFree(option.pricing);
    const full = state.kind === "model" && state.modelBrowse === "browse" && option.pricing !== undefined
        ? `${option.pricing.input}/${option.pricing.output}` : formatListedRates(option.pricing);
    if (full !== undefined) {
        facts.push(["Full price", free ? "free" : full]);
    }
    const blended = formatBlendedRate(option.pricing);
    if (!free && blended !== undefined) {
        facts.push(["Blended price", `${blended}  ${BLENDED_RATIO}`]);
    }
    if (!browsing) facts.push(["Model ID", option.model ?? "—"]);
    if (option.unavailable === true) {
        facts.push(["Available", "not from its provider"]);
    }
    return facts;
}

export function clippedTo(text: string, width: number): string {
    return text.length <= width
        ? text
        : `${text.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

/** The one line that teaches the shape rather than the keys: tab crosses the bands, arrows stay inside one. The footer above it names the keys of whichever band has the cursor. */
/** What the ring does, and the key that does it. The key is named in words and
 *  sits after the phrase, so it reads apart from the prose it explains. */
export const MODEL_ARROW_HINT_PARTS: readonly (readonly [string, string])[] = [
    ["moves between sections", "tab"],
    ["moves inside one", "arrows"],
    ["reaches the tabs", "shift+tab"],
];

export function modelArrowHintChunks(): readonly TextChunk[] {
    const chunks: TextChunk[] = [];
    MODEL_ARROW_HINT_PARTS.forEach(([phrase, key], index) => {
        if (index > 0) chunks.push(fg(TUI_MUTED)(" · "));
        chunks.push(fg(TUI_MUTED)(`${phrase}  `), fg(TUI_TEXT)(key));
    });
    return chunks;
}

export const MODEL_ARROW_HINT = MODEL_ARROW_HINT_PARTS
    .map(([phrase, key]) => `${phrase}  ${key}`)
    .join(" · ");

export const MODEL_ALL_MAX_ROWS = 28;

export function isPooled(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): boolean {
    return option.pooledRank !== undefined
        || state.allOptions.some((candidate) =>
            candidate.value === option.value && candidate.pooledRank !== undefined
        );
}

export function isProviderGrouped(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "provider"
        || (state.kind === "model"
            && (state.query.length > 0 || state.tab !== "pool"));
}

export function modelOptionCanVerify(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
): boolean {
    return state.kind === "model"
        && option !== undefined
        && option.section === undefined
        && option.action !== true
        && option.provider !== undefined
        && option.model !== undefined
        && option.value !== SESSION_MODEL_VALUE;
}

export type ModelDetailActionId =
    | "verify"
    | "toggle_pool"
    | "name"
    | "request_options";

export interface ModelDetailAction {
    readonly id: ModelDetailActionId;
    readonly chord: string;
    readonly label: string;
}

export type ModelListActionId = "verify_pool" | "reveal_all" | "page_entry";

export interface ModelListAction {
    readonly id: ModelListActionId;
    readonly chord: string;
    readonly label: string;
}

export function modelActionLineChunks(
    action: Pick<ModelDetailAction, "chord" | "label">,
    width: number,
    active: boolean,
): TextChunk[] {
    const chordWidth = Bun.stringWidth(action.chord);
    const labelWidth = Math.max(0, width - 1 - chordWidth);
    const label = labelWidth === 0
        ? ""
        : clippedTo(action.label, labelWidth).padEnd(labelWidth);
    if (active) {
        return [
            fg(TUI_BACKGROUND)(
                bg(TUI_ACCENT)(`${label} ${action.chord}`.padEnd(width)),
            ),
        ];
    }
    return [
        fg(TUI_TEXT)(label),
        fg(TUI_PANEL)(" "),
        fg(TUI_ACCENT)(action.chord),
    ];
}

export function modelListActionLineChunks(
    action: ModelListAction,
    width: number,
    active: boolean,
): TextChunk[] {
    const chordWidth = Bun.stringWidth(action.chord);
    const labelWidth = Math.max(0, width - 1 - chordWidth);
    const label = labelWidth === 0
        ? ""
        : clippedTo(action.label, labelWidth).padEnd(labelWidth);
    if (active) {
        return [
            fg(TUI_BACKGROUND)(
                bg(TUI_ACCENT)(`${label} ${action.chord}`.padEnd(width)),
            ),
        ];
    }
    return [
        fg(TUI_TEXT)(bg(TUI_INPUT)(label)),
        fg(TUI_TEXT)(bg(TUI_INPUT)(" ")),
        fg(TUI_ACCENT)(bg(TUI_INPUT)(action.chord)),
    ];
}

export function modelPageActions(
    state: TuiAnySettingsPickerState,
): readonly TuiSettingsPickerOption[] {
    if (
        state.kind !== "model"
        || (state.tab !== "pool" && state.tab !== "all")
    ) {
        return [];
    }
    const listOwn = state.tab === "pool"
        ? ["shortlist_current", "verify_pool"]
        : ["reveal_all"];
    return availableModelActionOptions(
        state.allOptions,
        state.actionOptions ?? [],
    ).filter((option) => {
        const id = tuiModelActionOfValue(option.value) ?? "";
        return listOwn.includes(id) || id === "refresh" || id === "providers";
    });
}

export function modelSyncedFocus(
    state: TuiSettingsPickerState,
    rebuilt: TuiAnySettingsPickerState,
): {
    readonly modelFocus: NonNullable<TuiSettingsPickerState["modelFocus"]>;
    readonly modelPageIndex?: number;
} {
    const focus = state.modelFocus ?? "list";
    if (focus !== "page" && focus !== "page_entry") {
        return { modelFocus: focus };
    }
    const actions = modelPageActions(rebuilt);
    if (actions.length === 0) {
        return { modelFocus: "list" };
    }
    return focus === "page_entry"
        ? { modelFocus: "page_entry" }
        : {
            modelFocus: "page",
            modelPageIndex: Math.min(
                state.modelPageIndex ?? 0,
                actions.length - 1,
            ),
        };
}

export function modelActionCursor(
    state: TuiAnySettingsPickerState,
    actions: readonly ModelDetailAction[],
): number {
    return Math.min(
        (state.kind === "model" ? state.modelActionIndex : undefined) ?? 0,
        Math.max(0, actions.length - 1),
    );
}

export function modelPageEntry(
    state: TuiAnySettingsPickerState,
): ModelListAction | undefined {
    return modelPageActions(state).length === 0
        ? undefined
        : { id: "page_entry", chord: "\u203a", label: "More" };
}

export function modelPageEntryGlyph(state: TuiAnySettingsPickerState): string {
    return state.kind === "model" && state.modelFocus === "page" ? "-" : "+";
}

export const MODEL_PAGE_ENTRY_SHORT: Record<string, string> = {
    shortlist_current: "add current",
    reveal_all: "show every model",
    verify_pool: "verify all",
    refresh: "refresh",
    providers: "providers",
};

export function modelPageEntryLabel(
    state: TuiAnySettingsPickerState,
    width: number,
): string {
    const glyph = modelPageEntryGlyph(state);
    const names = modelPageActions(state).map((option) =>
        MODEL_PAGE_ENTRY_SHORT[tuiModelActionOfValue(option.value) ?? ""]
            ?? option.label
    );
    const room = width - Bun.stringWidth(`${glyph} More · `) - 2;
    const shown: string[] = [];
    for (const name of names) {
        const next = [...shown, name].join(", ");
        const rest = names.length - shown.length - 1;
        const suffix = rest === 0 ? "" : ` (+${rest})`;
        if (Bun.stringWidth(next + suffix) > room) break;
        shown.push(name);
    }
    const opener = `${glyph} More`;
    if (shown.length === 0) return opener;
    const rest = names.length - shown.length;
    return `${opener} · ${shown.join(", ")}${
        rest === 0 ? "" : ` (+${rest})`
    }`;
}

export function modelDetailActions(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption | undefined,
): readonly ModelDetailAction[] {
    if (
        state.kind !== "model"
        || option === undefined
        || option.section !== undefined
        || option.action === true
        || option.provider === undefined
        || option.model === undefined
        || option.value === SESSION_MODEL_VALUE
    ) {
        return [];
    }
    const pooled = isPooled(state, option);
    const requestOptions = state.requestOptionsProviders?.[option.provider];
    const modelReference = `${option.provider}/${option.model}`;
    return [
        ...(modelOptionCanVerify(state, option)
            ? [{
                id: "verify" as const,
                chord: tuiKeyHint("verify_model").split(" ")[0] ?? "",
                label: "Verify this model",
            }]
            : []),
        {
            id: "toggle_pool",
            chord: tuiKeyHint("toggle_pooled").split(" ")[0] ?? "",
            label: pooled ? "Unpin" : "Add to favorites",
        },
        ...(pooled
            ? [{
                id: "name" as const,
                chord: tuiKeyHint("name_pooled").split(" ")[0] ?? "",
                label: "Name this model",
            }]
            : []),
        ...(requestOptions === undefined
            ? []
            : [{
                id: "request_options" as const,
                chord: state.configuredRequestOptions?.includes(modelReference)
                    ? "configured"
                    : "none",
                label: "Request options",
            }]),
    ];
}

export function modelListAction(
    state: TuiAnySettingsPickerState,
): ModelListAction | undefined {
    if (state.kind !== "model") return undefined;
    return undefined;
}

export function modelDetailActionTransition(
    state: TuiSettingsPickerState,
    action: ModelDetailAction | undefined,
): TuiSettingsPickerTransition {
    const option = state.options[state.selectedIndex];
    if (
        action === undefined
        || option?.provider === undefined
        || option.model === undefined
    ) {
        return unchanged(state, true);
    }
    if (action.id === "verify") {
        return {
            state,
            handled: true,
            poolVerify: { provider: option.provider, model: option.model },
        };
    }
    if (action.id === "toggle_pool") {
        return {
            state,
            handled: true,
            poolToggle: {
                action: isPooled(state, option) ? "remove" : "add",
                provider: option.provider,
                model: option.model,
            },
        };
    }
    if (action.id === "request_options") {
        const support = state.requestOptionsProviders?.[option.provider];
        if (support === undefined) return unchanged(state, true);
        return {
            state,
            handled: true,
            requestOptions: {
                provider: option.provider,
                model: option.model,
                support,
            },
        };
    }
    return {
        state,
        handled: true,
        poolName: {
            provider: option.provider,
            model: option.model,
            label: option.label,
        },
    };
}

export function modelListActionTransition(
    state: TuiSettingsPickerState,
    action: ModelListAction | undefined,
): TuiSettingsPickerTransition {
    if (action === undefined) return unchanged(state, true);
    if (action.id === "verify_pool") {
        return { state, handled: true, poolVerifySweep: true };
    }
    const revealAll = state.revealAll !== true;
    const options = modelListFor(state, { revealAll });
    return {
        state: {
            ...state,
            revealAll,
            options,
            modelFocus: "list_action",
            selectedIndex: restoredCursor(
                options,
                state.options[state.selectedIndex]?.value,
                state.initialModel,
            ),
        },
        handled: true,
    };
}

export const INTELLIGENCE_SCALE_LINES = 5;

export const ALL_MODELS_SECTION_GAP_LINES = 1;

export const ALL_MODELS_TREE_PAD_LINES = 2;

export const ALL_MODELS_PRICE_FACTS = 1;

export const ALL_MODELS_PRICE_PAD = 0;

export const ALL_MODELS_PRICE_MARGIN = 1;

export type AllModelsPriceChrome = "fill" | "border";

export const ALL_MODELS_PRICE_CHROME: AllModelsPriceChrome = "fill";

/** The price strip plus the footnote drawn under it. */
export function allModelsPriceChromeLines(): number {
    const boxHeight = ALL_MODELS_PRICE_CHROME === "fill"
        ? ALL_MODELS_PRICE_FACTS + 2 * ALL_MODELS_PRICE_PAD
        : ALL_MODELS_PRICE_FACTS;
    return 2 * ALL_MODELS_PRICE_MARGIN + boxHeight
        + LISTED_FACTS_FOOTNOTE_LINES;
}

export function showsIntelligenceCutoff(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "model" && (state.tab ?? "all") === "all";
}

export function showsAllModelsPrices(state: TuiAnySettingsPickerState): boolean {
    return showsIntelligenceCutoff(state);
}

export function isAllModelsInfoRow(
    option: TuiSettingsPickerOption | undefined,
): option is TuiSettingsPickerOption {
    return option !== undefined
        && option.section === undefined
        && tuiModelActionOfValue(option.value) === undefined;
}

export function allModelsInfoOption(
    state: TuiAnySettingsPickerState,
): TuiSettingsPickerOption | undefined {
    const selected = state.options[state.selectedIndex];
    if (isAllModelsInfoRow(selected)) {
        return selected;
    }
    return state.options
        .slice(state.selectedIndex + 1)
        .find(isAllModelsInfoRow);
}

function intelligenceScaleLayout(width: number) {
    const trackWidth = width < 36 ? width + 1 : Math.min(52, Math.max(36, width - 2));
    const trackLength = Math.max(1, trackWidth - 1);
    let nextStart = 0;
    const stops = INTELLIGENCE_CUTOFFS.map((choice, index) => {
        const position = Math.round(index * (trackLength - 1) / (INTELLIGENCE_CUTOFFS.length - 1));
        const remainingWidth = INTELLIGENCE_CUTOFFS.slice(index).reduce((total, stop) => total + stop.length, 0)
            + INTELLIGENCE_CUTOFFS.length - index - 1;
        const endLimit = width < 36 ? trackLength - remainingWidth : trackLength - choice.length;
        const start = Math.max(nextStart, 0, Math.min(endLimit, position - Math.floor(choice.length / 2)));
        nextStart = start + choice.length + 1;
        return { choice, position, start, end: start + choice.length };
    });
    return { trackWidth, trackLength, stops };
}

export function intelligenceScaleNodes(
    renderer: RenderContext,
    width: number,
    cutoff: IntelligenceCutoff,
    focused: boolean,
    onCutoff?: (cutoff?: IntelligenceCutoff) => void,
    background?: string,
): readonly TextRenderable[] {
    const { trackLength, stops } = intelligenceScaleLayout(width);
    return intelligenceScaleLines(width, cutoff, focused).map((chunks, row) => {
        const node = new TextRenderable(renderer, {
            id: `model-cutoff-${row}`, content: new StyledText([...chunks]),
            bg: background, width: "100%", height: 1, selectable: false,
        });
        if (onCutoff !== undefined) node.onMouseDown = (event) => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            renderer.clearSelection();
            const column = event.x - node.screenX;
            // Labels use their full printed hit area; the track snaps to its nearest tick.
            const label = row === 2 ? stops.find((stop) => column >= stop.start && column < stop.end) : undefined;
            const nearest = stops.reduce((best, stop) => Math.abs(column - stop.position) < Math.abs(column - best.position) ? stop : best);
            onCutoff(row === 0 || column < 0 || column >= trackLength ? undefined : (label ?? nearest).choice);
        };
        return node;
    });
}

export function intelligenceScaleLines(
    width: number,
    cutoff: IntelligenceCutoff,
    focused: boolean,
): readonly (readonly TextChunk[])[] {
    const { stops, trackWidth, trackLength } = intelligenceScaleLayout(width);
    const labelGap = Math.max(
        1,
        Math.min(width, trackWidth) - "Any".length - "Smarter".length,
    );
    const axis = `Any${" ".repeat(labelGap)}Smarter`;
    const selectedIndex = Math.max(0, stops.findIndex((stop) => stop.choice === cutoff));
    const marker = Math.round(
        selectedIndex * (trackLength - 1) / Math.max(1, stops.length - 1),
    );
    const track: TextChunk[] = Array.from(
        { length: trackLength },
        (_, index) =>
            fg(index === marker ? TUI_ACCENT : TUI_ELEMENT)(
                index === marker ? "▲" : "─",
            ),
    );
    const optionLine = Array.from({ length: trackLength }, () => " ");
    let selectedStart = 0;
    let selectedEnd = 0;
    stops.forEach(({ choice, start }, index) => {
        for (let offset = 0; offset < choice.length; offset += 1) {
            optionLine[start + offset] = choice[offset] ?? " ";
        }
        if (index === selectedIndex) {
            selectedStart = start;
            selectedEnd = start + choice.length;
        }
    });
    const axisTone = focused ? TUI_ACCENT : TUI_MUTED;
    const line = optionLine.join("");
    // The chosen stop is this section's cursor, so it takes the same lit fill a
    // list row takes, and the same quiet one while the section is unfocused.
    const cursor = focused
        ? fg(TUI_BACKGROUND)(bg(TUI_ACCENT)(line.slice(selectedStart, selectedEnd)))
        : fg(TUI_TEXT)(bg(TUI_ELEMENT)(line.slice(selectedStart, selectedEnd)));
    const rest = focused ? TUI_TEXT : TUI_MUTED;
    return [
        [fg(axisTone)(clippedTo(axis, width))],
        track,
        [
            fg(rest)(line.slice(0, selectedStart)),
            cursor,
            fg(rest)(line.slice(selectedEnd)),
        ],
    ];
}

export const LISTED_SCORE_WIDTH = 9;

export const LISTED_RATES_WIDTH = 6;

export const IMAGE_GLYPH = "i";

export const LISTED_TRAILING_WIDTH = 2 + 1 + 1 + IMAGE_GLYPH.length + 1 + 1;

export function showsListedFactsHeader(state: TuiAnySettingsPickerState): boolean {
    return state.kind === "model" && state.tab === "all";
}

export function listedFactCell(text: string, width: number): string {
    return text.length >= width ? text.slice(0, width) : text.padStart(width);
}

/** Every listed row reserves this much, so the columns line up under the header. */
export const LISTED_FACTS_WIDTH = LISTED_SCORE_WIDTH + 2 + LISTED_RATES_WIDTH
    + LISTED_TRAILING_WIDTH;

export function listedFactsHeaderText(): string {
    return `${"WA Score*".padStart(LISTED_SCORE_WIDTH)}  ${
        BLENDED_RATIO.padStart(LISTED_RATES_WIDTH)
    }${" ".repeat(LISTED_TRAILING_WIDTH)}`;
}

/** One glyph per fact, so a library row keeps its label instead of spending it on prose. */
export function shortlistFactsText(option: TuiSettingsPickerOption): string {
    const price = formatListedPrice(option.pricing) ?? "no price";
    const kept = option.pooledRank === undefined ? "\u00b7" : "\u2605";
    const verified = option.verificationError !== undefined ? "\u2717"
        : option.unverified === false || option.pooledRank !== undefined && option.unverified !== true
        ? "\u2713" : "-";
    return `${price.padStart(SHORTLIST_PRICE_WIDTH)}  ${kept} ${verified} ${option.unavailable ? "!" : " "}`;
}

const SHORTLIST_PRICE_WIDTH = 7;

const SHORTLIST_LEGENDS = [
    "\u2605 kept   \u00b7 not kept   \u2713 verified   - not probed   \u2717 probe failed   ! unavailable",
    "\u2605 kept  \u00b7 not kept  \u2713 verified  - unprobed  \u2717 failed  ! unavailable",
    "\u2605/\u00b7 kept  \u2713/-/\u2717 verified  ! unavailable",
];

export function shortlistLegendText(width: number): string {
    return SHORTLIST_LEGENDS.find((legend) => legend.length <= width)
        ?? SHORTLIST_LEGENDS[SHORTLIST_LEGENDS.length - 1]!;
}

export function shortlistLegendNode(
    renderer: RenderContext,
    width: number,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_MUTED)(clippedTo(shortlistLegendText(width), width)),
        ]),
        width,
        height: 1,
    });
}

/** The star on the WA Score column, answered on the screen that draws the star rather than only under Help. */
export const LISTED_FACTS_FOOTNOTE =
    "* WA Score: rating from blind comparisons of model responses.";

export const LISTED_FACTS_FOOTNOTE_LINES = 1;

export function listedFactsFootnoteNode(
    renderer: RenderContext,
    width: number,
): TextRenderable {
    return new TextRenderable(renderer, {
        content: new StyledText([
            fg(TUI_MUTED)(clippedTo(LISTED_FACTS_FOOTNOTE, width)),
        ]),
        width,
        height: LISTED_FACTS_FOOTNOTE_LINES,
    });
}

export function listedFactsParts(
    option: TuiSettingsPickerOption,
): readonly DialogMetaPart[] {
    const score = listedFactCell(
        option.waScore === undefined ? "" : String(option.waScore),
        LISTED_SCORE_WIDTH,
    );
    const rates = listedFactCell(
        formatBlendedRate(option.pricing) ?? "",
        LISTED_RATES_WIDTH,
    );
    const image = option.images === true
        ? IMAGE_GLYPH
        : " ".repeat(IMAGE_GLYPH.length);
    const mark = option.pooledRank !== undefined ? "★" : " ";
    return [
        { text: `${score}  ${rates}  `, atomic: true },
        option.onPareto === true
            ? { text: "P", tone: "positive", atomic: true }
            : { text: " ", atomic: true },
        { text: ` ${image} ${mark}`, atomic: true },
    ];
}

export function optionMetaPrefixParts(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    detailed: boolean,
): readonly DialogMetaPart[] {
    const parts: DialogMetaPart[] = [];
    const separated = (part: DialogMetaPart): void => {
        if (parts.length > 0) {
            parts.push({ text: " · " });
        }
        parts.push(part);
    };
    if (
        option.provider !== undefined
        && !detailed
        && (option.inTopPicks === true || !isProviderGrouped(state))
    ) {
        separated({ text: option.provider });
    }
    if (option.recommended === true && option.inTopPicks !== true) {
        separated({ text: "top pick", tone: "positive" });
    }
    if (option.poolName !== undefined && option.model !== undefined) {
        separated({ text: option.model });
    }
    if (option.unavailable === true) {
        separated({ text: "unavail" });
    }
    return parts;
}

export function metaPartsLength(parts: readonly DialogMetaPart[]): number {
    return parts.reduce((total, part) => total + part.text.length, 0);
}

export function optionMeta(
    state: TuiAnySettingsPickerState,
    option: TuiSettingsPickerOption,
    detailed = false,
    listedPrefixWidth = 0,
): DialogMeta | undefined {
    if (state.kind === "session") {
        if (option.sizeBytes === undefined) {
            return option.workspace;
        }
        return [
            { text: formatSessionSize(option.sizeBytes) },
            { text: "  " },
            { text: option.workspace ?? "" },
        ];
    }
    if (state.kind === "provider") {
        // The door it opens, at the trailing edge. The gutter column belongs to
        // the cursor, and a `+` sitting in it reads as a second cursor.
        if (option.action === true) return [{ text: "\u203a" }];
        // The three words, not a colour and not a boolean: a stored key that
        // has never answered is not a working provider.
        if (option.answerState === undefined) return undefined;
        return [{
            text: option.answerState,
            tone: option.answerState === "connected" ? "positive" : "detail",
        }];
    }
    if (state.kind !== "model") {
        return undefined;
    }
    if (
        state.tab === "defaults" || state.tab === "actions"
        || tuiModelActionOfValue(option.value) !== undefined
    ) {
        return option.description === ""
            ? undefined
            : [{ text: option.description }];
    }
    const prefix = optionMetaPrefixParts(state, option, detailed);
    const parts: DialogMetaPart[] = [...prefix];
    if (
        state.tab === "all"
        && option.section === undefined
        && tuiModelActionOfValue(option.value) === undefined
    ) {
        // The badges are a column of their own: every row gives the fact
        // columns the same starting point, so they line up under the header.
        const fitted = clipDialogMetaParts(prefix, listedPrefixWidth);
        parts.length = 0;
        parts.push(...fitted);
        const pad = Math.max(0, listedPrefixWidth - metaPartsLength(fitted));
        if (pad > 0) {
            parts.push({ text: " ".repeat(pad) });
        }
        parts.push(...listedFactsParts(option));
    }
    if (
        state.tab === "pool"
        && option.section === undefined
        && tuiModelActionOfValue(option.value) === undefined
        && option.pooledRank !== undefined
        && option.unverified !== true
    ) {
        if (parts.length > 0) {
            parts.push({ text: " · " });
        }
        parts.push({ text: "✓", tone: "positive" });
    }
    return parts.length === 0 ? undefined : parts;
}

export function modelEmptyMessage(state: TuiAnySettingsPickerState): string {
    if (state.kind !== "model") return "No matches found";
    if (state.query !== "") {
        return state.tab === "pool"
            ? "No favorites match. Tab switches to Catalog."
            : "No models match that search.";
    }
    if (state.modelCatalogUnavailable === true) {
        return "Models arrive with a conversation. Start one, then reopen this.";
    }
    if (state.tab !== "pool") {
        return "No models yet. Ctrl+F asks your providers for their catalogs.";
    }
    return modelPageEntry(state) === undefined
        ? "No favorites yet. Tab switches to Catalog."
        : "No favorites yet. More above adds the current model.";
}

export function modelEmptyDetailBody(
    state: TuiAnySettingsPickerState,
    width: number,
): readonly string[] {
    const [, ...rest] = modelEmptyMessage(state).split(". ");
    return wrappedTo(rest.join(". "), width);
}

export function switchedModelTab(
    state: TuiSettingsPickerState,
    tab: TuiModelPickerTab,
): TuiSettingsPickerState {
    if (state.kind !== "model") {
        return state;
    }
    const selectedValue = state.options[state.selectedIndex]?.value;
    const options = modelListFor(state, { tab, query: "" });
    return {
        ...state,
        tab,
        options,
        query: "",
        modelFocus: "list",
        modelActionIndex: 0,
        selectedIndex: restoredCursor(options, selectedValue, state.initialModel),
    };
}

export function restoredCursor(
    options: readonly TuiSettingsPickerOption[],
    selectedValue: string | undefined,
    initialModel: string | undefined,
): number {
    const selected = options.findIndex(
        (option) => option.value === selectedValue,
    );
    if (selected !== -1) {
        return selected;
    }
    return Math.max(
        0,
        options.findIndex((option) => option.value === initialModel),
    );
}

export function matching(
    options: readonly TuiSettingsPickerOption[],
    query: string,
): readonly TuiSettingsPickerOption[] {
    const normalized = query.toLowerCase();
    return options.filter((option) =>
        option.action === true
        || `${option.label} ${option.value} ${option.description} ${
                option.searchText ?? ""
            }`
            .toLowerCase()
            .includes(normalized)
    );
}

export function searched(
    state: TuiSettingsPickerState,
    query: string,
    queryCursor = query.length,
): TuiSettingsPickerTransition {
    const options = state.kind !== "model"
        ? matching(state.allOptions, query)
        : modelListFor(state, { query });
    const next = {
        ...state,
        options,
        selectedIndex: state.modelBrowse === undefined ? 0 : Math.max(0, options.findIndex((row) => row.model !== undefined)),
        query,
        queryCursor,
        // A query is about rows, so it carries the reader into the list rather
        // than filtering something they cannot see.
        ...(state.kind === "model" ? { modelFocus: "list" as const } : {}),
    };
    return {
        state: next,
        handled: true,
        ...themePreview(next),
    };
}

export function pickerIsSearchable(state: TuiAnySettingsPickerState): boolean {
    if (state.kind === "extension") return state.searchable === true;
    return true
        && state.kind !== "model_menu"
        && state.kind !== "configure"
        && state.kind !== "model_defaults"
        && state.kind !== "session_leave"
        && state.kind !== "model_verification"
        && state.kind !== "pool_verify_scope"
        && state.kind !== "catalog_refresh_scope"
        && !(state.kind === "model_assignment"
            && state.modelAssignment === "subagents");
}

export function themePreview(
    state: TuiSettingsPickerState,
): { readonly previewTheme?: TuiThemeName } {
    if (state.kind !== "theme") {
        return {};
    }
    const value = state.options[state.selectedIndex]?.value;
    return value === undefined ? {} : { previewTheme: value as TuiThemeName };
}

export function modelOptions(
    available: readonly SuggestedModel[] | undefined,
    currentProvider: string | undefined,
    currentModel: string | undefined,
    pooled: readonly PooledModel[] = [],
): readonly TuiSettingsPickerOption[] {
    const poolEntry = new Map(
        pooled.map((entry, rank) =>
            [providerModelKey(entry.provider, entry.model), { entry, rank }] as const
        ),
    );
    const poolMarks = (value: string): Partial<TuiSettingsPickerOption> => {
        const held = poolEntry.get(value);
        return {
            ...(held === undefined ? {} : { pooledRank: held.rank }),
            ...(held?.entry.poolName === undefined
                ? {}
                : { poolName: held.entry.poolName, label: held.entry.displayName ?? held.entry.poolName }),
            ...(held !== undefined && !held.entry.verified
                ? { unverified: true }
                : {}),
            ...(held?.entry.imageSupport === true ? { images: true } : {}),
            ...(held?.entry.waScore === undefined
                ? {}
                : { waScore: held.entry.waScore }),
            ...(held?.entry.pricing === undefined
                ? {}
                : { pricing: held.entry.pricing }),
            ...(held?.entry.onPareto === true ? { onPareto: true } : {}),
        };
    };
    const runnable = (available ?? []).map((model) => {
        const value = providerModelKey(model.provider, model.model);
        return {
            value,
            label: modelRowLabel(model),
            description: model.description,
            searchText: `${model.provider} ${model.model}${
                poolEntry.get(value)?.entry.poolName === undefined
                    ? ""
                    : ` ${poolEntry.get(value)?.entry.poolName}`
            }`,
            provider: model.provider,
            model: model.model,
            ...(model.refreshable === true ? { refreshable: true } : {}),
            ...(model.hiddenByDefault === undefined
                ? {}
                : { hiddenByDefault: model.hiddenByDefault }),
            ...recommendationMarks(model),
            ...poolMarks(value),
            ...(model.verified === undefined ? {} : { unverified: !model.verified }),
            ...(model.verificationError === undefined ? {} : { verificationError: model.verificationError }),
            ...(model.imageSupport === true || poolEntry.get(value)?.entry.imageSupport === true
                ? { images: true }
                : {}),
            ...(model.waScore === undefined ? {} : { waScore: model.waScore }),
            ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
            ...(model.onPareto === true ? { onPareto: true } : {}),
        };
    });
    const currentValue = currentModel === undefined || currentProvider === undefined
        ? undefined
        : providerModelKey(currentProvider, currentModel);
    if (
        currentValue !== undefined && currentProvider !== undefined
        && currentModel !== undefined
        && !runnable.some((option) => option.value === currentValue)
    ) {
        runnable.push({
            value: currentValue,
            label: currentModel,
            description: "current model",
            searchText: `${currentProvider} ${currentModel}`,
            provider: currentProvider,
            model: currentModel,
            ...poolMarks(currentValue),
            ...(available === undefined ? {} : { unavailable: true }),
        });
    }
    const orphanEntries = pooled.flatMap((entry, rank) => {
        const value = providerModelKey(entry.provider, entry.model);
        return runnable.some((option) => option.value === value) ? [] : [{
            value,
            label: entry.displayName ?? entry.poolName ?? modelRowLabel(entry),
            description: "not available right now",
            searchText: `${entry.provider} ${entry.model}${
                entry.poolName === undefined ? "" : ` ${entry.poolName}`
            }`,
            ...(entry.poolName === undefined
                ? {}
                : { poolName: entry.poolName }),
            provider: entry.provider,
            model: entry.model,
            pooledRank: rank,
            unavailable: true,
            ...recommendationMarks(entry),
            ...(entry.verified ? {} : { unverified: true }),
            ...(entry.imageSupport === true ? { images: true } : {}),
            ...(entry.waScore === undefined ? {} : { waScore: entry.waScore }),
            ...(entry.pricing === undefined ? {} : { pricing: entry.pricing }),
            ...(entry.onPareto === true ? { onPareto: true } : {}),
        }];
    });
    return [...runnable, ...orphanEntries].toSorted((left, right) =>
        left.provider.localeCompare(right.provider)
            || left.label.localeCompare(right.label)
    );
}

export function modelRowLabel(
    model: Pick<SuggestedModel, "model" | "label">,
): string {
    const maker = model.model.split("/", 1)[0];
    if (maker === undefined || !model.model.includes("/")) {
        return model.label;
    }
    const colon = model.label.indexOf(":");
    if (colon === -1) return model.label;
    const prefix = model.label.slice(0, colon);
    return prefix.localeCompare(maker, undefined, { sensitivity: "base" }) === 0
        ? model.label.slice(prefix.length + 1).trimStart()
        : model.label;
}

export function recommendationMarks(model: {
    readonly recommended?: boolean;
    readonly recommendedLevel?: string;
}): Partial<TuiSettingsPickerOption> {
    if (model.recommended !== true) {
        return {};
    }
    return {
        recommended: true,
        ...(model.recommendedLevel === undefined
            ? {}
            : { recommendedLevel: model.recommendedLevel }),
    };
}

export function modelTabRows(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
    revealAll = false,
    assignmentOptions: readonly TuiSettingsPickerOption[] = [],
    actionOptions: readonly TuiSettingsPickerOption[] = [],
    intelligenceCutoff: IntelligenceCutoff = "any",
    keepModel?: string,
): readonly TuiSettingsPickerOption[] {
    const actions = availableModelActionOptions(allOptions, actionOptions);
    if (tab === "help") {
        return [];
    }
    if (tab === "actions") {
        return actions;
    }
    if (tab === "defaults") {
        return assignmentOptions;
    }
    if (tab === "recommended") {
        return allOptions.filter((option) =>
            option.recommended === true && option.unavailable !== true
        );
    }
    if (tab === "all") {
        return allOptions.filter((option) =>
            option.unavailable !== true
            && (revealAll || option.hiddenByDefault === undefined
                || option.pooledRank !== undefined)
            && (passesIntelligenceCutoff(option.waScore, intelligenceCutoff)
                || option.model === keepModel
                || option.value === keepModel)
        );
    }
    return allOptions
        .filter((option) => option.pooledRank !== undefined)
        .toSorted((left, right) => left.pooledRank! - right.pooledRank!);
}

export function availableModelActionOptions(
    allOptions: readonly TuiSettingsPickerOption[],
    actionOptions: readonly TuiSettingsPickerOption[],
): readonly TuiSettingsPickerOption[] {
    return actionOptions.filter((action) => {
        if (tuiModelActionOfValue(action.value) !== "shortlist_current") {
            return true;
        }
        return !allOptions.some((option) =>
            option.provider === action.provider
            && option.model === action.model
            && option.pooledRank !== undefined
        );
    });
}

export function modelListFor(
    state: TuiSettingsPickerState,
    patch: {
        collapsed?: readonly string[];
        query?: string;
        revealAll?: boolean;
        tab?: TuiModelPickerTab;
        intelligenceCutoff?: IntelligenceCutoff;
    } = {},
): readonly TuiSettingsPickerOption[] {
    if (state.modelBrowse !== undefined) return browseModels({ ...state, ...patch });
    return modelPickerOptions(
        state.allOptions,
        patch.tab ?? state.tab ?? "all",
        patch.collapsed ?? state.collapsed ?? [],
        patch.query ?? state.query,
        patch.revealAll ?? state.revealAll === true,
        state.assignmentOptions ?? [],
        state.actionOptions ?? [],
        patch.intelligenceCutoff ?? state.intelligenceCutoff ?? "any",
        state.initialModel,
    );
}

export function modelPickerOptions(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
    collapsed: readonly string[],
    query: string,
    revealAll = false,
    assignmentOptions: readonly TuiSettingsPickerOption[] = [],
    actionOptions: readonly TuiSettingsPickerOption[] = [],
    intelligenceCutoff: IntelligenceCutoff = "any",
    keepModel?: string,
): readonly TuiSettingsPickerOption[] {
    const rows = modelTabRows(
        allOptions,
        tab,
        revealAll || query !== "",
        assignmentOptions,
        actionOptions,
        query === "" ? intelligenceCutoff : "any",
        keepModel,
    );
    const matched = query === "" ? rows : matching(rows, query);
    if (tab === "pool" || tab === "defaults" || tab === "actions") {
        return matched;
    }
    const actions = query === "" ? [] : matching(actionOptions, query);
    return [
        ...(actions.length === 0
            ? []
            : [sectionHeader("Actions", actions, []), ...actions]),
        ...sectionedOptions(
            matched,
            query === "" ? collapsed : [],
            tab === "all",
            groupTotals(allOptions, tab),
        ),
    ];
}

export function groupTotals(
    allOptions: readonly TuiSettingsPickerOption[],
    tab: TuiModelPickerTab,
): ReadonlyMap<string, number> {
    const totals = new Map<string, number>();
    for (const row of modelTabRows(allOptions, tab, true)) {
        const label = row.group ?? row.provider ?? "Other";
        totals.set(label, (totals.get(label) ?? 0) + 1);
    }
    return totals;
}

export function sectionHeader(
    label: string,
    rows: readonly TuiSettingsPickerOption[],
    collapsed: readonly string[],
    total = rows.length,
): TuiSettingsPickerOption {
    const closed = collapsed.includes(label);
    const count = total > rows.length
        ? `${rows.length} of ${total}`
        : `${rows.length}`;
    return {
        value: sectionValue(label),
        label: closed ? `${label} (${count})` : label,
        description: "",
        section: label,
        ...(closed ? { sectionCollapsed: true } : {}),
    };
}

export function sectionValue(label: string): string {
    return `section:${label}`;
}

export function sectionedOptions(
    rows: readonly TuiSettingsPickerOption[],
    collapsed: readonly string[],
    topPicks: boolean,
    totals: ReadonlyMap<string, number> = new Map(),
): readonly TuiSettingsPickerOption[] {
    const options: TuiSettingsPickerOption[] = [];
    const picks = topPicks
        ? rows.filter((row) => row.recommended === true)
        : [];
    if (picks.length > 0) {
        options.push(sectionHeader(TUI_TOP_PICKS_SECTION, picks, collapsed));
        if (!collapsed.includes(TUI_TOP_PICKS_SECTION)) {
            options.push(...picks.map((row) => ({
                ...row,
                value: `${TUI_TOP_PICKS_SECTION}:${row.value}`,
                inTopPicks: true,
            })));
        }
    }
    const providers = new Map<string, TuiSettingsPickerOption[]>();
    rows.forEach((row) => {
        const label = row.group ?? row.provider ?? "Other";
        const existing = providers.get(label);
        if (existing === undefined) {
            providers.set(label, [row]);
            return;
        }
        existing.push(row);
    });
    providers.forEach((group, label) => {
        options.push(
            sectionHeader(label, group, collapsed, totals.get(label) ?? group.length),
        );
        if (!collapsed.includes(label)) {
            options.push(...group);
        }
    });
    return options;
}

export function defaultCollapsedSections(
    allOptions: readonly TuiSettingsPickerOption[],
    currentValue: string | undefined,
): readonly string[] {
    const rows = modelTabRows(allOptions, "all");
    const open = rows.find((option) => option.value === currentValue)?.provider;
    const sections = new Set<string>();
    rows.forEach((option) => {
        const label = option.group ?? option.provider ?? "Other";
        if (label !== open) {
            sections.add(label);
        }
    });
    return [...sections];
}

export function sectionLabels(
    state: TuiSettingsPickerState,
): readonly string[] {
    return modelListFor(state, { collapsed: [] }).flatMap((option) => option.section === undefined ? [] : [option.section]);
}

export function enclosingSection(
    state: TuiAnySettingsPickerState,
): (TuiSettingsPickerOption & { readonly section: string }) | undefined {
    if (state.kind !== "model") {
        return undefined;
    }
    for (let index = state.selectedIndex; index >= 0; index--) {
        const option = state.options[index];
        if (option?.section !== undefined) {
            return { ...option, section: option.section };
        }
    }
    return undefined;
}

export function toggledSection(
    state: TuiSettingsPickerState,
    label: string,
): TuiSettingsPickerTransition {
    const collapsed = (state.collapsed ?? []).includes(label)
        ? (state.collapsed ?? []).filter((entry) => entry !== label)
        : [...(state.collapsed ?? []), label];
    const options = modelListFor(state, { collapsed });
    return {
        state: {
            ...state,
            collapsed,
            options,
            selectedIndex: Math.max(
                0,
                options.findIndex((option) => option.value === sectionValue(label)),
            ),
        },
        handled: true,
    };
}

export function providerModelKey(provider: string, model: string): string {
    return JSON.stringify([provider, model]);
}

export function modelActionTransition(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerTransition | undefined {
    const action = tuiModelActionOfValue(option.value);
    if (action === undefined) {
        return undefined;
    }
    if (action === "refresh") {
        return { state, handled: true, refreshCatalogScope: true };
    }
    if (action === "verify_pool") {
        return { state, handled: true, poolVerifySweep: true };
    }
    if (
        action === "shortlist_current"
        && option.provider !== undefined
        && option.model !== undefined
    ) {
        return {
            state,
            handled: true,
            poolToggle: {
                action: "add",
                provider: option.provider,
                model: option.model,
            },
        };
    }
    if (action === "providers") {
        return { state, handled: true, openProviders: true };
    }
    if (action === "reveal_all") {
        const revealAll = state.revealAll !== true;
        const revealed = switchedModelTab({ ...state, revealAll }, "all");
        return { state: revealed, handled: true };
    }
    return unchanged(state, true);
}

export function pickerSelection(
    state: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerSelection {
    const kind = state.kind;
    if (kind === "model") {
        const assignment = modelAssignmentOfValue(option.value);
        if (assignment !== undefined) {
            return { kind: "model_assignment_open", assignment };
        }
        if (option.value === CONTEXT_LIMIT_VALUE) {
            return { kind: "menu", target: "context_limit" };
        }
        if (option.provider === undefined || option.model === undefined) {
            throw new Error("model picker option is missing provider identity");
        }
        return { kind, provider: option.provider, model: option.model };
    }
    const value = option.value;
    if (kind === "provider") {
        return { kind, providerId: value };
    }
    if (kind === "reasoning") {
        if (state.pendingModel !== undefined) {
            const pending = state.pendingModel;
            if (pending.assignment !== undefined) {
                return {
                    kind: "model_assignment",
                    assignment: pending.assignment,
                    provider: pending.provider,
                    model: pending.model,
                    reasoningEffort: value as ModelReasoningEffort,
                };
            }
            return {
                kind: "model",
                provider: pending.provider,
                model: pending.model,
                reasoningEffort: value as ModelReasoningEffort,
            };
        }
        return { kind, reasoningEffort: value as ModelReasoningEffort };
    }
    if (kind === "permissions") {
        return { kind, mode: value as ApprovalMode };
    }
    if (kind === "context_limit") {
        return {
            kind,
            limit: value === "auto" ? null : Number(value),
        };
    }
    if (kind === "override_value") {
        const key = state.overrideKey;
        if (key === undefined) {
            throw new Error("override value pane has no key");
        }
        return {
            kind: "overrides",
            patch: {
                [key]: value === "default" || value === "auto"
                    ? null
                    : key === "toolResultAgingLevel"
                    ? value
                    : Number(value),
            },
        };
    }
    if (kind === "overrides_settings") {
        // A null patch is the reset: the host clears every lever at once.
        return value === OVERRIDES_RESET_VALUE
            ? { kind: "overrides", patch: null }
            : { kind: "menu", target: value as TuiSettingsMenuTarget };
    }
    if (kind === "session") {
        return {
            kind,
            sessionPath: value,
            sourceDisposition: state.enterDisposition ?? "stop",
            ...(option.sessionId === undefined
                ? {}
                : { sessionId: option.sessionId }),
        };
    }
    if (kind === "configure") {
        const file = state.configureFiles?.find((candidate) =>
            candidate.path === value
        );
        if (file === undefined) {
            throw new Error("configure picker option is missing file identity");
        }
        return { kind, file };
    }
    if (
        kind === "settings"
        || kind === "permission_settings"
        || kind === "reviewer_settings"
    ) {
        return { kind: "menu", target: value as TuiSettingsMenuTarget };
    }
    if (kind === "pool_verify_scope") {
        return {
            kind,
            onlyUnverified: value === POOL_VERIFY_UNVERIFIED_VALUE,
        };
    }
    if (kind === "catalog_refresh_scope") {
        return {
            kind,
            providers: value === CATALOG_REFRESH_ALL_VALUE
                ? state.allOptions
                    .map((option) => option.value)
                    .filter((name) => name !== CATALOG_REFRESH_ALL_VALUE)
                : [value],
        };
    }
    if (kind === "model_assignment") {
        if (value === MODEL_ASSIGNMENT_BROWSE_VALUE) {
            return { kind: "model_assignment_browse" };
        }
        if (value === MODEL_ASSIGNMENT_SELF_VALUE) {
            return {
                kind,
                assignment: state.modelAssignment ?? "subagents",
                allowSelf: state.assignmentAllowsSelf !== true,
            };
        }
        return {
            kind,
            assignment: state.modelAssignment ?? "extra",
            ...(value === REVIEWER_CLEAR_VALUE ? { clear: true } : {
                ...(option.provider === undefined
                    ? {}
                    : { provider: option.provider }),
                ...(option.model === undefined ? {} : { model: option.model }),
                ...(state.assignedModels?.includes(value) === true
                    ? { remove: true }
                    : {}),
            }),
        };
    }
    if (kind === "reviewer") {
        return {
            kind,
            slot: state.reviewerSlot ?? "primary",
            ...(value === REVIEWER_CLEAR_VALUE ? {} : {
                ...(option.provider === undefined
                    ? {}
                    : { provider: option.provider }),
                ...(option.model === undefined ? {} : { model: option.model }),
            }),
        };
    }
    if (kind === "model_defaults" || kind === "session_leave" || kind === "model_verification" || kind === "model_menu") throw new Error("This picker handles its actions directly");
    if (kind === "provider_actions") throw new Error("Provider actions must use their action transition");
    return { kind, theme: value as TuiThemeName };
}

export function unchanged(
    state: TuiExtensionPickerState,
    handled: boolean,
): TuiExtensionPickerTransition;

export function unchanged(
    state: TuiSettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition;

export function unchanged(
    state: TuiAnySettingsPickerState,
    handled: boolean,
): TuiSettingsPickerTransition | TuiExtensionPickerTransition {
    if (state.kind === "extension") {
        return { state, handled };
    }
    return { state, handled };
}

import {
    BoxRenderable,
    TextAttributes,
    TextRenderable,
} from "@opentui/core";

import type { VeraExperimentalTuiRawContext } from "../../../src/sdk/experimental-tui.ts";
import {
    buildContextReport,
    contextResponsiveMode,
    formatTokens,
    type ContextReport,
} from "./context-report.ts";

export interface ContextViewOptions {
    readonly id: string;
    readonly detail: boolean;
    readonly commandText: string;
}

export interface ContextView {
    readonly root: BoxRenderable;
    refresh(width: number): void;
}

export function createContextView(
    context: VeraExperimentalTuiRawContext,
    snapshot: Parameters<typeof buildContextReport>[0],
    options: ContextViewOptions,
): ContextView {
    const root = new BoxRenderable(context.renderer, {
        id: options.id,
        width: "100%",
        flexDirection: "column",
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
    });

    function refresh(width: number): void {
        for (const child of [...root.getChildren()]) {
            root.remove(child.id);
            child.destroyRecursively();
        }
        const report = buildContextReport(snapshot, options.detail, width);
        addText(`↳ ${options.commandText}`, context.theme.muted);
        addText("├─ Context Usage", context.theme.accent, true);

        if (report.grid === undefined) {
            addText(`│  ${report.headline}`, context.theme.text);
            addText(
                report.snapshot.projection === undefined
                    ? "│  Breakdown unavailable until the first model request"
                    : "│  Capacity unavailable; percentage and grid omitted",
                context.theme.muted,
            );
        } else {
            const grid = renderGrid(context.renderer, report);
            const summary = renderSummary(context.renderer, report);
            if (contextResponsiveMode(width) === "wide") {
                const row = new BoxRenderable(context.renderer, {
                    id: `${root.id}-usage-row`,
                    width: "100%",
                    height: report.grid.rows.length,
                    flexDirection: "row",
                });
                row.add(grid);
                row.add(summary);
                root.add(row);
            } else {
                root.add(grid);
                root.add(summary);
            }
        }

        if (report.categories.length === 0) {
            addText("├─ Components", context.theme.accent, true);
            addText("│  No component breakdown is available yet", context.theme.muted);
        } else {
            for (const category of report.categories) {
                addText(
                    `├─ ${category.label}  ${formatTokens(category.tokens)} est.`,
                    context.theme.text,
                );
                if (options.detail) {
                    for (const component of report.detail.filter((candidate) =>
                        category.components.includes(candidate)
                    )) {
                        addText(
                            `│  · ${component.displayName}  ${formatTokens(component.estimatedTokens)} est.`,
                            context.theme.muted,
                        );
                    }
                }
            }
        }

        if (report.grid !== undefined) {
            addText(
                `├─ Free space  ${formatTokens(report.grid.freeTokens)} est.`,
                context.theme.muted,
            );
            if (report.grid.reserveTokens > 0) {
                addText(
                    `├─ Autocompact buffer  ${formatTokens(report.grid.reserveTokens)} est.`,
                    context.theme.muted,
                );
            }
        }
        if (report.suggestions.length > 0) {
            addText("├─ Suggestions", context.theme.accent, true);
            for (const suggestion of report.suggestions) {
                addText(
                    `│  ${suggestion.tone === "warning" ? "!" : "·"} ${suggestion.text}`,
                    suggestion.tone === "warning"
                        ? context.theme.notice
                        : context.theme.muted,
                );
            }
        }
        addText(
            `└─ /context ${options.detail ? "to collapse" : "all to expand"}`,
            context.theme.muted,
        );
    }

    function addText(content: string, color: string, bold = false): void {
        root.add(new TextRenderable(context.renderer, {
            id: `${root.id}-line-${root.getChildren().length}`,
            content,
            fg: color,
            width: "100%",
            height: 1,
            wrapMode: "word",
            ...(bold ? { attributes: TextAttributes.BOLD } : {}),
        }));
    }

    refresh(context.renderer.terminalWidth);
    return { root, refresh };
}

function renderGrid(
    renderer: VeraExperimentalTuiRawContext["renderer"],
    report: ContextReport,
): BoxRenderable {
    const grid = report.grid!;
    const root = new BoxRenderable(renderer, {
        id: "context-grid",
        width: grid.columns + 2,
        height: grid.rows.length,
        flexDirection: "column",
        paddingRight: 1,
    });
    for (const row of grid.rows) {
        root.add(new TextRenderable(renderer, {
            id: `context-grid-row-${root.getChildren().length}`,
            content: row.map((cell) => cell.glyph).join(""),
            width: grid.columns,
            height: 1,
        }));
    }
    return root;
}

function renderSummary(
    renderer: VeraExperimentalTuiRawContext["renderer"],
    report: ContextReport,
): BoxRenderable {
    const summary = new BoxRenderable(renderer, {
        id: "context-summary",
        height: summaryLineCount(report),
        flexGrow: 1,
        flexDirection: "column",
        paddingLeft: 1,
    });
    summary.add(new TextRenderable(renderer, {
        id: "context-summary-headline",
        content: report.headline,
        width: "100%",
        wrapMode: "word",
    }));
    summary.add(new TextRenderable(renderer, {
        id: "context-summary-legend",
        content: "█ used   · free   ░ autocompact reserve",
        width: "100%",
        wrapMode: "word",
    }));
    if (report.grid !== undefined) {
        summary.add(new TextRenderable(renderer, {
            id: "context-summary-trigger",
            content: `Auto-compact window · ${formatTokens(report.grid.usedTokens + report.grid.freeTokens)} tokens`,
            width: "100%",
            wrapMode: "word",
        }));
        if (
            report.snapshot.model?.capacity !== undefined
            && report.grid.usedTokens > report.snapshot.model.capacity
        ) {
            summary.add(new TextRenderable(renderer, {
                id: "context-summary-overflow",
                content: `Overflow · ${formatTokens(
                    report.grid.usedTokens - report.snapshot.model.capacity,
                )} over capacity`,
                width: "100%",
                wrapMode: "word",
            }));
        }
    }
    return summary;
}

function summaryLineCount(report: ContextReport): number {
    if (report.grid === undefined) return 2;
    return report.snapshot.model?.capacity !== undefined
        && report.grid.usedTokens > report.snapshot.model.capacity
        ? 4
        : 3;
}

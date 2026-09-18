import type {
    VeraClientContextComponent,
    VeraClientContextPart,
    VeraClientContextSnapshot,
} from "../../sdk/context.ts";
import { inspectReportSection } from "vera/sdk/inspect-report";

export type ContextResponsiveMode = "wide" | "narrow";

export interface ContextBreakdownRow {
    readonly label: string;
    readonly tokens: number;
    readonly percent: number;
    readonly bar: string;
    readonly components: readonly VeraClientContextComponent[];
}

export interface ContextInstructionRow {
    readonly scope: string;
    readonly displayName: string;
    readonly bytes: number;
    readonly estimatedTokens: number;
    readonly imported: boolean;
    readonly bar: string;
}

export interface ContextOccupancy {
    readonly usedTokens: number;
    readonly freeTokens: number;
    readonly reserveTokens: number;
    readonly triggerTokens: number;
    readonly bar: string;
    readonly tickColumn: number;
}

export interface ContextReport {
    readonly snapshot: VeraClientContextSnapshot;
    readonly headline: string;
    readonly estimated: boolean;
    readonly occupancy?: ContextOccupancy;
    readonly breakdown: readonly ContextBreakdownRow[];
    readonly instructions: readonly ContextInstructionRow[];
    readonly instructionSummary?: string;
    readonly fileWarnings: readonly string[];
    readonly detail: readonly VeraClientContextComponent[];
    readonly breakdownMissing?: string;
}

const CATEGORY_ORDER = [
    "Instructions",
    "System tools",
    "Messages",
    "System prompt",
    "Extension tools",
    "Custom agents",
] as const;

const INSTRUCTION_IDS = new Set([
    "core.project-instructions",
    "core.memory",
    "core.agent-instructions",
    "host.skills",
]);

const RIDES_EVERY_TURN_BYTES = 16 * 1024;

export function contextResponsiveMode(width: number): ContextResponsiveMode {
    return width < 80 ? "narrow" : "wide";
}

export function contextCategories(
    snapshot: VeraClientContextSnapshot,
): readonly { label: string; tokens: number; components: VeraClientContextComponent[] }[] {
    const grouped = new Map<string, {
        tokens: number;
        components: VeraClientContextComponent[];
    }>();
    for (const component of snapshot.projection?.components ?? []) {
        const label = categoryLabel(component);
        const prior = grouped.get(label) ?? { tokens: 0, components: [] };
        prior.tokens += component.estimatedTokens;
        prior.components.push(component);
        grouped.set(label, prior);
    }
    return [...grouped.entries()]
        .map(([label, value]) => ({ label, ...value }))
        .sort((left, right) => {
            const order = CATEGORY_ORDER.indexOf(left.label as typeof CATEGORY_ORDER[number])
                - CATEGORY_ORDER.indexOf(right.label as typeof CATEGORY_ORDER[number]);
            return order !== 0 ? order : right.tokens - left.tokens;
        });
}

export function contextCompactionTrigger(
    snapshot: VeraClientContextSnapshot,
): number | undefined {
    const capacity = snapshot.model?.capacity;
    const thresholds: number[] = [];
    if (snapshot.compaction?.triggerTokens !== undefined) {
        thresholds.push(snapshot.compaction.triggerTokens);
    }
    if (capacity !== undefined) {
        thresholds.push(
            capacity * (snapshot.compaction?.triggerFraction ?? 0.82),
        );
        thresholds.push(capacity);
    }
    return thresholds.length === 0 ? undefined : Math.min(...thresholds);
}

export function buildContextReport(
    snapshot: VeraClientContextSnapshot,
    detail: boolean,
    width: number,
): ContextReport {
    const categories = contextCategories(snapshot);
    const used = snapshot.headline?.tokens;
    const capacity = snapshot.model?.capacity;
    const estimated = snapshot.headline?.estimated === true;
    const headline = snapshot.headline === undefined
        ? "No completed model request yet"
        : `${formatTokens(snapshot.headline.tokens)} / ${capacity === undefined
            ? "?"
            : formatTokens(capacity)}  ·  ${capacity === undefined
            ? "estimated"
            : `${Math.round(snapshot.headline.tokens / capacity * 100)}%`
        }`;
    const innerWidth = Math.max(20, width - 2);
    const occupancy = used === undefined || capacity === undefined
        ? undefined
        : contextOccupancy(snapshot, used, capacity, innerWidth);
    const showBars = true;
    const usedTotal = used ?? 0;
    const breakdown = categories.map((category) => ({
        label: category.label,
        tokens: category.tokens,
        percent: usedTotal === 0
            ? 0
            : Math.round(category.tokens / usedTotal * 100),
        bar: showBars
            ? shareBar(category.tokens, usedTotal, 36)
            : "",
        components: category.components,
    }));
    const instructionComponents = categories.find((category) =>
        category.label === "Instructions"
    )?.components ?? [];
    const instructionFiles = instructionRows(instructionComponents, usedTotal, showBars);
    const instructionTokens = instructionComponents.reduce(
        (sum, component) => sum + component.estimatedTokens,
        0,
    );
    const warnings = [
        ...fileWarnings(instructionFiles),
        ...messageWarnings(
            snapshot.projection?.components ?? [],
            usedTotal,
        ),
    ];
    return {
        snapshot,
        headline,
        estimated,
        occupancy,
        breakdown,
        instructions: instructionFiles,
        ...(instructionFiles.length === 0
            ? {}
            : {
                instructionSummary:
                    `${instructionFiles.length} file${instructionFiles.length === 1 ? "" : "s"}`
                    + ` · ${formatTokens(instructionTokens)}`
                    + (usedTotal === 0
                        ? ""
                        : ` · ${Math.round(instructionTokens / usedTotal * 100)}% of used`),
            }),
        fileWarnings: warnings,
        detail: detail
            ? [...(snapshot.projection?.components ?? [])]
                .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
            : [],
        ...(snapshot.headline !== undefined && snapshot.projection === undefined
            ? { breakdownMissing: "No category split in this snapshot." }
            : snapshot.headline === undefined
                ? { breakdownMissing: "Available after the first model request." }
                : {}),
    };
}

export function contextReportLines(
    report: ContextReport,
    width: number,
    detail: boolean,
): readonly string[] {
    const inner = Math.max(20, width - 2);
    const lines: string[] = [
        ...inspectReportSection("Context usage", report.headline, width),
    ];
    if (report.occupancy !== undefined) {
        lines.push(report.occupancy.bar, report.occupancy.bar);
        lines.push(`${" ".repeat(report.occupancy.tickColumn)}╵`);
        const compactLabel = `auto-compacts at ${formatTokens(report.occupancy.triggerTokens)}`;
        const labelColumn = Math.max(
            0,
            Math.min(
                inner - compactLabel.length,
                report.occupancy.tickColumn + 1 - compactLabel.length,
            ),
        );
        lines.push(`${" ".repeat(labelColumn)}${compactLabel}`);
        lines.push("");
        lines.push(...occupancyLegend(report, inner));
        lines.push("");
    }

    const breakdownValue = report.snapshot.headline === undefined
        ? undefined
        : `share of ${formatTokens(report.snapshot.headline.tokens)} used`;
    lines.push(...inspectReportSection("Breakdown", breakdownValue, width));
    if (report.breakdownMissing !== undefined) {
        lines.push(report.breakdownMissing);
    } else {
        for (const row of formatBreakdownTable(
            report.breakdown,
            detail,
            inner,
            report.snapshot.headline?.tokens ?? 0,
        )) {
            lines.push(row);
        }
    }
    lines.push("");

    if (report.instructions.length > 0) {
        lines.push(
            ...inspectReportSection(
                "Instructions",
                report.instructionSummary ?? "",
                width,
            ),
        );
        for (const row of formatInstructionTable(
            report.instructions,
            inner,
            report.snapshot.headline?.tokens ?? 0,
        )) {
            lines.push(row);
        }
        lines.push("");
    }
    for (const warning of report.fileWarnings) {
        lines.push(clip(`> !  ${warning}`, inner));
    }
    if (report.fileWarnings.length > 0) {
        lines.push("");
    }

    lines.push(clip(
        `/context ${detail ? "to collapse" : "[all] to expand"}`,
        inner,
    ));
    return lines;
}

export function formatTokens(tokens: number): string {
    if (tokens < 1_000) return String(tokens);
    if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
    if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
    return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatKilobytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

function contextOccupancy(
    snapshot: VeraClientContextSnapshot,
    used: number,
    capacity: number,
    width: number,
): ContextOccupancy {
    const trigger = contextCompactionTrigger(snapshot) ?? capacity;
    const usedCells = clamp(
        Math.round(used / capacity * width),
        0,
        width,
    );
    const triggerCells = clamp(
        Math.round(trigger / capacity * width),
        0,
        width,
    );
    const chars: string[] = [];
    for (let index = 0; index < width; index++) {
        if (index < usedCells) chars.push("█");
        else if (index < triggerCells) chars.push("░");
        else chars.push("▒");
    }
    return {
        usedTokens: used,
        freeTokens: Math.max(0, trigger - used),
        reserveTokens: Math.max(0, capacity - Math.max(trigger, used)),
        triggerTokens: trigger,
        bar: chars.join(""),
        tickColumn: clamp(triggerCells, 0, Math.max(0, width - 1)),
    };
}

function occupancyLegend(report: ContextReport, width: number): readonly string[] {
    const occupancy = report.occupancy!;
    const items = [
        `█ used ${formatTokens(occupancy.usedTokens)}`,
        `░ free ${formatTokens(occupancy.freeTokens)}`,
        `▒ reserve ${formatTokens(occupancy.reserveTokens)}`,
    ];
    if (report.estimated) items.push("estimated");
    const compact = items.join("  ");
    if (compact.length <= width) return [compact];
    const counts = items.filter((item) => item !== "estimated").join("  ");
    if (report.estimated && counts.length <= width) {
        return [counts, "estimated"];
    }
    return items;
}

function instructionRows(
    components: readonly VeraClientContextComponent[],
    usedTotal: number,
    showBars: boolean,
): readonly ContextInstructionRow[] {
    const files: ContextInstructionRow[] = [];
    for (const component of components) {
        if (component.parts !== undefined && component.parts.length > 0) {
            for (const part of component.parts) {
                files.push(rowFromPart(part, usedTotal, showBars));
            }
            continue;
        }
        files.push({
            scope: scopeFromComponent(component),
            displayName: component.displayName,
            bytes: 0,
            estimatedTokens: component.estimatedTokens,
            imported: false,
            bar: showBars
                ? shareBar(component.estimatedTokens, usedTotal, 12)
                : "",
        });
    }
    return files;
}

function rowFromPart(
    part: VeraClientContextPart,
    usedTotal: number,
    showBars: boolean,
): ContextInstructionRow {
    return {
        scope: part.scope,
        displayName: part.displayName,
        bytes: part.bytes,
        estimatedTokens: part.estimatedTokens,
        imported: part.imported === true,
        bar: showBars ? shareBar(part.estimatedTokens, usedTotal, 12) : "",
    };
}

function fileWarnings(files: readonly ContextInstructionRow[]): readonly string[] {
    return files
        .filter((file) =>
            !file.imported
            && (file.scope === "project" || file.scope === "user")
            && file.bytes >= RIDES_EVERY_TURN_BYTES
        )
        .map((file) =>
            `${file.displayName} is ${formatKilobytes(file.bytes)} and rides every turn.`
        );
}

const LARGE_MESSAGE_TOKENS = RIDES_EVERY_TURN_BYTES / 4;

function messageWarnings(
    components: readonly VeraClientContextComponent[],
    usedTotal: number,
): readonly string[] {
    return components
        .filter((component) =>
            component.kind === "message"
            && component.estimatedTokens >= LARGE_MESSAGE_TOKENS
        )
        .sort((left, right) => right.estimatedTokens - left.estimatedTokens)
        .map((component) => {
            const share = usedTotal === 0
                ? ""
                : ` (${Math.round(component.estimatedTokens / usedTotal * 100)}% of used)`;
            return `${component.displayName} is ${
                formatTokens(component.estimatedTokens)
            }${share}.`;
        });
}

function formatBreakdownTable(
    rows: readonly ContextBreakdownRow[],
    detail: boolean,
    width: number,
    usedTotal: number,
): readonly string[] {
    if (rows.length === 0) return [];
    const entries: {
        readonly label: string;
        readonly tokens: number;
        readonly percent: string;
        readonly share: number;
    }[] = [];
    for (const row of rows) {
        entries.push({
            label: row.label,
            tokens: row.tokens,
            percent: `${String(row.percent).padStart(3)}%`,
            share: row.tokens,
        });
        if (!detail) continue;
        for (const component of row.components) {
            if (component.parts !== undefined && component.parts.length > 0) {
                continue;
            }
            entries.push({
                label: `  ${component.displayName}`,
                tokens: component.estimatedTokens,
                percent: "",
                share: component.estimatedTokens,
            });
        }
    }
    const tokenWidth = Math.max(
        ...entries.map((entry) => formatTokens(entry.tokens).length),
        4,
    );
    const percentWidth = 4;
    const gap = 3;
    const minBar = 8;
    const reserved = tokenWidth + 2 + gap + percentWidth + gap + minBar;
    const rawLabelWidth = Math.max(
        ...entries.map((entry) => entry.label.length),
        12,
    );
    const labelWidth = Math.min(
        rawLabelWidth,
        Math.max(12, width - reserved),
    );
    const prefixes = entries.map((entry) =>
        `${clip(entry.label, labelWidth).padEnd(labelWidth)}  ${
            formatTokens(entry.tokens).padStart(tokenWidth)
        }   ${entry.percent.padStart(percentWidth)}`
    );
    const prefixWidth = prefixes[0]?.length ?? 0;
    const barWidth = width - prefixWidth - gap;
    if (barWidth < minBar || usedTotal <= 0) {
        return prefixes.map((prefix) => clip(prefix, width));
    }
    return prefixes.map((prefix, index) =>
        `${prefix}${" ".repeat(gap)}${shareBar(
            entries[index]!.share,
            usedTotal,
            barWidth,
        )}`
    );
}

function formatInstructionTable(
    rows: readonly ContextInstructionRow[],
    width: number,
    usedTotal: number,
): readonly string[] {
    if (rows.length === 0) return [];
    const scopeWidth = 7;
    const rawNameWidth = Math.max(
        ...rows.map((row) =>
            (row.imported ? 2 : 0) + row.displayName.length
        ),
        12,
    );
    const sizeWidth = Math.max(
        ...rows.map((row) => formatKilobytes(row.bytes).length),
        4,
    );
    const tokenWidth = Math.max(
        ...rows.map((row) => formatTokens(row.estimatedTokens).length),
        3,
    );
    const gap = 3;
    const minBar = 8;
    const reserved = scopeWidth + 2 + sizeWidth + 2 + tokenWidth + gap + minBar;
    const nameWidth = Math.min(rawNameWidth, Math.max(12, width - reserved));
    const prefixes = rows.map((row) => {
        const name = clip(
            `${row.imported ? "  " : ""}${row.displayName}`,
            nameWidth,
        ).padEnd(nameWidth);
        return `${row.scope.padEnd(scopeWidth)}  ${name}  ${
            formatKilobytes(row.bytes).padStart(sizeWidth)
        }  ${formatTokens(row.estimatedTokens).padStart(tokenWidth)}`;
    });
    const prefixWidth = prefixes[0]?.length ?? 0;
    const barWidth = width - prefixWidth - gap;
    if (barWidth < minBar || usedTotal <= 0) {
        return prefixes.map((prefix) => clip(prefix, width));
    }
    return prefixes.map((prefix, index) =>
        `${prefix}${" ".repeat(gap)}${shareBar(
            rows[index]!.estimatedTokens,
            usedTotal,
            barWidth,
        )}`
    );
}

function shareBar(tokens: number, total: number, width: number): string {
    if (total <= 0 || width <= 0) return "";
    const filled = clamp(Math.round(tokens / total * width), 0, width);
    if (filled === 0 && tokens > 0) return "▏";
    return "█".repeat(filled);
}

function clip(text: string, width: number): string {
    return text.length <= width ? text : text.slice(0, width);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function contextReportMarkdown(
    snapshot: VeraClientContextSnapshot,
    detail: boolean,
    width: number,
): string {
    const report = buildContextReport(snapshot, detail, width);
    return contextReportLines(report, width, detail).join("\n");
}

function categoryLabel(component: VeraClientContextComponent): string {
    if (component.kind === "message") return "Messages";
    if (INSTRUCTION_IDS.has(component.id)) return "Instructions";
    if (component.kind === "tool_schema") {
        return component.owner === "core" || component.owner === "engine"
            ? "System tools"
            : "Extension tools";
    }
    if (component.id === "core.subagents") return "System prompt";
    if (component.id.includes("skill")) return "Instructions";
    return "System prompt";
}

function scopeFromComponent(component: VeraClientContextComponent): string {
    if (component.id === "core.agent-instructions") return "agent";
    if (component.id === "core.memory") return "memory";
    if (component.id.includes("skill") || component.id === "host.skills") {
        return "skill";
    }
    return "project";
}

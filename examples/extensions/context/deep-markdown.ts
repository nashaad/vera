import {
    formatKilobytes,
    formatTokens,
} from "./context-report.ts";
import type { ContextDeepReport } from "./deep.ts";
import type { ReadyJudge } from "./deep-judge.ts";
import type { DeepPileFile } from "./deep-pile.ts";

const RIDES_EVERY_TURN_BYTES = 16 * 1024;

export function contextDeepMarkdown(
    report: ContextDeepReport,
    columns: number,
): string {
    return contextDeepLines(report, columns).join("\n");
}

export function contextDeepLines(
    report: ContextDeepReport,
    columns: number,
): string[] {
    const width = Math.max(24, Math.min(72, columns));
    const rule = "─".repeat(width);
    const lines: string[] = [];
    const judge = report.judge;

    if (judge.status === "ready") {
        lines.push(...pressureSection(judge, width), rule, "");
        lines.push(...sdeSection(judge, width), rule, "");
        lines.push(...standingRulesSection(judge, width), "");
    } else if (judge.status === "unmeasured") {
        lines.push("## PRESSURE");
        lines.push(rule);
        lines.push("");
        lines.push(`Standing rules unmeasured. ${judge.reason}`);
        lines.push("");
        lines.push("## SDE");
        lines.push(rule);
        lines.push("");
        lines.push("SDE unmeasured.");
        lines.push("");
    } else {
        lines.push("## PRESSURE");
        lines.push(rule);
        lines.push("");
        lines.push(`Standing rules failed. ${judge.reason}`);
        lines.push("");
        lines.push("## SDE");
        lines.push(rule);
        lines.push("");
        lines.push("SDE failed.");
        lines.push("");
    }

    lines.push(...pileSection(report, width), "");
    lines.push(
        `${report.pile.modalVerbs} must/never/always   `
            + `${report.pile.listItems} list items   `
            + `~${formatTokens(report.pile.tokensEst)}`,
    );
    lines.push("");
    lines.push(clip("Dropped-rule after unrelated work: unmeasured.", width));
    lines.push("");
    lines.push(clip("/context shows how full the window is.", width));
    lines.push(clip("This page lists the instruction files.", width));
    return lines;
}

function pressureSection(judge: ReadyJudge, width: number): string[] {
    const leftover = leftoverShare(judge);
    const leftoverPct = Math.round(leftover * 100);
    const heading = padHeading(
        "## PRESSURE",
        `${judge.independentFamilies} rules  ·  leftover ${leftoverPct}%`,
        width,
    );
    return [
        ...heading,
        meterBar(1 - leftover, width),
        "█ standing rules    ░ leftover text (not a rule)",
        "",
    ];
}

function sdeSection(judge: ReadyJudge, width: number): string[] {
    const heading = padHeading(
        "## SDE",
        `${judge.SDE.toFixed(2)}  ·  ${judge.sdeBand}`,
        width,
    );
    return [
        ...heading,
        sdeMeter(judge.SDE, width),
        sdeTicks(width),
        "         0.40           0.65      0.80",
        "         standard       dense     ultra",
        "",
        "(S/W)×(1−R)×C",
        `S  ${formatTokens(Math.round(judge.S))} unique substance`,
        `W  ${formatTokens(Math.round(judge.W))} this pile`,
        `R  ${judge.R.toFixed(2)} restated`,
        `C  ${judge.C.toFixed(2)} in conflict`,
        `${judge.distinctInstructions} distinct instructions · ${judge.independentFamilies} families`,
        "",
        "Higher SDE is more concentrated.",
        "",
    ];
}

function standingRulesSection(judge: ReadyJudge, width: number): string[] {
    const lines = [
        "## STANDING RULES",
        "─".repeat(width),
    ];
    if (judge.familyNames.length === 0) {
        lines.push("No standing rules in this pile.");
        return lines;
    }
    for (const name of judge.familyNames) {
        lines.push(clip(name, width));
    }
    lines.push("");
    lines.push("R is restatement across the pile. C is a fight between rules.");
    return lines;
}

function pileSection(report: ContextDeepReport, width: number): string[] {
    const pile = report.pile;
    const heading = padHeading(
        "## THIS PILE",
        `${pile.files.length} files  ·  ${formatKilobytes(pile.bytes)}  ·  ~${formatTokens(pile.tokensEst)}`,
        width,
    );
    const lines = [...heading, ""];
    for (const file of pile.files) {
        lines.push(clip(fileRow(file, width), width));
    }
    for (const warning of pile.warnings) {
        lines.push(clip(`> ${warning}`, width));
    }
    for (const file of pile.files) {
        if (file.bytes >= RIDES_EVERY_TURN_BYTES) {
            lines.push(clip(
                `> !  ${file.name} is ${formatKilobytes(file.bytes)} and rides every turn.`,
                width,
            ));
        }
    }
    return lines;
}

function fileRow(
    file: DeepPileFile,
    width: number,
): string {
    const meta = [
        formatKilobytes(file.bytes).padStart(7),
        `${file.lines} lines`.padStart(11),
        `~${formatTokens(file.tokensEst)}`.padStart(6),
    ].join("  ");
    const nameWidth = Math.max(8, width - meta.length - 2);
    const name = clip(file.name, nameWidth).padEnd(nameWidth);
    return `${name}  ${meta}`;
}

function leftoverShare(judge: ReadyJudge): number {
    if (judge.W <= 0) {
        return 0;
    }
    return clamp01(1 - (judge.S / judge.W));
}

function meterBar(filled: number, width: number): string {
    const n = Math.max(8, width);
    const filledCells = Math.round(clamp01(filled) * n);
    return `${"█".repeat(filledCells)}${"░".repeat(n - filledCells)}`;
}

function sdeMeter(value: number, width: number): string {
    return meterBar(clamp01(value), width);
}

function sdeTicks(width: number): string {
    const n = Math.max(8, width);
    const marks = [0.40, 0.65, 0.80].map((tick) =>
        Math.min(n - 1, Math.round(tick * (n - 1)))
    );
    const chars = Array.from({ length: n }, () => " ");
    for (const column of marks) {
        chars[column] = "╵";
    }
    return chars.join("");
}

function padHeading(
    left: string,
    right: string,
    width: number,
): string[] {
    const gap = 2;
    if (left.length + gap + right.length > width) {
        return [left, right];
    }
    return [`${left}${" ".repeat(width - left.length - right.length)}${right}`];
}

function clip(text: string, width: number): string {
    if (text.length <= width) {
        return text;
    }
    if (width <= 1) {
        return text.slice(0, width);
    }
    return `${text.slice(0, width - 1)}…`;
}

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

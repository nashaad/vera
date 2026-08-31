/**
 * Build the shared heading and rule used by inspect-report sections.
 *
 * `width` is the report width supplied by the inspect dialog. The section's
 * inner measure leaves the same two-column breathing room at every width.
 */
export function inspectReportSection(
    heading: string,
    value: string | undefined,
    width: number,
): readonly string[] {
    const innerWidth = Math.max(1, Math.floor(width) - 2);
    const label = clip(`## ${heading.toUpperCase()}`, innerWidth);
    const rule = "─".repeat(innerWidth);
    if (value === undefined || value.length === 0) {
        return [label, rule, ""];
    }
    const clippedValue = clip(value, innerWidth);
    if (label.length + 1 + value.length > innerWidth) {
        return [label, clippedValue, rule, ""];
    }
    return [
        `${label}${" ".repeat(innerWidth - label.length - value.length)}${value}`,
        rule,
        "",
    ];
}

function clip(text: string, width: number): string {
    return text.length <= width ? text : text.slice(0, width);
}

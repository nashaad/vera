/** Focus movement between the sections of one screen. */

export type SectionArrow = "up" | "down" | "left" | "right";

export function sectionArrow(name: string): SectionArrow | undefined {
    return name === "up" || name === "down" || name === "left" || name === "right" ? name : undefined;
}

/** Down, Right, and Tab move forward; Up, Left, and Shift+Tab move back. Both wrap. */
export function arrowMovesForward(arrow: SectionArrow): boolean {
    return arrow === "down" || arrow === "right";
}

/** One section has nowhere to go, so it returns the focus unchanged. */
export function steppedSection<T>(sections: readonly T[], focus: T, forward: boolean): T {
    if (sections.length === 0) return focus;
    const at = Math.max(0, sections.indexOf(focus));
    return sections[(at + (forward ? 1 : -1) + sections.length) % sections.length]!;
}

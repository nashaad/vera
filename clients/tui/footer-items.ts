import type { FooterItemContents } from "./footer-fit.ts";
import type { TuiStatusChunk, TuiStatusTone } from "./status.ts";
import { tuiWorkspaceForms } from "./status.ts";

export interface FooterItemFacts {
    readonly status?: { readonly text: string; readonly color: string };
    readonly keys: string;
    readonly limits: readonly string[];
    // Undefined when an extension's status line owns the place.
    readonly place?: { readonly workspace: string; readonly branch: string | undefined };
    readonly activity: readonly TuiStatusChunk[];
    // Width the activity strip takes while a turn runs, held while idle too.
    readonly activityColumns: number;
    readonly panes: readonly string[];
}

export function footerItemContents(facts: FooterItemFacts): FooterItemContents {
    const contents: FooterItemContents = {
        status: {
            forms: facts.status === undefined || facts.status.text.length === 0
                ? []
                : [[{ text: facts.status.text, tone: "muted", color: facts.status.color }]],
        },
        keys: { forms: dotForms(facts.keys, "muted") },
        limits: { forms: facts.limits.map((form) => [muted(form)]) },
        activity: {
            forms: facts.activity.length === 0 ? [] : [facts.activity],
            reserve: facts.activityColumns,
        },
        panes: { forms: dotForms(facts.panes.join(" · "), "muted") },
    };
    if (facts.place !== undefined) {
        contents.folder = {
            forms: tuiWorkspaceForms(facts.place.workspace).map((form) => [muted(form)]),
        };
        contents.branch = {
            forms: facts.place.branch === undefined ? [] : [[{ text: facts.place.branch, tone: "accent" }]],
        };
    }
    return contents;
}

// "a · b · c", then "a · b", then "a".
function dotForms(text: string, tone: TuiStatusTone): TuiStatusChunk[][] {
    if (text.length === 0) return [];
    const parts = text.split(" · ");
    const forms: TuiStatusChunk[][] = [];
    for (let end = parts.length; end >= 1; end -= 1) {
        forms.push([{ text: parts.slice(0, end).join(" · "), tone }]);
    }
    return forms;
}

function muted(text: string): TuiStatusChunk {
    return { text, tone: "muted" };
}

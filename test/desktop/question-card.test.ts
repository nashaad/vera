import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QuestionCard } from "../../clients/ui/src/session/QuestionCard.tsx";
import type { QuestionRequest } from "../../clients/ui/src/session/requests.ts";

const question: QuestionRequest = {
    kind: "question",
    requestId: "q1",
    question: "Which folder should the notes go in?",
    choices: [
        { id: "notes", label: "Notes", recommended: true },
        { id: "desk", label: "Desktop", description: "Easy to find later.", recommended: false },
    ],
    allowCustom: true,
    allowNotes: false,
    outOfBand: false,
};

function render(request: QuestionRequest, answered = false): string {
    return renderToStaticMarkup(createElement(QuestionCard, {
        request,
        answered,
        notes: "",
        onNotes: () => undefined,
        onRespond: () => undefined,
    }));
}

describe("the question card", () => {
    test("shares the choice card: numbered rows, a typed answer, and a close button that skips", () => {
        const html = render(question);
        expect(html).toContain("choice-card");
        expect(html).toContain("data-kind=\"question\"");
        const rows = [...html.matchAll(/<kbd class="kbd">(\d)<\/kbd><span class="request-choice-label">([^<]*)</g)].map((match) => [match[1], match[2]]);
        expect(rows).toEqual([["1", "Notes"], ["2", "Desktop"]]);
        expect(html).toContain(">Recommended<");
        expect(html).toContain("Easy to find later.");
        expect(html).toContain("placeholder=\"Something else\"");
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Answer</);
        expect(html).toMatch(/<button[^>]*aria-label="Skip"[^>]*title="Skip \(Esc\)"/);
        expect(html).not.toContain("request-actions");
    });

    test("a question without a typed answer or note shows only its rows", () => {
        const html = render({ ...question, allowCustom: false });
        expect(html).not.toContain("request-custom");
        expect(html).not.toContain("request-textarea");
    });

    test("a note box and the out-of-band line sit under the rows", () => {
        const html = render({ ...question, allowNotes: true, outOfBand: true });
        expect(html).toContain("Add a note (optional)");
        expect(html).toContain("Vera keeps working while this waits.");
    });

    test("an answered question keeps its rows, disabled, until the host closes it", () => {
        const html = render(question, true);
        expect(html).toContain("data-answered=\"true\"");
        expect(count(html, "class=\"request-choice\"")).toBe(2);
        expect(count(html, "<button type=\"button\" class=\"request-choice\" data-choice=")).toBe(2);
        expect(html).toMatch(/class="request-choice" data-choice="notes" disabled=""/);
        expect(html).toMatch(/<input[^>]*disabled=""/);
    });
});

function count(text: string, part: string): number {
    return text.split(part).length - 1;
}

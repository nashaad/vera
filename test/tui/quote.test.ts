import { expect, test } from "bun:test";

import {
    quotedBlock,
    renderTuiQuote,
    tuiQuoteMarker,
    withQuote,
} from "../../clients/tui/quote.ts";

test("no quote is an empty line", () => {
    expect(renderTuiQuote(undefined)).toEqual({ facts: "", keys: "" });
});

test("the mark blinks without the line changing width", () => {
    expect(tuiQuoteMarker(0)).toBe("*");
    expect(tuiQuoteMarker(700)).toBe(" ");
    expect(tuiQuoteMarker(1300)).toBe("*");
    expect(tuiQuoteMarker(700)).toHaveLength(tuiQuoteMarker(0).length);
});

test("the line names the speaker, the size, and the way out", () => {
    expect(renderTuiQuote({ source: "frosty", text: "abcd" })).toEqual({
        facts: "quoting frosty · 4 characters · copied",
        keys: "⏎ sends it · @name aims it · esc clears it",
    });
});

test("one character is not pluralised", () => {
    expect(renderTuiQuote({ source: "agent", text: "x" }).facts)
        .toBe(
            "quoting agent · 1 character · copied",
        );
});

test("the block attributes the text and marks every line", () => {
    expect(quotedBlock({ source: "frosty", text: "one\ntwo" }))
        .toBe("frosty said:\n> one\n> two");
});

test("a blank line inside a quote keeps its marker", () => {
    expect(quotedBlock({ source: "frosty", text: "one\n\ntwo" }))
        .toBe("frosty said:\n> one\n>\n> two");
});

test("the quote follows the typed message, so an address stays in front", () => {
    expect(withQuote("@frosty cross check pls", {
        source: "agent",
        text: "the cap is 5s",
    })).toBe("@frosty cross check pls\n\nagent said:\n> the cap is 5s");
});

test("a quote with nothing typed is the whole message", () => {
    expect(withQuote("", { source: "frosty", text: "look here" }))
        .toBe("frosty said:\n> look here");
});

test("no quote leaves the typed message alone", () => {
    expect(withQuote("hello", undefined)).toBe("hello");
});

test("a quote of only whitespace is not carried", () => {
    expect(withQuote("hello", { source: "frosty", text: "  \n " }))
        .toBe("hello");
});

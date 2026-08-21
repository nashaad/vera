import { expect, test } from "bun:test";

import {
    displayOffsetWidth,
    imageChipMarker,
    renumberImageChips,
    stringIndexAtDisplayOffset,
    stripImageChips,
} from "../../clients/tui/image-chips.ts";

function chip(requestId: string, position: number) {
    return { requestId, marker: imageChipMarker(position) };
}

test("a newline is one offset and a wide character is two", () => {
    expect(displayOffsetWidth("[Image 1]")).toBe(9);
    expect(displayOffsetWidth("a\nb")).toBe(3);
    expect(displayOffsetWidth("漢")).toBe(2);
});

test("display offsets map back across wide and multi-unit graphemes", () => {
    const text = "a漢👩‍💻[Image 1]";
    expect(stringIndexAtDisplayOffset(text, 1)).toBe(1);
    expect(stringIndexAtDisplayOffset(text, 3)).toBe(2);
    expect(stringIndexAtDisplayOffset(
        text,
        displayOffsetWidth("a漢👩‍💻"),
    )).toBe("a漢👩‍💻".length);
});

test("surviving chips are renumbered from one in document order", () => {
    const renumbered = renumberImageChips(
        "[Image 2] and [Image 3] left",
        [chip("b", 2), chip("c", 3)],
    );
    expect(renumbered.text).toBe("[Image 1] and [Image 2] left");
    expect(renumbered.chips).toEqual([
        { requestId: "b", marker: "[Image 1]", start: 0, end: 9 },
        { requestId: "c", marker: "[Image 2]", start: 14, end: 23 },
    ]);
});

test("chip offsets count a preceding wide character as two columns", () => {
    const renumbered = renumberImageChips("漢[Image 1]", [chip("a", 1)]);
    expect(renumbered.chips[0]).toEqual({
        requestId: "a",
        marker: "[Image 1]",
        start: 2,
        end: 11,
    });
});

test("a chip whose marker is no longer in the text is dropped", () => {
    // The user selected across the chip and typed over it, so nothing is left
    // to renumber and the chips that follow still close up.
    const renumbered = renumberImageChips(
        "gone [Image 2]",
        [chip("a", 1), chip("b", 2)],
    );
    expect(renumbered.text).toBe("gone [Image 1]");
    expect(renumbered.chips.map((each) => each.requestId)).toEqual(["b"]);
});

test("submitting strips the chips and the space each one owns", () => {
    expect(
        stripImageChips(
            "[Image 1] [Image 2] compare these",
            [chip("a", 1), chip("b", 2)],
        ),
    ).toBe("compare these");
});

test("a prompt with no chips is unchanged apart from trimming", () => {
    expect(stripImageChips("look at this", [])).toBe("look at this");
});

test("text either side of a chip stays joined by its own spacing", () => {
    expect(
        stripImageChips("before [Image 1] after", [chip("a", 1)]),
    ).toBe("before after");
});

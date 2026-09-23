import { expect, test } from "bun:test";

import {
    EMPTY_TURN_METER,
    meterStreamedText,
    meterThought,
    turnMeterSegments,
} from "../../clients/tui/turn-meter.ts";

test("a fresh turn shows no meter until text streams", () => {
    expect(turnMeterSegments(EMPTY_TURN_METER, 1_000, 0)).toEqual([]);
});

test("streamed text is estimated at four characters a token", () => {
    const small = meterStreamedText(EMPTY_TURN_METER, 1_000, "a".repeat(1_360));
    expect(turnMeterSegments(small, 1_000, 0)).toEqual(["↓ ~340 tokens"]);
    const large = meterStreamedText(small, 1_000, "a".repeat(64_240));
    expect(turnMeterSegments(large, 1_000, 0)).toEqual(["↓ ~16.4k tokens"]);
});

test("finished and live thinking add up to whole seconds", () => {
    const thought = meterThought(EMPTY_TURN_METER, 1_000, 2_600);
    expect(turnMeterSegments(thought, 1_000, 0)).toEqual(["thought 2s"]);
    expect(turnMeterSegments(thought, 1_000, 1_500)).toEqual(["thought 4s"]);
});

test("a meter from an earlier turn counts as empty", () => {
    const earlier = meterThought(meterStreamedText(EMPTY_TURN_METER, 1_000, "ahoy matey"), 1_000, 5_000);
    expect(turnMeterSegments(earlier, 9_000, 0)).toEqual([]);
    expect(turnMeterSegments(meterStreamedText(earlier, 9_000, "aaaa"), 9_000, 0))
        .toEqual(["↓ ~1 token"]);
});

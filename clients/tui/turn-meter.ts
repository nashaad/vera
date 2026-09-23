// The host reports usage only when a turn ends, so the live count is an estimate.
const CHARACTERS_PER_TOKEN = 4;

export interface TuiTurnMeter {
    readonly turnStartedAt: number | undefined;
    readonly streamedCharacters: number;
    readonly thoughtMs: number;
}

export const EMPTY_TURN_METER: TuiTurnMeter = {
    turnStartedAt: undefined,
    streamedCharacters: 0,
    thoughtMs: 0,
};

// A meter left over from an earlier turn counts as empty.
function meterForTurn(meter: TuiTurnMeter, turnStartedAt: number | undefined): TuiTurnMeter {
    return meter.turnStartedAt === turnStartedAt
        ? meter
        : { ...EMPTY_TURN_METER, turnStartedAt };
}

export function meterStreamedText(
    meter: TuiTurnMeter,
    turnStartedAt: number | undefined,
    text: string,
): TuiTurnMeter {
    const current = meterForTurn(meter, turnStartedAt);
    return { ...current, streamedCharacters: current.streamedCharacters + text.length };
}

export function meterThought(
    meter: TuiTurnMeter,
    turnStartedAt: number | undefined,
    ms: number,
): TuiTurnMeter {
    const current = meterForTurn(meter, turnStartedAt);
    return { ...current, thoughtMs: current.thoughtMs + Math.max(0, ms) };
}

export function turnMeterSegments(
    meter: TuiTurnMeter,
    turnStartedAt: number | undefined,
    liveThoughtMs: number,
): string[] {
    const current = meterForTurn(meter, turnStartedAt);
    const segments: string[] = [];
    const tokens = Math.round(current.streamedCharacters / CHARACTERS_PER_TOKEN);
    if (tokens > 0) segments.push(`↓ ~${formatTokenCount(tokens)} ${tokens === 1 ? "token" : "tokens"}`);
    const thoughtSeconds = Math.floor((current.thoughtMs + Math.max(0, liveThoughtMs)) / 1_000);
    if (thoughtSeconds > 0) segments.push(`thought ${thoughtSeconds}s`);
    return segments;
}

function formatTokenCount(tokens: number): string {
    return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(1)}k`;
}

import { serializeError } from "../flight-recorder.ts";
import { appendTuiError } from "../state.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

export type TuiInputSource = "keypress" | "paste" | "submit" | "image_paste" | "image_chip_removed";

const SOURCE_LABELS: Record<TuiInputSource, string> = {
    keypress: "Key",
    paste: "Paste",
    submit: "Submit",
    image_paste: "Image paste",
    image_chip_removed: "Image removal",
};

// OpenTUI catches a throwing input handler and logs it to a console the TUI never shows.
export function guardInput<Args extends readonly unknown[]>(
    rt: TuiRuntime,
    source: TuiInputSource,
    handler: (...args: Args) => void,
): (...args: Args) => void {
    return (...args: Args): void => {
        try {
            handler(...args);
        } catch (error) {
            reportInputFailure(rt, source, error);
        }
    };
}

export function reportInputFailure(rt: TuiRuntime, source: TuiInputSource, error: unknown): void {
    const serialized = serializeError(error);
    rt.flightRecorder?.record({ type: "input_handler_failed", source, error: serialized });
    try {
        rt.state = appendTuiError(rt.state, `${SOURCE_LABELS[source]} failed: ${serialized.message}`);
        renderState(rt);
    } catch (reportError) {
        rt.flightRecorder?.record({ type: "input_failure_unreported", source, error: serializeError(reportError) });
    }
}

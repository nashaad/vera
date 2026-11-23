import { writeFileSync } from "node:fs";
import { ModelEventStream } from "../../../src/model/stream.ts";

export default function createAdapter(options: { marker: string }): Promise<never> {
    writeFileSync(options.marker, "pending");
    return new Promise(() => {});
}

export function createStreamingAdapter(options: { marker: string }): object {
    return {
        stream() {
            writeFileSync(options.marker, "streaming");
            const stream = new ModelEventStream();
            stream.push({ type: "start" });
            return stream;
        },
    };
}

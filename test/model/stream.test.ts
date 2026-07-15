import { expect, test } from "bun:test";

import { ModelEventStream } from "../../src/model/stream.ts";

test("model streams reject a second consumer", () => {
    const stream = new ModelEventStream();

    stream[Symbol.asyncIterator]();

    expect(() => stream[Symbol.asyncIterator]()).toThrow(
        "Model streams can only be consumed once",
    );
});

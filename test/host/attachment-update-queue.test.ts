import { expect, test } from "bun:test";

import {
    AttachmentQueueOverflowError,
    AttachmentUpdateQueue,
    CLIENT_ATTACHMENT_QUEUE_LIMITS,
} from "../../src/host/attachment-update-queue.ts";

test("@core client queues reject updates above the count and byte limits", async () => {
    expect(CLIENT_ATTACHMENT_QUEUE_LIMITS).toEqual({ maxBytes: 16 * 1024 * 1024, maxUpdates: 32_768 });
    const countQueue = new AttachmentUpdateQueue(CLIENT_ATTACHMENT_QUEUE_LIMITS);
    for (let index = 0; index < 32_769; index += 1) {
        countQueue.push({ type: "assistant_delta", text: "x", seq: index });
    }
    await expect(countQueue.receive()).rejects.toBeInstanceOf(AttachmentQueueOverflowError);

    const byteQueue = new AttachmentUpdateQueue(CLIENT_ATTACHMENT_QUEUE_LIMITS);
    byteQueue.push({ type: "assistant_delta", text: "x".repeat(16 * 1024 * 1024), seq: 1 });
    await expect(byteQueue.receive()).rejects.toBeInstanceOf(AttachmentQueueOverflowError);
});

test("a queue that holds more than its byte limit fails with an overflow error", async () => {
    const queue = new AttachmentUpdateQueue({ maxBytes: 200 });
    queue.push({ type: "history", entries: [], seq: 0 }, { counted: false });
    for (let index = 1; index <= 10; index += 1) {
        queue.push({ type: "assistant_delta", text: "x".repeat(40), seq: index });
    }
    await expect(queue.receive()).rejects.toBeInstanceOf(AttachmentQueueOverflowError);
});

test("taken updates no longer count toward the limit", async () => {
    const queue = new AttachmentUpdateQueue({ maxUpdates: 2 });
    for (let index = 1; index <= 6; index += 1) {
        queue.push({ type: "assistant_delta", text: "x", seq: index });
        expect(await queue.receive()).toMatchObject({ seq: index });
    }
});

test("a queue without limits never overflows", async () => {
    const queue = new AttachmentUpdateQueue();
    for (let index = 1; index <= 1_000; index += 1) {
        queue.push({ type: "assistant_delta", text: "x".repeat(100), seq: index });
    }
    expect(await queue.receive()).toMatchObject({ seq: 1 });
});

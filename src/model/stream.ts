import type {
    AssistantMessage,
    ModelStream,
    ModelStreamEvent,
} from "./types.ts";

interface WaitingReader {
    readonly resolve: (result: IteratorResult<ModelStreamEvent>) => void;
}

export class ModelEventStream implements ModelStream {
    private readonly events: ModelStreamEvent[] = [];
    private readonly readers: WaitingReader[] = [];
    private ended = false;
    private iteratorCreated = false;
    private readonly resultPromise: Promise<AssistantMessage>;
    private resolveResult!: (message: AssistantMessage) => void;

    constructor() {
        this.resultPromise = new Promise((resolve) => {
            this.resolveResult = resolve;
        });
    }

    push(event: ModelStreamEvent): void {
        if (this.ended) {
            throw new Error("Cannot push to an ended model stream");
        }

        const reader = this.readers.shift();
        if (reader !== undefined) {
            reader.resolve({ value: event, done: false });
        } else {
            this.events.push(event);
        }

        if (event.type === "done" || event.type === "error") {
            this.ended = true;
            this.resolveResult(event.message);
            this.finishReaders();
        }
    }

    result(): Promise<AssistantMessage> {
        return this.resultPromise;
    }

    [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
        if (this.iteratorCreated) {
            throw new Error("Model streams can only be consumed once");
        }
        this.iteratorCreated = true;
        return {
            next: () => this.next(),
        };
    }

    private next(): Promise<IteratorResult<ModelStreamEvent>> {
        const event = this.events.shift();
        if (event !== undefined) {
            return Promise.resolve({ value: event, done: false });
        }

        if (this.ended) {
            return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise((resolve) => {
            this.readers.push({ resolve });
        });
    }

    private finishReaders(): void {
        for (const reader of this.readers.splice(0)) {
            reader.resolve({ value: undefined, done: true });
        }
    }
}

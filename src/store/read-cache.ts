import { statSync } from "node:fs";
import { resolve } from "node:path";

interface CacheEntry<T> {
    readonly inputs: readonly unknown[];
    readonly value: T;
}

export function createReadCache<T>(limit = 64): (
    key: string,
    inputs: readonly unknown[],
    read: () => T,
) => T {
    const entries = new Map<string, CacheEntry<T>>();
    return (key, inputs, read) => {
        const previous = entries.get(key);
        if (previous !== undefined && previous.inputs.length === inputs.length
            && inputs.every((input, index) => Object.is(input, previous.inputs[index]))) {
            return previous.value;
        }
        const value = read();
        entries.delete(key);
        if (entries.size >= limit) entries.delete(entries.keys().next().value!);
        entries.set(key, { inputs, value });
        return value;
    };
}

export function fileReadStamp(path: string): string | undefined {
    try {
        const stat = statSync(path, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
        return undefined;
    }
}

export function createFileReadCache<T>(read: (path: string) => T): (path: string) => T {
    const cached = createReadCache<T>();
    return (path) => {
        const absolute = resolve(path);
        const before = fileReadStamp(absolute);
        return cached(absolute, [before], () => read(absolute));
    };
}

import { watch, type FSWatcher } from "node:fs";

// An install writes a temporary folder and renames it, so changes come in bursts; `settled` runs once a burst is over.
export function watchSettled(directory: string, quietMs: number, settled: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: FSWatcher;
    try {
        watcher = watch(directory, () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = undefined;
                settled();
            }, quietMs);
        });
    } catch {
        return () => {};
    }
    watcher.on("error", () => watcher.close());
    return () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        watcher.close();
    };
}

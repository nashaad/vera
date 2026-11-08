import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function readPoolWorkerPids(home: string): Promise<number[]> {
    const directory = join(home, "runtime", "workers");
    const names = await readdir(directory);
    return await Promise.all(names.filter((name) => /^w\d+\.json$/.test(name)).map(async (name) => {
        const record = JSON.parse(await readFile(join(directory, name), "utf8")) as { pid: number };
        return record.pid;
    }));
}

import { lstat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";

export interface SocketFileIdentity {
    readonly dev: number;
    readonly ino: number;
}

export async function socketFileIdentity(path: string): Promise<SocketFileIdentity | undefined> {
    try {
        const stat = await lstat(path);
        return stat.isSocket() ? { dev: stat.dev, ino: stat.ino } : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export async function removeSocketFile(path: string, owned: SocketFileIdentity | undefined): Promise<void> {
    if (owned === undefined) return;
    const current = await socketFileIdentity(path);
    if (current?.dev !== owned.dev || current.ino !== owned.ino) return;
    try {
        await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export async function removeUnusedSocketFile(path: string, owned: SocketFileIdentity | undefined): Promise<void> {
    if (owned === undefined) return;
    const current = await socketFileIdentity(path);
    if (current?.dev !== owned.dev || current.ino !== owned.ino) return;
    const unused = await new Promise<boolean>((resolve) => {
        const connection = createConnection(path);
        const timer = setTimeout(() => finish(false), 250);
        const finish = (result: boolean): void => {
            clearTimeout(timer);
            connection.destroy();
            resolve(result);
        };
        connection.once("connect", () => finish(false));
        connection.once("error", (error: NodeJS.ErrnoException) => {
            finish(error.code === "ECONNREFUSED" || error.code === "ENOENT");
        });
    });
    if (unused) await removeSocketFile(path, owned);
}

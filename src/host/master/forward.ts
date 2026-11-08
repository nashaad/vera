import { createConnection, type Socket } from "node:net";

export function forwardSessionConnection(
    client: Socket,
    socketPath: string,
    firstLine: string,
): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const upstream = createConnection(socketPath);
        const timer = setTimeout(() => upstream.destroy(new Error("Worker connection timed out")), 5_000);
        let connected = false;
        const clientClosed = (): void => {
            upstream.destroy();
            if (!connected) fail(new Error("Client disconnected"));
        };
        client.once("close", clientClosed);
        client.once("end", clientClosed);
        upstream.once("error", fail);
        upstream.once("connect", () => {
            connected = true;
            clearTimeout(timer);
            upstream.off("error", fail);
            upstream.on("error", () => client.destroy());
            upstream.once("close", () => {
                client.removeListener("close", clientClosed);
                client.removeListener("end", clientClosed);
                if (!upstream.readableEnded) client.destroy();
            });
            upstream.pipe(client);
            upstream.write(`${firstLine}\n`);
            resolve(upstream);
        });
        function fail(error: Error): void {
            clearTimeout(timer);
            client.removeListener("close", clientClosed);
            client.removeListener("end", clientClosed);
            upstream.destroy();
            reject(error);
        }
    });
}

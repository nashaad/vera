import { requestHostIdentity } from "../../../src/host/protocol.ts";

const socket = process.argv[2]!;
const duration = Number(process.argv[3]);
const deadline = Date.now() + duration;
const samples: number[] = [];
let misses = 0;
while (Date.now() < deadline) {
    const start = performance.now();
    try {
        if (await requestHostIdentity(socket) === undefined) misses += 1;
        samples.push(performance.now() - start);
    } catch {
        misses += 1;
    }
    await Bun.sleep(20);
}
process.stdout.write(JSON.stringify({ samples, misses }));

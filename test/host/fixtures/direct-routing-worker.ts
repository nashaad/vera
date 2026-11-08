import { appendFileSync } from "node:fs";
import { createServer } from "node:net";

const [socketPath, workerId, generationText, buildId, logPath, redirectPath] = process.argv.slice(2);
if (socketPath === undefined || workerId === undefined || generationText === undefined
    || buildId === undefined || logPath === undefined) throw new Error("Missing worker argument");
const generation = Number(generationText);
const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
        input = input.slice(newline + 1);
        appendFileSync(logPath, `${JSON.stringify(request)}\n`);
        if (request.type === "host_identity") {
            socket.end(`${JSON.stringify({
                type: "host_identity", pid: process.pid, started_at: new Date().toISOString(),
                build_id: buildId, role: "worker", worker_id: workerId, worker_generation: generation,
            })}\n`);
            return;
        }
        if (request.type === "detach") {
            socket.end('{"type":"detached"}\n');
            return;
        }
        if (request.type !== "attach") return;
        if (redirectPath !== undefined) {
            socket.end(`${JSON.stringify({ type: "agent_location_changed", socket_path: redirectPath })}\n`);
            return;
        }
        const sequence = generation === 1 ? 5 : 2;
        if (typeof request.after_seq === "number" && request.after_seq > sequence) {
            socket.end(`${JSON.stringify({ type: "attach_failed", agent_id: request.agent_id, reason: "unavailable" })}\n`);
            return;
        }
        socket.write(`${JSON.stringify({
            type: "attached", agent_id: request.agent_id, workspace: "/work",
            capabilities: request.requested_capabilities ?? [],
            background_agents: { running: 0, children: [], has_parent: false },
        })}\n`);
        if (request.after_seq === undefined) {
            socket.write(`${JSON.stringify({ type: "history", entries: [], seq: sequence })}\n`);
        }
    });
});
server.listen(socketPath, () => process.stdout.write("ready\n"));

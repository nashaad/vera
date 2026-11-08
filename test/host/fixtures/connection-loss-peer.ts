import { createServer } from "node:net";
import { appendFileSync } from "node:fs";

interface PeerRequest {
    readonly type?: string;
}

const socketPath = process.argv[2];
if (socketPath === undefined) throw new Error("Socket path is required");
const identityLog = process.argv[3];

const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk: Buffer) => {
        input += chunk.toString("utf8");
        const newline = input.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(input.slice(0, newline)) as PeerRequest;
        input = input.slice(newline + 1);
        if (request.type === "host_identity") {
            if (identityLog !== undefined) appendFileSync(identityLog, "identity\n");
            socket.end(`${JSON.stringify({
                type: "host_identity",
                pid: process.pid,
                started_at: new Date().toISOString(),
                build_id: "vera-crow-1",
            })}\n`);
            return;
        }
        if (request.type === "attach") {
            socket.write(`${JSON.stringify({
                type: "attached",
                agent_id: "agent-1",
                workspace: "/work/one",
                capabilities: ["agent.attach-resume.v1"],
                background_agents: { running: 0, children: [], has_parent: false },
            })}\n`);
            socket.write(`${JSON.stringify({ type: "history", entries: [], seq: 0 })}\n`);
        }
    });
});

server.listen(socketPath);

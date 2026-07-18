import { findOrStartResidentHost } from "../../clients/host/launch.ts";
import { createAgentThroughHost } from "../../src/host/agent-start-client.ts";
import { attachAgent } from "../../src/host/attached-client.ts";

const host = await findOrStartResidentHost();
const agent = await createAgentThroughHost(host.socket_path, process.cwd());
const client = await attachAgent({
    socketPath: host.socket_path,
    agentId: agent.id,
});
const initial = await client.receive();
if (initial.type !== "history") {
    throw new Error("Detached host attachment did not begin with history");
}
await client.detach();

process.stdout.write(`${JSON.stringify({
    starterPid: process.pid,
    host,
    agentId: agent.id,
})}\n`);

const socketPath = process.env.PROVSIGN_FAUX_SOCKET;
if (!socketPath) throw new Error("A test socket is required.");
process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid, socket_path: socketPath, build_id: "test" })}\n`);

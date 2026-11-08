import { writeFile } from "node:fs/promises";

import { runScheduleCli } from "../../../clients/cli/schedule.ts";
import { runScheduleOperationThroughHost } from "../../../src/host/schedule-client.ts";

const [socket, address, pidPath] = process.argv.slice(2);
if (socket === undefined || address === undefined || pidPath === undefined) throw new Error("Missing schedule arguments");
await writeFile(pidPath, String(process.pid));
process.exitCode = await runScheduleCli(
    ["add", "from-worker", "--cron", "0 9 * * *", "--to", address, "--text", "Check the map."],
    (operation) => runScheduleOperationThroughHost(socket, operation),
    process.stdout,
);

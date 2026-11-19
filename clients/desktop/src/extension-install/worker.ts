import { serveOneTask } from "../tasks/serve.ts";
import { runInstallTask } from "./run-task.ts";
import { parseInstallTask } from "./task-protocol.ts";

serveOneTask(parseInstallTask, runInstallTask);

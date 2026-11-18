import { serveOneTask } from "../tasks/serve.ts";
import { runUpdateTask } from "./run-task.ts";
import { parseUpdateTask } from "./task-protocol.ts";

serveOneTask(parseUpdateTask, runUpdateTask);

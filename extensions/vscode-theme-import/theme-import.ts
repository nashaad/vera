import { parseCommandTask } from "../../clients/desktop/src/extension-commands/task-protocol.ts";
import { serveOneTask } from "../../clients/desktop/src/tasks/serve.ts";
import { runCommandTask } from "./run-task.ts";

serveOneTask(parseCommandTask, (task) => runCommandTask(task));

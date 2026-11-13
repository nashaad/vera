import { serveOneTask } from "../tasks/serve.ts";
import { runAssignmentTask } from "./run-task.ts";
import { parseAssignmentTask } from "./task-protocol.ts";

serveOneTask(parseAssignmentTask, runAssignmentTask);

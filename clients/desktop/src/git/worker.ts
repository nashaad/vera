import { serveOneTask } from "../tasks/serve.ts";
import { runGitTask } from "./run-task.ts";
import { parseGitTask } from "./task-protocol.ts";

serveOneTask(parseGitTask, runGitTask);

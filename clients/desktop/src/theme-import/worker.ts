import { serveOneTask } from "../tasks/serve.ts";
import { runThemeTask } from "./run-task.ts";
import { parseThemeTask } from "./task-protocol.ts";

serveOneTask(parseThemeTask, runThemeTask);

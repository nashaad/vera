import { serveOneTask } from "../tasks/serve.ts";
import { parsePluginInstallTask } from "./task-protocol.ts";
import { runPluginInstallTask } from "./run-task.ts";

serveOneTask(parsePluginInstallTask, runPluginInstallTask);

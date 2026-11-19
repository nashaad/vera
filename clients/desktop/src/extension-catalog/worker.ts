import { serveOneTask } from "../tasks/serve.ts";
import { runCatalogTask } from "./run-task.ts";
import { parseCatalogTask } from "./task-protocol.ts";

serveOneTask(parseCatalogTask, runCatalogTask);

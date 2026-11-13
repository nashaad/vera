import type { LastGoodConfigFile } from "../../../src/config.ts";
import type {
    AssignAllResult,
    AssignmentChange,
    AssignmentsFailure,
    AssignmentsResult,
    AssignmentWriteResult,
} from "../../ui/src/protocol/assignments.ts";
import type { AssignmentTask, AssignmentTaskReply } from "./model-assignments/task-protocol.ts";

export type RunAssignmentTask = (task: AssignmentTask) => Promise<AssignmentTaskReply>;

type TaskBody =
    | { readonly kind: "read" }
    | { readonly kind: "edit"; readonly change: AssignmentChange }
    | { readonly kind: "assign-all"; readonly provider: string; readonly model: string };

// The home's model assignments. Reading and writing config.json is a task `run` sends to its own process.
// This side keeps only the config the last task loaded, so a file that stops loading still shows the settings before it.
export class AssignmentService {
    private lastGood: LastGoodConfigFile | undefined;

    constructor(
        private readonly home: string,
        private readonly run: RunAssignmentTask,
    ) {}

    read(): Promise<AssignmentsResult> {
        return this.request({ kind: "read" }, (reply) => (reply.kind === "read" ? reply.result : undefined));
    }

    edit(change: AssignmentChange): Promise<AssignmentWriteResult> {
        return this.request({ kind: "edit", change }, (reply) => (reply.kind === "edit" ? reply.result : undefined));
    }

    assignAll(provider: string, model: string): Promise<AssignAllResult> {
        return this.request({ kind: "assign-all", provider, model }, (reply) => (reply.kind === "assign-all" ? reply.result : undefined));
    }

    private async request<Result>(
        body: TaskBody,
        pick: (reply: AssignmentTaskReply) => Result | undefined,
    ): Promise<Result | AssignmentsFailure> {
        try {
            const reply = await this.run({ ...body, home: this.home, ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }) });
            const result = pick(reply);
            if (result === undefined) return { ok: false, reason: "The assignments task answered a different request." };
            this.lastGood = reply.lastGood;
            return result;
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }
}

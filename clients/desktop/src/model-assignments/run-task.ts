import { AssignmentStore } from "./assignment-store.ts";
import { editOf, type AssignmentTask, type AssignmentTaskReply } from "./task-protocol.ts";

export function runAssignmentTask(task: AssignmentTask): AssignmentTaskReply {
    const store = new AssignmentStore(task.home, task.lastGood);
    const reply = answer(store, task);
    return store.lastGood === undefined ? reply : { ...reply, lastGood: store.lastGood };
}

function answer(store: AssignmentStore, task: AssignmentTask): AssignmentTaskReply {
    switch (task.kind) {
        case "read":
            return { kind: "read", result: store.read() };
        case "edit":
            return { kind: "edit", result: store.edit(editOf(task.change)) };
        case "assign-all":
            return { kind: "assign-all", result: store.assignAll(task.provider, task.model) };
    }
}

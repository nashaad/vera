import { runGitTask as answer } from "../../../shared/git-changes.ts";
import type { GitTask, GitTaskReply } from "../../../shared/git-wire.ts";

export function runGitTask(task: GitTask): Promise<GitTaskReply> {
    return answer(task);
}

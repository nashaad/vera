import { randomUUID } from "node:crypto";
import type { UiResponseCommand, UserQuestionUiRequestUpdate } from "../../../src/engine/protocol.ts";
import type { BootCheck, BootQuestion, BootStatus } from "../../../src/host/boot.ts";
import type { FindOrStartHostOptions } from "../../host/launch.ts";
import { closeTransientOverlaysForUiRequest } from "./agents-dials.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

export interface ReconnectBootQuestion {
    readonly update: UserQuestionUiRequestUpdate;
    answer(response?: UiResponseCommand): void;
}

export interface ReconnectBoot {
    readonly boot: NonNullable<FindOrStartHostOptions["boot"]>;
    notice(): string | undefined;
    waitFor<T>(request: Promise<T>, discardLate: (value: T) => void): Promise<T>;
}

const MARK: Record<BootStatus, string> = {
    ok: "[ok]",
    fixed: "[fixed]",
    warn: "[warn]",
    failed: "[fail]",
};

export function createReconnectBoot(rt: TuiRuntime, timeoutMs: number): ReconnectBoot {
    const checks: BootCheck[] = [];
    let renderedChecks: readonly BootCheck[] = [];
    let remainingMs = timeoutMs;
    let startedAt = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let expired = false;
    let rejectDeadline: (reason: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });

    const dispose = (): void => {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        timeout = undefined;
        rt.reconnectBootQuestion?.answer();
        if (rt.cancelReconnectBoot === cancel) rt.cancelReconnectBoot = undefined;
    };
    const cancel = (): void => {
        if (!active) return;
        expired = true;
        dispose();
        rejectDeadline(new Error("TUI is closing"));
    };
    const resume = (): void => {
        if (!active) return;
        startedAt = performance.now();
        timeout = setTimeout(() => {
            expired = true;
            dispose();
            rejectDeadline(new Error("timed out"));
        }, remainingMs);
        timeout.unref?.();
    };
    const pause = (): void => {
        if (timeout === undefined) return;
        clearTimeout(timeout);
        timeout = undefined;
        remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt));
    };
    const confirm = (question: BootQuestion): Promise<boolean> => {
        if (!active || rt.shuttingDown || rt.reconnectBootQuestion !== undefined) {
            return Promise.resolve(false);
        }
        pause();
        closeTransientOverlaysForUiRequest(rt);
        return new Promise<boolean>((resolve) => {
            const update: UserQuestionUiRequestUpdate = {
                type: "ui_request",
                requestId: `reconnect-boot:${randomUUID()}`,
                seq: 0,
                request: {
                    type: "user_question",
                    question: question.text,
                    allowCustom: false,
                    allowNotes: false,
                    choices: [
                        { id: "yes", label: "Yes" },
                        { id: "no", label: "No" },
                    ],
                },
            };
            rt.reconnectBootQuestion = {
                update,
                answer(response) {
                    if (rt.reconnectBootQuestion?.update.requestId !== update.requestId) return;
                    rt.reconnectBootQuestion = undefined;
                    const answer = response?.response;
                    const yes = answer?.type === "user_question"
                        && answer.outcome === "selected"
                        && answer.choiceId === "yes";
                    resolve(yes);
                    resume();
                    if (!rt.shuttingDown) {
                        renderState(rt);
                        focusActiveSurface(rt);
                    }
                },
            };
            renderState(rt);
            focusActiveSurface(rt);
        });
    };

    rt.cancelReconnectBoot = cancel;
    resume();
    return {
        boot: {
            onCheck(check) {
                if (!active) return;
                checks.push(check);
                rt.flightRecorder?.record({ type: "reconnect_boot_check", ...check });
            },
            render(current) {
                if (active) renderedChecks = current.slice();
            },
            onWaiting() {},
            confirm,
        },
        notice() {
            const current = checks.length >= renderedChecks.length ? checks : renderedChecks;
            if (!current.some((check) => check.status !== "ok")) return undefined;
            return current.map((check) =>
                `${MARK[check.status].padEnd(8)}${check.label}${check.detail === undefined ? "" : `: ${check.detail}`}`
            ).join("\n");
        },
        waitFor(request, discardLate) {
            void request.then((value) => {
                if (expired) discardLate(value);
            }, () => undefined);
            return Promise.race([request, deadline]).finally(dispose);
        },
    };
}

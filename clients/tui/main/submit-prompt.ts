import { loadOptionalVeraConfig } from "../../../src/config.ts";
import { invokeDirectClientExtensionCommand } from "../../../src/extensions/client.ts";
import { renderExtensionInstallPreview, renderExtensionMutation } from "../../../src/extensions/manager-command.ts";
import { installExtension, removeExtension, setAnyExtensionEnabled } from "../../../src/extensions/manager.ts";
import { diagnoseVeraProcesses, renderVeraDoctor } from "../../process-doctor.ts";
import { diagnoseProviders, renderProviderDoctor } from "../../provider-doctor.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { clientExtensionReloadFailed, clientExtensionReloadStarted, clientExtensionReloadSucceeded, reloadTuiClientExtensions } from "../client-extension-reload.ts";
import { extensionCommandResultText, tuiCommandScope } from "../commands.ts";
import { startTuiHelp } from "../help.ts";
import { isJsonlViewClient } from "../jsonl-view-client.ts";
import { DIRECT_EXTENSION_COMMAND_TIMEOUT_MS, activeFlightSurface, applyTimelineTransition, beginCreateSession, requestCreateSession, beginHostReconnect, beginSessionResume, discardSwitchTarget, focusActiveSurface, isModelShortlisted, offerMessageToExtensions, openCommandPalette, openConfigurePicker, openHelp, openPreferencesList, openResumePicker, openSearchOverlay, openSettingsDestination, openStandingNudges, openThemePicker, openWorkTab, refuseJsonlCommand, renderCommandSuggestions, renderState, renderStatus, reportConnectionError, requestCloseSession, requestModelSettingsChange, requestPermissionsChange, requestPoolAdmission, routeVisibleAgentPrompt, runBack, sendCommand, showStatusNotice, switchToClient, withSessionSwitchDeadline } from "../main.ts";
import { openExtensionsList, refreshOpenExtensionsList } from "./extensions-ops.ts";
import { importSessionFromTui, openImportPicker } from "./import-ops.ts";
import { homeNeedsProvider } from "./model-pickers.ts";
import { openOnboardingWizard } from "./onboarding-wizard-ops.ts";
import { focusedAgentClient, focusedAgentState, hostOwnsPromptQueue, releaseFocusedQueuedPrompts, selectAgent } from "./agents-dials.ts";
import { adoptFallbackSessionTitle, clearSearchLanding, coreHelpCommands, readStandingNudgeRules, workerFreeAction } from "../main/chrome.ts";
import { abortProviderHealthCheck, diagnosticsSnapshot, renderDiagnostics, writeFailureReportFile } from "../main/diagnostics-ops.ts";
import { openTuiLink } from "../markdown-links.ts";
import { readProcessMemory } from "../process-memory.ts";
import { idleProviderHealth } from "../provider-health.ts";
import { withQuote } from "../quote.ts";
import { startTuiSessionPicker } from "../settings-picker.ts";
import { appendTuiError, appendTuiNotice, beginTuiTurn, queueTuiPrompt, userEntryShows } from "../state.ts";
import { startTuiTimelinePicker } from "../timeline-picker.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function submitPrompt(rt: TuiRuntime, 
    interceptedText?: string,
    injectedPrefix?: number,
): void {
    if (rt.shuttingDown) return;
    clearSearchLanding(rt);
    rt.flightRecorder?.record({
        type: "submit_requested",
        characters: Array.from(
            interceptedText ?? rt.composer.expandedText(),
        ).length,
        surface: activeFlightSurface(rt),
        blocked: rt.promptSubmitting
            || rt.sessionSwitchPending
            || rt.pendingSessionRename
            || rt.pendingSidebarSessionRename
            || rt.extensionCommandPending
            || rt.sidebarPromptSubmitting
            || rt.messageInterceptPending,
    });
    if (
        rt.promptSubmitting
        || rt.sessionSwitchPending
        || rt.pendingSessionRename
        || rt.pendingSidebarSessionRename
        || rt.extensionCommandPending
        || rt.sidebarPromptSubmitting
        || rt.messageInterceptPending
    ) {
        return;
    }
    rt.standingNudgeRules = readStandingNudgeRules(rt);
    const typed = interceptedText ?? rt.composer.expandedText().trim();
    const quoted = interceptedText === undefined && !typed.startsWith("/")
        ? rt.pendingQuote
        : undefined;
    const prompt = withQuote(typed, quoted);
    if (prompt.length === 0 && rt.pendingImages.length === 0) {
        if (
            interceptedText === undefined
            && focusedAgentState(rt).queuedPrompts.length > 0
        ) {
            releaseFocusedQueuedPrompts(rt, "all");
        }
        return;
    }
    rt.composerTip = undefined;
    if (quoted !== undefined) {
        rt.pendingQuote = undefined;
    }
    if (
        interceptedText === undefined
        && prompt.length > 0
        && !prompt.startsWith("/")
        && rt.clientExtensionRegistry?.hasMessageInterceptors() === true
    ) {
        offerMessageToExtensions(rt, prompt);
        return;
    }
    if (
        !prompt.startsWith("/")
        && rt.hostedSidebar.pane !== undefined
        && routeVisibleAgentPrompt(rt, prompt)
    ) {
        return;
    }

    const commandAction = prompt.length === 0
        ? undefined
        : rt.commandRegistry.dispatch(prompt);
    if (isJsonlViewClient(rt.client) && rt.jsonlCommandMode) {
        if (!workerFreeAction(rt, commandAction, true)) {
            refuseJsonlCommand(rt);
            return;
        }
        rt.jsonlCommandMode = false;
    }
    if (
        commandAction === undefined
        && (rt.extensionCommandsLoading || rt.skillCommandsLoading)
        && prompt.startsWith("/")
    ) {
        rt.state = appendTuiNotice(
            rt.state,
            rt.skillCommandsLoading
                ? "Commands are still loading"
                : "Extension commands are still loading",
        );
        renderState(rt);
        return;
    }
    if (
        commandAction !== undefined
        && rt.sidebar.isFocused()
        && rt.hostedSidebar.pane !== undefined
        && tuiCommandScope(commandAction) === "main_session"
    ) {
        rt.composer.clearComposer();
        showStatusNotice(rt, 
            "Switch to Vera with Ctrl+G to manage its conversation",
        );
        renderState(rt);
        return;
    }
    if (commandAction?.type === "command_error") {
        rt.state = appendTuiNotice(rt.state, commandAction.message);
        renderState(rt);
        return;
    }
    if (commandAction?.type === "show_extensions") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openExtensionsList(rt);
        return;
    }
    if (commandAction?.type === "manage_extensions") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        const command = commandAction.command;
        if (command.operation === "reload") {
            rt.state = appendTuiNotice(
                rt.state,
                "Client extensions reload now; restart the resident host for host-side capabilities.",
            );
            renderState(rt);
            submitPrompt(rt, "/reload-extensions");
            return;
        }
        try {
            let text: string;
            if (command.operation === "install") {
                const result = installExtension(command.source, {
                    dryRun: command.dryRun,
                });
                text = renderExtensionInstallPreview(result.preview)
                    + (result.record === undefined
                        ? ""
                        : `\nInstalled ${result.record.id}.\n`);
            } else if (command.operation === "enable" || command.operation === "disable") {
                const record = setAnyExtensionEnabled(
                    command.id,
                    command.operation === "enable",
                );
                text = renderExtensionMutation(command.operation, record);
            } else {
                const record = removeExtension(command.id);
                text = renderExtensionMutation("remove", record);
            }
            if (command.operation !== "install" || !command.dryRun) {
                text += "\nClient extensions reload now; restart the resident host for host-side capabilities.\n";
            }
            if (command.operation === "install") {
                rt.extensionsDialog = { text, copyReady: true };
            } else {
                rt.state = appendTuiNotice(rt.state, text.trimEnd());
                refreshOpenExtensionsList(rt);
            }
            renderState(rt);
            focusActiveSurface(rt);
            if (command.operation !== "install" || !command.dryRun) {
                submitPrompt(rt, "/reload-extensions");
            }
        } catch (error) {
            rt.state = appendTuiError(
                rt.state,
                `Extension operation failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            renderState(rt);
        }
        return;
    }
    if (commandAction?.type === "reload_client_extensions") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        if (rt.clientExtensionReloadPending) {
            rt.state = appendTuiNotice(
                rt.state,
                "Client extensions are already reloading",
            );
            renderState(rt);
            return;
        }
        rt.clientExtensionReloadPending = true;
        rt.clientExtensionReload = clientExtensionReloadStarted();
        if (rt.diagnosticsDialog !== undefined) {
            rt.diagnosticsDialog = {
                ...rt.diagnosticsDialog,
                text: renderDiagnostics(rt, {
                    ...diagnosticsSnapshot(rt),
                    sessionPath: rt.diagnosticsSessionPath,
                }),
            };
        }
        void reloadTuiClientExtensions({
            configuration: {
                disabledIncludedExtensions: rt.disabledIncludedExtensions,
                clientExtensions: rt.configuredClientExtensions,
            },
            refreshConfiguration:
                rt.dependencies.loadClientExtensionConfiguration,
            applyConfiguration(configuration) {
                rt.disabledIncludedExtensions =
                    configuration.disabledIncludedExtensions;
                rt.configuredClientExtensions = configuration.clientExtensions;
            },
            host: rt.clientExtensionHost,
            start(signal, extensions, failures) {
                return rt.startConfiguredClientExtensionHost(
                    signal,
                    extensions,
                    failures,
                );
            },
        }).then((loadedExtensionIds) => {
            if (rt.shuttingDown) return;
            rt.clientExtensionReload =
                clientExtensionReloadSucceeded(loadedExtensionIds);
            if (rt.diagnosticsDialog !== undefined) {
                rt.diagnosticsDialog = {
                    ...rt.diagnosticsDialog,
                    text: renderDiagnostics(rt, {
                        ...diagnosticsSnapshot(rt),
                        sessionPath: rt.diagnosticsSessionPath,
                    }),
                };
            }
            rt.state = appendTuiNotice(rt.state, "Client extensions reloaded");
            refreshOpenExtensionsList(rt);
            renderState(rt);
            focusActiveSurface(rt);
        }).catch((error) => {
            if (rt.shuttingDown) return;
            const outcome = clientExtensionReloadFailed(
                error,
                rt.clientExtensionHost.current()?.loadedExtensionIds() ?? [],
            );
            rt.clientExtensionReload = outcome.snapshot;
            if (rt.diagnosticsDialog !== undefined) {
                rt.diagnosticsDialog = {
                    ...rt.diagnosticsDialog,
                    text: renderDiagnostics(rt, {
                        ...diagnosticsSnapshot(rt),
                        sessionPath: rt.diagnosticsSessionPath,
                    }),
                };
            }
            rt.state = appendTuiNotice(
                rt.state,
                outcome.notice,
            );
            renderState(rt);
            focusActiveSurface(rt);
        }).finally(() => {
            rt.clientExtensionReloadPending = false;
        });
        return;
    }
    if (commandAction?.type === "show_diagnostics") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        rt.diagnosticsScope = "session";
        rt.diagnosticsMenu = true;
        rt.diagnosticsSessionPath = undefined;
        rt.diagnosticsSessionIdentity = undefined;
        rt.diagnosticsWorkerPid = undefined;
        rt.diagnosticsSupervisorPid = undefined;
        rt.diagnosticsProcessMemory = new Map();
        const generation = ++rt.diagnosticsGeneration;
        const agentId = rt.client.agentId;
        const resolvingSessionPath = agentId !== undefined
            && rt.dependencies.listAgents !== undefined;
        rt.diagnosticsSessionPathResolved = !resolvingSessionPath;
        rt.documentDialog = undefined;
        rt.doctorDialog = undefined;
        rt.extensionsDialog = undefined;
        rt.extensionsList = undefined;
        abortProviderHealthCheck(rt);
        rt.providerHealthGeneration += 1;
        rt.providerHealth = idleProviderHealth();
        rt.diagnosticsDialog = {
            text: renderDiagnostics(rt, {
                ...diagnosticsSnapshot(rt),
            }),
            scope: rt.diagnosticsScope,
            copyReady: rt.diagnosticsSessionPathResolved,
        };
        renderState(rt);
        focusActiveSurface(rt);
        if (agentId !== undefined && rt.dependencies.listAgents !== undefined) {
            void rt.dependencies.listAgents().then(async (agents) => {
                const listed = agents.find((agent) => agent.id === agentId);
                const sessionPath = listed?.session_path;
                if (
                    rt.diagnosticsDialog === undefined
                    || rt.diagnosticsGeneration !== generation
                    || rt.client.agentId !== agentId
                ) return;
                rt.diagnosticsSessionPathResolved = true;
                rt.diagnosticsSessionIdentity = listed?.name;
                rt.diagnosticsSessionPath = sessionPath;
                rt.diagnosticsWorkerPid = listed?.worker_pid;
                rt.diagnosticsSupervisorPid = listed?.supervisor_pid;
                rt.diagnosticsDialog = {
                    text: renderDiagnostics(rt),
                    scope: rt.diagnosticsScope,
                    copyReady: true,
                };
                renderState(rt);
                const processPids = [
                    process.pid,
                    rt.dependencies.build?.hostPid,
                    rt.diagnosticsWorkerPid,
                    rt.diagnosticsSupervisorPid,
                ].filter((pid): pid is number => pid !== undefined);
                rt.diagnosticsProcessMemory = await readProcessMemory(processPids);
                if (
                    rt.diagnosticsDialog === undefined
                    || rt.diagnosticsGeneration !== generation
                    || rt.client.agentId !== agentId
                ) return;
                rt.diagnosticsDialog = {
                    text: renderDiagnostics(rt),
                    scope: rt.diagnosticsScope,
                    copyReady: true,
                };
                renderState(rt);
            }).catch(() => {
                if (
                    rt.diagnosticsDialog === undefined
                    || rt.diagnosticsGeneration !== generation
                    || rt.client.agentId !== agentId
                ) return;
                rt.diagnosticsSessionPathResolved = true;
                rt.diagnosticsDialog = {
                    ...rt.diagnosticsDialog,
                    copyReady: true,
                };
                renderState(rt);
            });
        }
        return;
    }
    if (commandAction?.type === "import_session") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        importSessionFromTui(rt, commandAction.path);
        renderState(rt);
        return;
    }
    if (commandAction?.type === "open_import_picker") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openImportPicker(rt, "folder");
        return;
    }
    if (commandAction?.type === "open_usage") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        void (async () => {
            const result = await rt.dependencies.openUsagePage?.();
            if (rt.shuttingDown) return;
            if (result === undefined || "unavailable" in result) {
                rt.state = appendTuiNotice(
                    rt.state,
                    result?.unavailable
                        ?? "This host does not serve an annex. Restart the host to bring it back.",
                );
                renderState(rt);
                return;
            }
            const usageUrl = new URL("usage", result.url).href;
            openTuiLink(usageUrl);
            rt.state = appendTuiNotice(rt.state, `Opened ${usageUrl}`);
            renderState(rt);
        })();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (commandAction?.type === "show_doctor") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        rt.documentDialog = undefined;
        abortProviderHealthCheck(rt);
        rt.diagnosticsDialog = undefined;
        rt.extensionsDialog = undefined;
        rt.extensionsList = undefined;
        rt.doctorDialog = {
            text: "Vera doctor\n\nChecking process health…\n",
            copyReady: false,
        };
        renderState(rt);
        focusActiveSurface(rt);
        const inspectProcesses = rt.dependencies.doctor
            ?? diagnoseVeraProcesses;
        const inspectionGeneration = ++rt.doctorInspectionGeneration;
        void inspectProcesses().then((report) => {
            if (
                rt.shuttingDown
                || rt.doctorDialog === undefined
                || rt.doctorInspectionGeneration !== inspectionGeneration
            ) return;
            const strayCount = report.processes.filter(
                (candidate) => candidate.stray,
            ).length;
            const processText = strayCount > 0
                ? `${renderVeraDoctor(report)}\nRun \`vera doctor\` in a terminal to stop ${
                    strayCount === 1 ? "it" : "them"
                }.\n`
                : renderVeraDoctor(report);
            rt.doctorDialog = { text: processText, copyReady: false };
            renderState(rt);
            focusActiveSurface(rt);
            void diagnoseProviders(loadOptionalVeraConfig(), {
                authStorage: rt.authStorage,
            }).then(
                (providers) => {
                    if (
                        rt.shuttingDown
                        || rt.doctorDialog === undefined
                        || rt.doctorInspectionGeneration
                            !== inspectionGeneration
                    ) return;
                    rt.doctorDialog = {
                        text: `${processText}\n${renderProviderDoctor(providers)}`,
                    };
                    renderState(rt);
                    focusActiveSurface(rt);
                },
            ).catch(() => {
                if (
                    rt.shuttingDown
                    || rt.doctorDialog === undefined
                    || rt.doctorInspectionGeneration !== inspectionGeneration
                ) return;
                rt.doctorDialog = { text: processText };
                renderState(rt);
                focusActiveSurface(rt);
            });
        }).catch((error) => {
            if (
                rt.shuttingDown
                || rt.doctorDialog === undefined
                || rt.doctorInspectionGeneration !== inspectionGeneration
            ) return;
            const message = error instanceof Error
                ? error.message
                : String(error);
            rt.doctorDialog = {
                text: [
                    "Vera doctor",
                    "",
                    `Process inspection failed: ${message}`,
                    "",
                    "No processes were stopped.",
                    "",
                ].join("\n"),
            };
            renderState(rt);
            focusActiveSurface(rt);
        });
        return;
    }
    if (commandAction?.type === "write_failure_report") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        void writeFailureReportFile(rt);
        return;
    }
    if (
        commandAction?.type === "open_settings_destination"
        && tuiCommandScope(commandAction) === "application"
    ) {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openSettingsDestination(rt, commandAction.destination);
        return;
    }
    if (commandAction?.type === "pool_current_model") {
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        const targetSettings = focusedAgentState(rt).modelSettings;
        const provider = targetSettings?.provider;
        const model = targetSettings?.model;
        if (provider === undefined || model === undefined) {
            rt.state = appendTuiError(
                rt.state,
                "No model is running yet, so there is nothing to pin",
            );
            renderState(rt);
            return;
        }
        if (isModelShortlisted(rt, targetSettings, provider, model)) {
            showStatusNotice(rt, `${provider}/${model} is already in your library`);
            return;
        }
        requestPoolAdmission(rt, provider, model);
        return;
    }
    if (commandAction?.type === "run_extension") {
        const directExtension = rt.directClientExtensions.find(
            (extension) =>
                commandAction.origin === "direct"
                && extension.id === commandAction.source,
        );
        if (rt.state.working && commandAction.origin === "host") {
            rt.state = appendTuiNotice(
                rt.state,
                "Extension commands are available when the agent is idle",
            );
            renderState(rt);
            return;
        }
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        if (
            (commandAction.origin === "direct"
                && directExtension === undefined)
            || (commandAction.origin === "client"
                && rt.clientExtensionRegistry === undefined)
            || (commandAction.origin === "host"
                && rt.client.runExtensionCommand === undefined)
        ) {
            rt.composer.setComposerText(prompt);
            rt.state = appendTuiError(
                rt.state,
                `${commandAction.source}: command unavailable`,
            );
            renderState(rt);
            return;
        }
        rt.extensionCommandPending = true;
        rt.extensionCommandActivity = `running /${commandAction.command}`;
        renderStatus(rt);
        const extensionSubmittedImages = [...rt.pendingImages];
        const extensionTarget = focusedAgentClient(rt);
        const invocation = commandAction.origin === "host"
            ? rt.client.runExtensionCommand!(
                commandAction.command,
                commandAction.argumentsText,
            )
            : commandAction.origin === "client"
            ? rt.extensionAgentTarget.run(extensionTarget, () =>
                rt.clientExtensionRegistry!.invokeCommand(
                    commandAction.command,
                    commandAction.argumentsText,
                    rt.client.workspace ?? process.cwd(),
                    undefined,
                    extensionSubmittedImages.length,
                    extensionSubmittedImages.flatMap((image) =>
                        image.path === undefined ? [] : [image.path]
                    ),
                )
            )
            : invokeDirectClientExtensionCommand(
                directExtension!,
                commandAction.command,
                commandAction.argumentsText,
                { timeoutMs: DIRECT_EXTENSION_COMMAND_TIMEOUT_MS },
            );
        void invocation.then((result) => {
            if (
                commandAction.origin === "client"
                && extensionSubmittedImages.length > 0
            ) {
                const submitted = new Set(
                    extensionSubmittedImages.map((image) => image.requestId),
                );
                rt.pendingImages = rt.pendingImages.filter(
                    (image) => !submitted.has(image.requestId),
                );
            }
            if (rt.shuttingDown || result === undefined) {
                return;
            }
            if (commandAction.origin === "host" && extensionTarget.agentId === rt.client.agentId
                && "extensionState" in result && result.extensionState !== undefined) {
                rt.state = { ...rt.state, extensionState: result.extensionState };
            }
            if (result.body.kind === "client_action") {
                if (result.body.action === "show_help") {
                    rt.help = startTuiHelp(
                        coreHelpCommands(rt),
                        rt.hostExtensionCommands,
                    );
                }
            } else if (result.body.kind !== "handled") {
                rt.state = appendTuiNotice(
                    rt.state,
                    extensionCommandResultText({
                        version: 1,
                        source: result.source,
                        body: result.body,
                    }),
                );
            }
        }).catch((error) => {
            if (rt.shuttingDown) {
                return;
            }
            const message = error instanceof Error
                ? error.message
                : String(error);
            rt.state = appendTuiNotice(
                rt.state,
                `${commandAction.source}/${commandAction.command}: ${message}`,
            );
            if (rt.composer.plainText.length === 0) {
                rt.composer.setComposerText(prompt);
                renderCommandSuggestions(rt);
            }
        }).finally(() => {
            if (!rt.shuttingDown) {
                rt.extensionCommandPending = false;
                rt.extensionCommandActivity = undefined;
                renderState(rt);
                focusActiveSurface(rt);
            }
        });
        return;
    }
    if (
        rt.connectionFailed
        && commandAction?.type !== "open_resume_picker"
        && commandAction?.type !== "open_theme_picker"
        && commandAction?.type !== "create_session"
        && commandAction?.type !== "close_session"
        && commandAction?.type !== "reconnect"
    ) {
        rt.state = appendTuiError(
            rt.state,
            "Disconnected from the host. Run /reconnect to restore this"
                + " session, or ctrl+c to quit.",
        );
        renderState(rt);
        return;
    }
    if (commandAction?.type === "invoke_skill") {
        const requestId = randomUUID();
        rt.composer.rememberSubmittedText(prompt);
        rt.composer.clearComposer();
        rt.pendingSkillInvocations.set(requestId, prompt);
        rt.promptSubmitting = true;
        renderCommandSuggestions(rt);
        renderStatus(rt);
        void rt.client.send({
            type: "invoke_skill",
            requestId,
            name: commandAction.name,
            argumentsText: commandAction.argumentsText,
        }).catch((error) => {
            if (!rt.pendingSkillInvocations.delete(requestId) || rt.shuttingDown) {
                return;
            }
            rt.promptSubmitting = rt.pendingSkillInvocations.size > 0;
            if (rt.composer.plainText.length === 0) {
                rt.composer.setComposerText(prompt);
                renderCommandSuggestions(rt);
            }
            rt.state = appendTuiError(
                rt.state,
                error instanceof Error ? error.message : String(error),
            );
            renderState(rt);
        });
        return;
    }
    if (commandAction?.type === "update_model") {
        rt.composer.clearComposer();
        const typed = commandAction.model.trim();
        const named = rt.state.modelSettings?.pooled?.find(
            (entry) => entry.poolName === typed,
        );
        if (named !== undefined) {
            requestModelSettingsChange(rt, 
                { provider: named.provider, model: named.model },
                `model → ${typed}`,
                `the model to ${typed}`,
            );
            renderState(rt);
            return;
        }
        const separator = typed.indexOf("/");
        const provider = separator > 0 ? typed.slice(0, separator) : undefined;
        const model = separator > 0 ? typed.slice(separator + 1) : typed;
        if (model.length === 0) {
            rt.state = appendTuiError(rt.state, `"${typed}" is not a model name`);
            renderState(rt);
            return;
        }
        requestModelSettingsChange(rt, 
            {
                model,
                ...(provider === undefined ? {} : { provider }),
            },
            `model → ${typed}`,
            `the model to ${typed}`,
        );
        renderState(rt);
        return;
    }
    if (commandAction?.type === "update_reasoning") {
        rt.composer.clearComposer();
        requestModelSettingsChange(rt, 
            { reasoningEffort: commandAction.reasoningEffort },
            `reasoning → ${commandAction.reasoningEffort}`,
            `reasoning to ${commandAction.reasoningEffort}`,
        );
        renderState(rt);
        return;
    }
    if (commandAction?.type === "update_permissions") {
        rt.composer.clearComposer();
        if (commandAction.mode === "full_access") {
            rt.confirmingFullAccess = true;
            rt.confirmingFullAccessAgent = focusedAgentClient(rt);
            focusActiveSurface(rt);
        } else {
            requestPermissionsChange(rt, 
                commandAction.mode,
                focusedAgentClient(rt),
                commandAction.scope ?? "global",
            );
        }
        renderState(rt);
        return;
    }
    if (commandAction?.type === "open_preferences_list") {
        rt.composer.clearComposer();
        openPreferencesList(rt);
        return;
    }
    if (commandAction?.type === "open_standing_nudges") {
        rt.composer.clearComposer();
        openStandingNudges(rt);
        return;
    }
    if (commandAction?.type === "open_settings_destination") {
        rt.composer.clearComposer();
        openSettingsDestination(rt, commandAction.destination);
        return;
    }
    if (commandAction?.type === "select_agent") {
        rt.composer.clearComposer();
        selectAgent(rt, commandAction.name);
        return;
    }
    if (commandAction?.type === "open_theme_picker") {
        rt.composer.clearComposer();
        openThemePicker(rt);
        return;
    }
    if (commandAction?.type === "open_configure") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openConfigurePicker(rt);
        return;
    }
    if (commandAction?.type === "open_command_palette") {
        rt.composer.clearComposer();
        openCommandPalette(rt);
        return;
    }
    if (commandAction?.type === "open_help") {
        rt.composer.clearComposer();
        openHelp(rt, commandAction.tab);
        return;
    }
    if (commandAction?.type === "prefill_composer") {
        rt.composer.setComposerText(commandAction.text);
        renderCommandSuggestions(rt);
        renderState(rt);
        rt.composer.focus();
        return;
    }
    if (commandAction?.type === "open_work_tab") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openWorkTab(rt);
        return;
    }
    if (commandAction?.type === "open_search") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openSearchOverlay(rt, "workspace");
        return;
    }
    if (commandAction?.type === "open_resume_picker") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        openResumePicker(rt);
        return;
    }
    if (commandAction?.type === "open_subagents_picker") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        if (rt.dependencies.listAgents === undefined) {
            rt.state = appendTuiError(rt.state, "Session listing is unavailable");
            renderState(rt);
            return;
        }
        const version = ++rt.resumeListVersion;
        const targetAgentId = focusedAgentClient(rt).agentId;
        rt.settingsPicker = startTuiSessionPicker(
            [],
            targetAgentId,
            true,
            new Date(),
            true,
            [],
            "keep_running",
        );
        focusActiveSurface(rt);
        renderState(rt);
        void rt.dependencies.listAgents().then((agents) => {
            if (
                rt.shuttingDown
                || version !== rt.resumeListVersion
                || rt.settingsPicker?.kind !== "session"
            ) {
                return;
            }
            const currentId = targetAgentId;
            const children = agents.filter(
                (agent) => agent.parent_id === currentId,
            );
            if (children.length === 0) {
                rt.settingsPicker = undefined;
                rt.state = appendTuiNotice(
                    rt.state,
                    "This conversation has no subagents",
                );
                focusActiveSurface(rt);
                renderState(rt);
                return;
            }
            rt.settingsPicker = startTuiSessionPicker(
                children,
                currentId,
                false,
                new Date(),
                true,
                [],
                "keep_running",
            );
            focusActiveSurface(rt);
            renderState(rt);
        }).catch((error) => {
            if (
                !rt.shuttingDown
                && version === rt.resumeListVersion
                && rt.settingsPicker?.kind === "session"
            ) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                rt.state = appendTuiError(
                    rt.state,
                    `Could not list sessions: ${message}`,
                );
                rt.settingsPicker = undefined;
                focusActiveSurface(rt);
                renderState(rt);
            }
        });
        return;
    }
    if (commandAction?.type === "go_back") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        runBack(rt);
        return;
    }
    if (commandAction?.type === "go_to_parent") {
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        if (rt.dependencies.listAgents === undefined) {
            rt.state = appendTuiError(rt.state, "Session listing is unavailable");
            renderState(rt);
            return;
        }
        const targetAgentId = focusedAgentClient(rt).agentId;
        void rt.dependencies.listAgents().then((agents) => {
            if (rt.shuttingDown) {
                return;
            }
            const current = agents.find(
                (agent) => agent.id === targetAgentId,
            );
            const parent = current?.parent_id === undefined
                ? undefined
                : agents.find((agent) => agent.id === current.parent_id);
            if (parent === undefined) {
                rt.state = appendTuiNotice(
                    rt.state,
                    "This conversation has no parent",
                );
                renderState(rt);
                return;
            }
            beginSessionResume(rt, 
                parent.session_path,
                parent.id,
                false,
                false,
                "keep_running",
            );
        }).catch((error) => {
            if (rt.shuttingDown) return;
            const message = error instanceof Error
                ? error.message
                : String(error);
            rt.state = appendTuiError(
                rt.state,
                `Could not find the parent conversation: ${message}`,
            );
            renderState(rt);
        });
        return;
    }
    if (commandAction?.type === "reconnect") {
        rt.composer.clearComposer();
        if (rt.sessionSwitchPending) {
            renderState(rt);
            return;
        }
        const currentAgentId = rt.client.agentId;
        if (
            rt.dependencies.reconnectSession === undefined
            || currentAgentId === undefined
        ) {
            rt.state = appendTuiError(
                rt.state,
                "Reconnecting this session is unavailable",
            );
            renderState(rt);
            return;
        }
        beginHostReconnect(rt, { clearComposer: true, replaceExisting: true });
        return;
    }
    if (commandAction?.type === "create_session") {
        requestCreateSession(rt, { ignoreEnter: true });
        return;
    }
    if (commandAction?.type === "close_session") {
        rt.composer.clearComposer();
        requestCloseSession(rt);
        return;
    }
    if (commandAction?.type === "clone_session") {
        rt.composer.clearComposer();
        if (rt.dependencies.cloneSession === undefined) {
            rt.state = appendTuiError(
                rt.state,
                "Cloning this session is unavailable",
            );
            renderState(rt);
            return;
        }
        const sourceAgentId = rt.client.agentId;
        if (sourceAgentId === undefined) {
            rt.state = appendTuiError(
                rt.state,
                "Current session ID is unavailable",
            );
            renderState(rt);
            return;
        }
        rt.sessionSwitchPending = true;
        rt.sessionSwitchActivity = "cloning session…";
        renderStatus(rt);
        void withSessionSwitchDeadline(rt, 
            rt.dependencies.cloneSession(sourceAgentId),
            ((next: TuiAgentClient) => discardSwitchTarget(rt, next)),
        ).then((next) => {
            if (rt.shuttingDown) {
                discardSwitchTarget(rt, next);
                return;
            }
            switchToClient(rt, next);
        }).catch((error) => {
            if (rt.shuttingDown) return;
            rt.sessionSwitchPending = false;
            const message = error instanceof Error
                ? error.message
                : String(error);
            rt.state = appendTuiError(
                rt.state,
                `Could not clone this session: ${message}`,
            );
            renderState(rt);
        });
        return;
    }
    if (commandAction?.type === "compact_session") {
        rt.composer.clearComposer();
        void rt.client.send({ type: "compact", requestId: randomUUID() })
            .catch((error) => {
                rt.composer.setComposerText(prompt);
                reportConnectionError(rt, error);
            });
        showStatusNotice(rt, "summarizing earlier messages…");
        return;
    }
    if (commandAction?.type === "update_session_name") {
        const requestId = randomUUID();
        rt.composer.clearComposer();
        const target = focusedAgentClient(rt);
        if (target !== rt.client) {
            rt.pendingSidebarSessionRename = { requestId, commandText: prompt };
            void target.send({
                type: "update_session_name",
                requestId,
                name: commandAction.name,
            }).catch((error) => {
                if (rt.pendingSidebarSessionRename?.requestId !== requestId) {
                    return;
                }
                rt.pendingSidebarSessionRename = undefined;
                if (rt.composer.expandedText().length === 0) {
                    rt.composer.setComposerText(prompt);
                }
                reportConnectionError(rt, error);
            });
            showStatusNotice(rt, 
                commandAction.name === null
                    ? "clearing peer session name…"
                    : "renaming peer session…",
            );
            return;
        }
        rt.pendingSessionRename = { requestId, commandText: prompt };
        void target.send({
            type: "update_session_name",
            requestId,
            name: commandAction.name,
        }).catch((error) => {
            if (rt.pendingSessionRename?.requestId !== requestId) return;
            rt.pendingSessionRename = undefined;
            if (rt.composer.expandedText().length === 0) {
                rt.composer.setComposerText(prompt);
            }
            reportConnectionError(rt, error);
        });
        showStatusNotice(rt, 
            commandAction.name === null
                ? "clearing session name…"
                : "renaming session…",
        );
        return;
    }
    if (commandAction?.type === "open_rewind") {
        if (
            rt.state.working
            || rt.state.queuedPrompts.length > 0
            || rt.pendingUiRequest !== undefined
            || rt.timelinePicker !== undefined
        ) {
            rt.state = appendTuiNotice(
                rt.state,
                "Rewind is available when the agent is idle.",
            );
            renderState(rt);
            return;
        }
        rt.composer.clearComposer();
        applyTimelineTransition(rt, startTuiTimelinePicker(randomUUID()));
        return;
    }
    if (commandAction?.type === "open_fork") {
        if (
            rt.state.working
            || rt.state.queuedPrompts.length > 0
            || rt.pendingUiRequest !== undefined
            || rt.timelinePicker !== undefined
        ) {
            rt.state = appendTuiNotice(
                rt.state,
                "Fork is available when the agent is idle.",
            );
            renderState(rt);
            return;
        }
        rt.composer.clearComposer();
        applyTimelineTransition(rt, startTuiTimelinePicker(
            randomUUID(),
            "fork",
        ));
        return;
    }

    if (rt.pendingImages.some((image) => image.id === undefined)) {
        rt.submitAfterImageAttachment = true;
        rt.state = appendTuiNotice(rt.state, "Wait for the image attachment to finish.");
        renderState(rt);
        return;
    }
    if (homeNeedsProvider(rt)) {
        // A turn with no provider behind it can only fail, so the first prompt
        // opens the gates instead of being sent. It stays in the composer and
        // runs there once a model has answered.
        openSettingsDestination(rt, { kind: "provider" });
        return;
    }
    const chipOrder = rt.composer.imageChipRequestIds();
    const attachments = chipOrder
        .flatMap((requestId) => {
            const image = rt.pendingImages.find(
                (candidate) => candidate.requestId === requestId,
            );
            return image?.id === undefined ? [] : [{
                id: image.id,
                ...(image.name === undefined ? {} : { name: image.name }),
            }];
        });
    const attachmentIds = attachments.map((attachment) => attachment.id);
    if (attachmentIds.length > 0) {
        const submittedRequestIds = new Set(
            rt.pendingImages.map((image) => image.requestId),
        );
        const queueing = rt.state.working || rt.state.queuedPrompts.length > 0;
        rt.promptSubmitting = true;
        renderStatus(rt);
        rt.flightRecorder?.record({ type: "submit_dispatched" });
        void rt.client.send({
            type: "prompt",
            content: prompt,
            attachmentIds,
        }).then(() => {
            rt.flightRecorder?.record({ type: "submit_accepted" });
            rt.promptSubmitting = false;
            if (rt.shuttingDown) return;
            if (rt.composer.expandedText().trim() === prompt) {
                rt.composer.rememberSubmittedText(prompt);
                rt.composer.clearComposer();
            }
            rt.pendingImages = rt.pendingImages.filter(
                (image) => !submittedRequestIds.has(image.requestId),
            );
            if (queueing && !hostOwnsPromptQueue(rt, rt.client)) {
                rt.state = queueTuiPrompt(rt.state, prompt);
            } else if (!queueing) {
                if (
                    !userEntryShows(rt.state.entries.at(-1), prompt, attachments)
                ) {
                    rt.state = beginTuiTurn(rt.state, prompt, attachments);
                } else if (!rt.state.working) {
                    rt.state = { ...rt.state, working: true };
                }
                adoptFallbackSessionTitle(rt, prompt);
                rt.workingSince ??= Date.now();
                rt.phaseSince = rt.workingSince;
                rt.activity = "thinking";
            }
            renderState(rt);
        }).catch((error) => {
            rt.flightRecorder?.record({
                type: "submit_failed",
                error: error instanceof Error ? error.message : String(error),
            });
            rt.promptSubmitting = false;
            reportConnectionError(rt, error);
        });
        return;
    }
    rt.composer.rememberSubmittedText(prompt);
    rt.composer.clearComposer();
    const queueing = rt.state.working || rt.state.queuedPrompts.length > 0;
    rt.state = queueing
        ? hostOwnsPromptQueue(rt, rt.client)
            ? rt.state
            : queueTuiPrompt(rt.state, prompt)
        : beginTuiTurn(rt.state, prompt, attachments, injectedPrefix);
    adoptFallbackSessionTitle(rt, prompt, injectedPrefix);
    if (!queueing && rt.workingSince === undefined) {
        rt.workingSince = Date.now();
        rt.phaseSince = rt.workingSince;
        rt.activity = "thinking";
    }
    renderState(rt);
    rt.pendingImages = [];
    sendCommand(rt, {
        type: "prompt",
        content: prompt,
        ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
    });
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { ModelPills } from "../models/ModelPills.tsx";
import { useDraftModels } from "../models/useDraftModels.ts";
import { useRouter } from "../pages/router.tsx";
import type { CreateSessionResult, DesktopBridge } from "../protocol/bridge.ts";
import { setPendingPrompt } from "../session/pendingPrompt.ts";
import { useViewEnvironment } from "../views/env.tsx";
import type { NewChatComposerProps } from "./Composer.tsx";
import { ComposerBox } from "./ComposerBox.tsx";
import { ContextChips } from "./ContextChips.tsx";
import { imagePathsOf } from "./files.ts";
import { ImageChips } from "./ImageChips.tsx";
import { NewApprovalPill } from "./NewApprovalPill.tsx";
import { enterAction, folderChoices, sessionTitle } from "./rules.ts";
import { useBranch } from "./useBranch.ts";
import { addDraftImages, type DraftImage } from "./useImages.ts";

const CREATE_FAILED = "Vera could not create the session.";
const NOT_IMAGES = "Only image files can be attached.";

export function NewChatComposer({ bridge, folder: startFolder }: NewChatComposerProps) {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const choices = folderChoices(connection.sessionRows ?? []);
    const [picked, setPicked] = useState<string | undefined>(startFolder);
    const [approvalMode, setApprovalMode] = useState<string | undefined>(undefined);
    const folder = picked ?? choices[0]?.folder;
    const [text, setText] = useState("");
    const [images, setImages] = useState<readonly DraftImage[]>([]);
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const empty = text.trim().length === 0;
    const branch = useBranch(bridge, folder);
    const { controls: models, draft } = useDraftModels(bridge, folder, !busy);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const submit = async (): Promise<void> => {
        const content = text.trim();
        if (folder === undefined || content.length === 0 || busy) return;
        setBusy(true);
        setNotice(undefined);
        const result = await createSession(bridge, folder, approvalMode);
        if (!mounted.current) return;
        if (!result.ok) {
            setNotice(result.reason);
            setBusy(false);
            return;
        }
        setPendingPrompt(result.agentId, {
            text: content,
            images: images.map((image) => image.path),
            ...(draft === undefined ? {} : { model: draft }),
        });
        navigate({ kind: "session", agentId: result.agentId, title: sessionTitle(content), workspace: result.workspace });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key !== "Enter") return;
        const action = enterAction({
            shift: event.shiftKey,
            composing: event.nativeEvent.isComposing,
            empty,
            running: false,
            queued: false,
        });
        if (action === "passthrough") return;
        event.preventDefault();
        if (action === "send") void submit();
    };

    const addPaths = (paths: readonly string[]): void => setImages((current) => addDraftImages(current, paths));
    const addFiles = (files: readonly File[]): void => {
        void imagePathsOf(bridge, files).then((paths) => {
            if (!mounted.current) return;
            if (paths.length === 0) setNotice(NOT_IMAGES);
            else addPaths(paths);
        });
    };
    const chips = images.map((image) => ({
        key: image.path,
        label: `Image ${image.number}`,
        name: image.name,
        attaching: false,
    }));

    return (
        <div className="composer-inner">
            <ContextChips
                folder={folder}
                branch={branch}
                picker={{
                    choices,
                    onPick: setPicked,
                    onOpen: () => {
                        void bridge.chooseFolder().then((chosen) => {
                            if (chosen !== undefined) setPicked(chosen);
                        });
                    },
                }}
            />
            <ImageChips chips={chips} onRemove={(path) => setImages((current) => current.filter((image) => image.path !== path))} />
            {notice === undefined ? null : <p className="composer-notice" role="status">{notice}</p>}
            <ComposerBox
                text={text}
                onText={setText}
                placeholder="Describe a task or ask a question"
                disabled={busy}
                onKeyDown={onKeyDown}
                buttonMode="send"
                buttonEnabled={folder !== undefined && !empty && !busy}
                onPress={() => void submit()}
                onFiles={addFiles}
                onPaths={addPaths}
                onAttach={() => void bridge.chooseImages().then(addPaths)}
                attachEnabled={!busy}
                barStart={<NewApprovalPill mode={approvalMode} onPick={setApprovalMode} disabled={busy} />}
                barEnd={<ModelPills controls={models} />}
            />
        </div>
    );
}

async function createSession(
    bridge: DesktopBridge,
    folder: string,
    approvalMode: string | undefined,
): Promise<CreateSessionResult> {
    try {
        return await bridge.createSession(folder, approvalMode);
    } catch {
        return { ok: false, reason: CREATE_FAILED };
    }
}

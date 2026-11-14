import type { ProviderListRequest, ProviderSaveRequest, ProviderSignInCancelRequest, ProviderSignInRequest } from "./protocol.ts";
import type { ProviderSignInService } from "../providers/provider-sign-in.ts";

type Request = ProviderListRequest | ProviderSaveRequest | ProviderSignInRequest | ProviderSignInCancelRequest;
interface Attempt { readonly requestId: string; readonly controller: AbortController; readonly done: Promise<void>; }

export class ProviderSignInCoordinator {
    private readonly attempts = new Map<string, Attempt>();
    constructor(private readonly service: ProviderSignInService) {}

    async handle(request: Request, send: (message: object) => Promise<void>, signal: AbortSignal): Promise<void> {
        try {
            if (request.type === "provider_list") {
                await send({ type: "provider_list_result", request_id: request.request_id, providers: this.service.list(), needs_setup: this.service.needsSetup() });
                return;
            }
            if (request.type === "provider_save") {
                const provider = await this.service.save({ id: request.provider, ...(request.credential === "api_key" && !request.reuse_existing ? { apiKey: request.key } : {}), custom: request.custom,
                    ...(request.reuse_existing ? { reuseExisting: true } : {}),
                    declaration: { protocol: request.protocol, base_url: request.endpoint, credential: request.credential },
                    ...(request.editing === undefined ? {} : { editing: request.editing }),
                    ...(request.replaces === undefined ? {} : { replaces: request.replaces }),
                    ...(request.shipped === undefined ? {} : { shipped: request.shipped }),
                    ...(request.restore === undefined ? {} : { restore: request.restore }) });
                await send({ type: "provider_save_result", request_id: request.request_id, provider });
                return;
            }
            if (request.type === "provider_sign_in_cancel") {
                const attempt = this.attempts.get(request.provider);
                if (attempt?.requestId === request.request_id) attempt.controller.abort();
                await send({ type: "provider_sign_in_cancelled", request_id: request.request_id });
                return;
            }
            for (;;) {
                const previous = this.attempts.get(request.provider);
                if (previous === undefined) break;
                previous.controller.abort();
                await previous.done;
            }
            signal.throwIfAborted();
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(abort, 300_000);
            let finish!: () => void;
            const done = new Promise<void>((resolve) => { finish = resolve; });
            const attempt = { requestId: request.request_id, controller, done };
            this.attempts.set(request.provider, attempt);
            try {
                let pending = Promise.resolve();
                const provider = await this.service.login(request.provider, controller.signal, (url) => {
                    pending = pending.then(() => send({ type: "provider_sign_in_url", request_id: request.request_id, url })).catch(() => controller.abort());
                });
                await pending;
                await send({ type: "provider_sign_in_result", request_id: request.request_id, provider });
            } finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                if (this.attempts.get(request.provider) === attempt) this.attempts.delete(request.provider);
                finish();
            }
        } catch (error) {
            let reason = error instanceof Error ? error.message : "Provider request failed";
            if (request.type === "provider_save" && request.key.length > 0) reason = reason.split(request.key).join("[redacted]");
            await send({ type: "provider_request_failed", request_id: request.request_id, reason }).catch(() => {});
        }
    }
}

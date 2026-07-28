import type { ModelAdapter, ModelRequest, ModelStream } from "../model/types.ts";

/**
 * How this adapter's cached client can be told apart from one built against
 * different credentials. Absent when the provider has none to speak of.
 */
export type CredentialFingerprint = (provider: string) => string | undefined;

interface CachedAdapter {
    readonly fingerprint: string | undefined;
    readonly adapter: ModelAdapter;
}

export class ProviderRoutingAdapter implements ModelAdapter {
    private readonly adapters = new Map<string, CachedAdapter>();

    constructor(
        private readonly createAdapter: (provider: string) => ModelAdapter,
        private readonly defaultProvider: string,
        defaultAdapter: ModelAdapter,
        private readonly fingerprint?: CredentialFingerprint,
    ) {
        this.adapters.set(defaultProvider, {
            fingerprint: fingerprint?.(defaultProvider),
            adapter: defaultAdapter,
        });
    }

    stream(request: ModelRequest): ModelStream {
        const provider = request.provider ?? this.defaultProvider;
        return this.adapter(provider).stream(request);
    }

    supportsImageInputFor(provider: string): boolean {
        return this.adapter(provider).supportsImageInput !== false;
    }

    prepareProvider(provider: string): void {
        this.adapter(provider);
    }

    /**
     * The cached client for a provider, rebuilt when its credentials changed.
     *
     * A client captures the key it was built with, so signing in again while an
     * agent is running would otherwise keep spending the old one until the host
     * restarted, with nothing on screen to explain it. Checking on the way past
     * makes that impossible rather than making it somebody's job to remember: a
     * scheme where whoever writes a credential must also announce it is one
     * missed call away from the same silent staleness.
     */
    private adapter(provider: string): ModelAdapter {
        const fingerprint = this.fingerprint?.(provider);
        const cached = this.adapters.get(provider);
        if (cached !== undefined && cached.fingerprint === fingerprint) {
            return cached.adapter;
        }
        const adapter = this.createAdapter(provider);
        this.adapters.set(provider, { fingerprint, adapter });
        return adapter;
    }
}

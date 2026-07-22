import type { ModelAdapter, ModelRequest, ModelStream } from "../model/types.ts";

export class ProviderRoutingAdapter implements ModelAdapter {
    private readonly adapters = new Map<string, ModelAdapter>();

    constructor(
        private readonly createAdapter: (provider: string) => ModelAdapter,
        private readonly defaultProvider: string,
        defaultAdapter: ModelAdapter,
    ) {
        this.adapters.set(defaultProvider, defaultAdapter);
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

    private adapter(provider: string): ModelAdapter {
        let adapter = this.adapters.get(provider);
        if (adapter === undefined) {
            adapter = this.createAdapter(provider);
            this.adapters.set(provider, adapter);
        }
        return adapter;
    }
}

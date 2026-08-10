/**
 * The shared OpenAI-compatible stream adapter. The implementation lives with
 * the original OpenRouter adapter for now; this name keeps native providers
 * from pretending that their requests go through OpenRouter.
 */
export {
    OpenRouterAdapter as OpenAICompatibleAdapter,
} from "./openrouter.ts";

export type {
    ChatProviderProfile,
    OpenRouterAdapterOptions as OpenAICompatibleAdapterOptions,
} from "./openrouter.ts";

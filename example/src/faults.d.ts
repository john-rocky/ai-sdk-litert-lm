import type { LiteRTLMProvider } from 'ai-sdk-litert-lm'

/**
 * A provider whose engine adds a broken tool call to the end of its real output.
 * It is how the checks reach a failure that a healthy model rarely produces.
 */
export function createProviderWithBrokenToolCall(): LiteRTLMProvider

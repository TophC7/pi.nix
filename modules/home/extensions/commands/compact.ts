import { compact, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  formatRuntimeProfileError,
  hasRuntimeProfileSettings,
  resolveRuntimeProfileModel,
  RuntimeProfileError
} from '@pi/lib/runtime-profile'
import { CONFIG_PATH, getCommandConfig } from './config'

const SOURCE = `${CONFIG_PATH} /compact`

// NOTE: Pi builds this policy from its own settings before compacting, and
// extensions cannot read those settings, so the values mirror pi's defaults
// (settings-manager.ts). Without it a dropped stream fails compaction outright
// instead of retrying. A `retry` block in settings.json would not be picked up
// here, and pi's summarization retry notifications stay silent either way.
const RETRY_POLICY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 }

/**
 * Run `/compact` on the model configured for it instead of the session model.
 *
 * Pi fires `session_before_compact` from inside its own `/compact` handler, and
 * `compact()` is the same function pi would have called, so this only swaps the
 * model and thinking level. Split-turn merging, file operations and usage
 * accounting stay identical. Auto-compaction keeps the session model, matching
 * the behavior this replaced.
 */
export function registerCompactRuntimeProfile(pi: ExtensionAPI): void {
  pi.on('session_before_compact', async (event, ctx) => {
    if (event.reason !== 'manual') return undefined

    try {
      const profile = getCommandConfig('compact')
      if (!hasRuntimeProfileSettings(profile)) return undefined

      const model = profile.model ? resolveRuntimeProfileModel(ctx, profile.model, SOURCE) : ctx.model
      if (!model) return undefined

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      if (!auth.ok) {
        throw new RuntimeProfileError(`No API key for ${model.provider}/${model.id} in ${SOURCE}: ${auth.error}`)
      }

      const compaction = await compact(
        event.preparation,
        model,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        profile.thinking ?? ctx.thinkingLevel,
        undefined,
        auth.env,
        RETRY_POLICY
      )
      return { compaction }
    } catch (error) {
      if (event.signal.aborted) return { cancel: true }
      // Returning nothing hands compaction back to pi on the session model.
      if (ctx.hasUI) ctx.ui.notify(`/compact: ${formatRuntimeProfileError(error)}`, 'error')
      return undefined
    }
  })
}

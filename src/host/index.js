/**
 * Session bridge Host plugin entry.
 *
 * The plugin runs inside the Host process and delivers through
 * `ctx.sessionController.prompt`, so a target session resumes through its own
 * preset and no external process or headless composition is involved. All
 * delivery state lives in a profile-scoped SQLite database created on first
 * activation.
 *
 * @module dsh-session-bridge
 */

import { resolveConfig } from './config.js'
import { DeliveryWorker } from './delivery.js'
import { BridgePolicy } from './policy.js'
import { BridgeStore } from './store.js'
import { registerBridgeRoutes } from './routes.js'
import { PROMPT_TEXT, registerTools } from './tools.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-bridge'

/** Host services required by the bridge. */
export const inject = ['tools', 'systemPrompt', 'sessionController']

/**
 * Activate the bridge for this profile.
 * @param {import('@deepseek-ai/dsh-api-gateway').Context} ctx - Host context.
 * @param {unknown} rawConfig - this row's `config` object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const store = new BridgeStore(config.storage.sqlitePath)
  try {
    const policy = new BridgePolicy(config, store)
    const worker = new DeliveryWorker({ ctx, config, store, policy })
    // The snapshot route is only meaningful with a Web connection; profiles
    // without one keep the tools and delivery worker running.
    ctx.inject(['connection'], connectionCtx => {
      registerBridgeRoutes(connectionCtx, { store })
    })
    ctx.effect(() => {
      const disposeTools = registerTools(ctx, { store, policy, worker, config })
      const disposePrompt = ctx.systemPrompt.section({
        name: 'tool:session-bridge',
        order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 10,
        text: PROMPT_TEXT,
      })
      worker.start()
      return async () => {
        disposePrompt()
        disposeTools()
        await worker.stop()
        store.close()
      }
    })
  } catch (error) {
    store.close()
    throw error
  }
}

/**
 * Delivery worker: one serial prompt pipeline per destination session.
 *
 * The worker owns no delivery state in memory. It claims a due message,
 * inspects passive Session state, and prompts the target through the Host's
 * `sessionController`. A claimed message is requeued on retryable failures, so
 * a restart or a cold target loses nothing; the prompt request id is the
 * message id, which makes a duplicate prompt a no-op inside the target Agent.
 *
 * @module dsh-session-bridge/delivery
 */

import { formatTime, renderEnvelope, summarize } from './envelope.js'
import { newMessageId } from './ids.js'
import { SYSTEM_ROLE } from './types.js'

/** Largest candidate window scanned by one drain pass. */
const DRAIN_BATCH = 200

/** Delivery failure raised by this worker itself. */
class BridgeDeliveryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'BridgeDeliveryError'
    this.code = code
  }
}

export class DeliveryWorker {
  #ctx
  #config
  #store
  #policy
  #now
  #random
  #logger
  #interval = null
  #kickTimer = null
  #draining = null
  #rerun = false
  #closed = false

  /**
   * @param {object} options
   * @param {import('@deepseek-ai/dsh-api-gateway').Context} options.ctx - Host context with `sessionController`.
   * @param {object} options.config - resolved configuration.
   * @param {import('./store.js').BridgeStore} options.store - durable store.
   * @param {import('./policy.js').BridgePolicy} options.policy - role resolution.
   * @param {() => number} [options.now] - clock injection for tests.
   * @param {() => number} [options.random] - jitter injection for tests.
   * @param {{ warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} [options.logger]
   */
  constructor({ ctx, config, store, policy, now = Date.now, random = Math.random, logger = console }) {
    this.#ctx = ctx
    this.#config = config
    this.#store = store
    this.#policy = policy
    this.#now = now
    this.#random = random
    this.#logger = logger
  }

  /** Begin periodic delivery and recover messages interrupted by the last process. */
  start() {
    if (this.#closed || this.#interval !== null) return
    const now = this.#now()
    const interrupted = this.#store.resetInterrupted()
    if (interrupted > 0) {
      this.#audit({ at: now, action: 'recovered', detail: `${interrupted} interrupted deliveries requeued` })
    }
    for (const id of this.#store.expireDue(now)) {
      this.#audit({ at: now, action: 'expired', messageId: id, detail: 'ttl elapsed' })
    }
    this.#store.pruneAudit(now - this.#config.storage.auditRetentionDays * 86_400_000)
    this.#interval = setInterval(() => {
      void this.drain().catch(error => this.#logger.error('session-bridge: drain failed', error))
    }, this.#config.delivery.tickMs)
    this.#interval.unref?.()
    this.kick()
  }

  /** Ask for a drain as soon as the current task yields. */
  kick() {
    if (this.#closed || this.#kickTimer !== null) return
    this.#kickTimer = setTimeout(() => {
      this.#kickTimer = null
      void this.drain().catch(error => this.#logger.error('session-bridge: drain failed', error))
    }, 0)
    this.#kickTimer.unref?.()
  }

  /** @returns {Promise<void>} resolves after the current and any queued drain pass. */
  async drain() {
    if (this.#closed) return
    if (this.#draining !== null) {
      this.#rerun = true
      return this.#draining
    }
    this.#draining = this.#runDrain()
      .catch(error => {
        this.#logger.error('session-bridge: delivery pass failed', error)
      })
      .finally(() => {
        this.#draining = null
        if (this.#rerun) {
          this.#rerun = false
          this.kick()
        }
      })
    return this.#draining
  }

  /** Stop timers and wait briefly for an in-flight delivery. */
  async stop() {
    if (this.#closed) return
    this.#closed = true
    if (this.#interval !== null) {
      clearInterval(this.#interval)
      this.#interval = null
    }
    if (this.#kickTimer !== null) {
      clearTimeout(this.#kickTimer)
      this.#kickTimer = null
    }
    if (this.#draining !== null) {
      await Promise.race([
        this.#draining,
        new Promise(resolve => {
          const timer = setTimeout(resolve, 2_000)
          timer.unref?.()
        }),
      ])
    }
  }

  async #runDrain() {
    const now = this.#now()
    for (const id of this.#store.expireDue(now)) {
      this.#audit({ at: now, action: 'expired', messageId: id, detail: 'ttl elapsed' })
    }
    const candidates = this.#store.duePending(now, DRAIN_BATCH)
    for (const message of candidates) {
      if (this.#closed) return
      const target = message.toSessionId ?? this.#policy.resolveTarget(message.toRole)?.sessionId
      if (target === undefined) {
        this.#store.deferPending(message.id, this.#now() + this.#config.delivery.unboundRoleRetryMs)
        continue
      }
      if (message.toSessionId === undefined) this.#store.setTargetSession(message.id, target)
      if (!this.#store.claim(message.id)) continue
      await this.#deliver({ ...message, toSessionId: target }, target)
    }
    if (candidates.length === DRAIN_BATCH) this.kick()
  }

  /**
   * @param {import('./types.js').BridgeMessage} message
   * @param {string} target
   */
  async #deliver(message, target) {
    const now = this.#now()
    if (message.expiresAt !== undefined && message.expiresAt <= now) {
      this.#store.markExpired(message.id, 'message expired before delivery')
      this.#audit({ at: now, action: 'expired', messageId: message.id })
      return
    }
    let state
    try {
      state = await this.#withDeadline(signal => this.#ctx.sessionController.state({ sessionId: target }, signal))
    } catch (error) {
      this.#store.recordAttempt(message.id)
      this.#handleFailure(message, target, error)
      return
    }
    if (Array.isArray(state.pendingInput) && state.pendingInput.length > 0) {
      this.#store.release(message.id, this.#now() + this.#config.delivery.pendingInputDelayMs)
      this.#audit({
        at: this.#now(),
        action: 'deferred',
        messageId: message.id,
        detail: `target has pending ${state.pendingInput.join('/')} input`,
      })
      return
    }
    this.#store.recordAttempt(message.id)
    try {
      const mode = this.#modeFor(message)
      await this.#withDeadline(signal => this.#ctx.sessionController.prompt({
        requestId: message.id,
        sessionId: target,
        mode,
        content: [{ type: 'text', text: renderEnvelope(message) }],
        clientTimeZone: this.#config.delivery.clientTimeZone,
      }, signal))
      const deliveredAt = this.#now()
      this.#store.markDelivered(message.id, deliveredAt)
      this.#audit({
        at: deliveredAt,
        action: 'delivered',
        messageId: message.id,
        toRole: message.toRole,
        toSession: target,
        detail: `mode=${mode}`,
      })
    } catch (error) {
      this.#handleFailure(message, target, error)
    }
  }

  /**
   * @param {import('./types.js').BridgeMessage} message
   * @returns {'queue' | 'steer'}
   */
  #modeFor(message) {
    if (message.priority !== 'high') return 'queue'
    return this.#policy.allowSteer(message.fromRole) ? 'steer' : 'queue'
  }

  /**
   * @param {import('./types.js').BridgeMessage} message
   * @param {string} target
   * @param {unknown} error
   */
  #handleFailure(message, target, error) {
    const failure = classify(error)
    const current = this.#store.getMessage(message.id)
    const attempts = current?.attempts ?? 1
    const now = this.#now()
    if (failure.terminal) {
      this.#store.markFailed(message.id, failure.detail)
      this.#audit({
        at: now,
        action: 'failed',
        messageId: message.id,
        toRole: message.toRole,
        toSession: target,
        detail: failure.detail,
      })
      this.#notifySender(message, failure.detail)
      return
    }
    if (attempts >= this.#config.delivery.maxAttempts) {
      const detail = `gave up after ${attempts} attempts: ${failure.detail}`
      this.#store.markFailed(message.id, detail)
      this.#audit({
        at: now,
        action: 'failed',
        messageId: message.id,
        toRole: message.toRole,
        toSession: target,
        detail,
      })
      this.#notifySender(message, detail)
      return
    }
    const nextAttemptAt = now + this.#backoff(attempts)
    this.#store.markRetry(message.id, nextAttemptAt, failure.detail)
    this.#audit({
      at: now,
      action: 'retry',
      messageId: message.id,
      toRole: message.toRole,
      toSession: target,
      detail: `${failure.detail}; next attempt at ${formatTime(nextAttemptAt)}`,
    })
  }

  /**
   * @param {number} attempts - attempts already made, starting at 1.
   * @returns {number} delay in milliseconds.
   */
  #backoff(attempts) {
    const { retryBaseMs, retryMaxMs } = this.#config.delivery
    const base = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempts - 1))
    const jitter = 0.75 + this.#random() * 0.5
    return Math.max(1, Math.round(base * jitter))
  }

  /**
   * @template T
   * @param {(signal: AbortSignal) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #withDeadline(operation) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('prompt deadline elapsed'))
    }, this.#config.delivery.promptTimeoutMs)
    timer.unref?.()
    try {
      return await operation(controller.signal)
    } catch (error) {
      if (timedOut) {
        throw new BridgeDeliveryError(
          'bridge/timeout',
          `target did not accept the prompt within ${this.#config.delivery.promptTimeoutMs} ms`,
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Queue one notice to the sender after a terminal failure.
   * @param {import('./types.js').BridgeMessage} message
   * @param {string} detail
   */
  #notifySender(message, detail) {
    if (!this.#config.delivery.notifySenderOnFailure) return
    if (message.fromRole === SYSTEM_ROLE) return
    if (message.kind === 'notice') return
    const now = this.#now()
    const content = [
      `Delivery failed for message ${message.id}.`,
      `to: ${message.toRole}${message.toSessionId === undefined ? '' : ` (${message.toSessionId})`}`,
      `thread: ${message.threadId}`,
      `reason: ${detail}`,
      `original: "${summarize(message, 200)}"`,
    ].join('\n')
    try {
      const notice = this.#store.insertMessage({
        id: newMessageId(),
        threadId: message.threadId,
        replyTo: message.id,
        fromRole: SYSTEM_ROLE,
        fromSessionId: SYSTEM_ROLE,
        toRole: message.fromRole,
        toSessionId: message.fromSessionId,
        kind: 'notice',
        priority: 'normal',
        content: content.slice(0, this.#config.limits.maxContentChars),
        metadata: undefined,
        idempotencyKey: undefined,
        status: 'pending',
        createdAt: now,
        expiresAt: now + this.#config.limits.messageTtlMs,
      })
      this.#audit({
        at: now,
        action: 'notified',
        messageId: notice.message.id,
        actorRole: SYSTEM_ROLE,
        toRole: message.fromRole,
        toSession: message.fromSessionId,
        detail: `failure notice for ${message.id}`,
      })
      this.kick()
    } catch (error) {
      this.#logger.error('session-bridge: could not queue a failure notice', error)
    }
  }

  /**
   * @param {{ at: number, action: string, messageId?: string, actorRole?: string, actorSession?: string, toRole?: string, toSession?: string, detail?: string }} event
   */
  #audit(event) {
    try {
      this.#store.audit(event)
    } catch (error) {
      this.#logger.error('session-bridge: audit write failed', error)
    }
  }
}

/**
 * Classify a delivery failure.
 * @param {unknown} error
 * @returns {{ terminal: boolean, code: string, detail: string }}
 */
export function classify(error) {
  const source = /** @type {{ code?: unknown, details?: { reason?: unknown } }} */ (
    typeof error === 'object' && error !== null ? error : {}
  )
  const code = typeof source.code === 'string' ? source.code : 'unknown'
  const reason = source.details !== undefined && typeof source.details.reason === 'string'
    ? source.details.reason
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  // The Session-domain controller reserves subagent sessions for subagent routing.
  if (code === 'session/agent-busy' && reason === 'use subagent delivery for this child session') {
    return {
      terminal: true,
      code,
      detail: `${code}: target is a subagent session; the session bridge delivers only to independent top-level sessions`,
    }
  }
  const detail = `${code}: ${message}`.replace(/\s+/g, ' ').slice(0, 400)
  return { terminal: code === 'session/not-found', code, detail }
}

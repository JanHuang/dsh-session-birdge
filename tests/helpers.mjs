import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/host/config.js'
import { buildTools } from '../src/host/tools.js'
import { DeliveryWorker } from '../src/host/delivery.js'
import { BridgePolicy } from '../src/host/policy.js'
import { BridgeStore } from '../src/host/store.js'

/**
 * Create an owned temporary directory that the test removes afterwards.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
export function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

/**
 * Resolve a test configuration pointed at a temporary database.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, unknown>} [config]
 * @returns {object}
 */
export function makeConfig(t, config = {}) {
  const sqlitePath = path.join(tempDirectory(t), 'bridge.db')
  const raw = {
    ...config,
    storage: { ...(config.storage ?? {}), sqlitePath },
    delivery: {
      clientTimeZone: 'UTC',
      tickMs: 60_000,
      ...(config.delivery ?? {}),
    },
  }
  return resolveConfig(raw, { DSH_PROFILE: 'test' })
}

/**
 * A controllable clock.
 * @param {number} [start]
 * @returns {{ now: () => number, advance: (ms: number) => void, set: (value: number) => void }}
 */
export function createClock(start = 1_000_000) {
  const state = { time: start }
  return {
    now: () => state.time,
    advance(ms) {
      state.time += ms
    },
    set(value) {
      state.time = value
    },
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function remoteError(code, message = code) {
  return Object.assign(new Error(message), { code })
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} details
 * @returns {Error & { code: string, details: Record<string, unknown> }}
 */
export function remoteErrorWithDetails(code, message, details) {
  return Object.assign(new Error(message), { code, details })
}

/**
 * Minimal `sessionController` double.
 * @returns {object}
 */
export function makeController() {
  const sessions = new Map()
  const controller = {
    /** @type {Map<string, any>} */
    states: sessions,
    /** @type {any[]} */
    prompts: [],
    /** @type {any[]} */
    sessionsList: [],
    /** @type {Error[]} */
    promptFailures: [],
    /** @type {Error[]} */
    stateFailures: [],
    async list() {
      return { items: controller.sessionsList }
    },
    async state({ sessionId }) {
      const failure = controller.stateFailures.shift()
      if (failure !== undefined) throw failure
      const entry = sessions.get(sessionId)
      if (entry === 'missing') throw remoteError('session/not-found', `session "${sessionId}" not found`)
      if (entry !== undefined) return entry
      return { cursor: 0, active: false, running: false, queue: null, pendingInput: [] }
    },
    async prompt(request) {
      const failure = controller.promptFailures.shift()
      if (failure !== undefined) throw failure
      controller.prompts.push(request)
      return { accepted: true }
    },
  }
  return controller
}

/**
 * Build a complete bridge wired to a fake session controller.
 * @param {import('node:test').TestContext} t
 * @param {{ config?: Record<string, unknown>, clock?: ReturnType<typeof createClock> }} [options]
 */
export function createBridge(t, options = {}) {
  const clock = options.clock ?? createClock()
  const config = makeConfig(t, options.config ?? {})
  const store = new BridgeStore(config.storage.sqlitePath)
  t.after(() => store.close())
  const policy = new BridgePolicy(config, store)
  const controller = makeController()
  const errors = []
  const ctx = { sessionController: controller }
  const worker = new DeliveryWorker({
    ctx,
    config,
    store,
    policy,
    now: clock.now,
    random: () => 0.5,
    logger: {
      warn() {},
      error(...args) {
        errors.push(args)
      },
    },
  })
  const tools = buildTools({ ctx, store, policy, worker, config })
  const tool = name => {
    const definition = tools.find(candidate => candidate.name === name)
    if (definition === undefined) throw new Error(`missing tool ${name}`)
    return definition
  }
  const exec = sessionId => ({
    agent: { id: sessionId },
    signal: new AbortController().signal,
    callId: 'call-test',
    name: 'test',
    arguments: {},
  })
  const call = (name, sessionId, args) => tool(name).execute(args, exec(sessionId))
  return { config, store, policy, controller, worker, tools, tool, call, exec, clock, errors }
}

/**
 * Seed one pending message directly through the store.
 * @param {ReturnType<typeof createBridge>} bridge
 * @param {Record<string, unknown>} overrides
 */
export function seedMessage(bridge, overrides = {}) {
  const now = bridge.clock.now()
  const { message } = bridge.store.insertMessage({
    id: overrides.id ?? `msg_${Math.random().toString(36).slice(2)}`,
    threadId: 'thr_seed',
    replyTo: undefined,
    fromRole: 'impl',
    fromSessionId: 'session-impl',
    toRole: 'reviewer',
    toSessionId: 'session-reviewer',
    kind: 'request',
    priority: 'normal',
    content: 'please review',
    metadata: undefined,
    idempotencyKey: undefined,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 86_400_000,
    ...overrides,
  })
  return message
}

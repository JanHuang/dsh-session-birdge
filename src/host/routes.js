/**
 * Read-only HTTP routes served to the Bridge conversation view.
 *
 * Both routes sit inside Connection's owner firewall, so only this profile's
 * authenticated browser can read them. They expose routing metadata and message
 * bodies for display; the audit log, database path, and internal errors stay on
 * the Host.
 *
 * - `/snapshot` is a one-shot JSON read used for the first paint and manual
 *   refresh.
 * - `/events` is a server-sent event stream: one `snapshot` frame on connect,
 *   then a fresh frame after every committed message change. The view appends
 *   new messages without polling.
 *
 * @module dsh-session-bridge/routes
 */

import { newMessageId, newThreadId } from './ids.js'

/** One-shot snapshot route used by the client bundle. */
export const SNAPSHOT_PATH = '/api/session-bridge/snapshot'

/** Live snapshot stream used by the client bundle. */
export const EVENTS_PATH = '/api/session-bridge/events'

/** Composer send route used by the client bundle. */
export const SEND_PATH = '/api/session-bridge/send'

/** Default and maximum messages returned in one snapshot. */
const DEFAULT_LIMIT = 300
const MAX_LIMIT = 500

/** How long a change batch waits before one rebuilt snapshot is sent. */
const CHANGE_DEBOUNCE_MS = 60

/** Comment-frame interval that keeps idle streams from being reaped. */
const KEEP_ALIVE_MS = 20_000

/**
 * Register the snapshot and event routes on an optional `connection` service.
 * @param {any} ctx - context whose `connection` is available.
 * @param {{ store: import('./store.js').BridgeStore }} deps
 */
export function registerBridgeRoutes(ctx, deps) {
  /** @type {Set<() => void>} */
  const streams = new Set()
  ctx.effect(() => {
    const disposeSnapshot = ctx.connection.fetch.register({
      path: SNAPSHOT_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleSnapshot(ctx, deps.store, request),
    })
    const disposeEvents = ctx.connection.fetch.register({
      path: EVENTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => openEventStream(ctx, deps.store, request, streams),
    })
    const disposeSend = ctx.connection.fetch.register({
      path: SEND_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleSend(ctx, deps, request),
    })
    return async () => {
      await disposeSend()
      await disposeEvents()
      await disposeSnapshot()
      for (const close of [...streams]) close()
      streams.clear()
    }
  }, 'session-bridge: routes')
}

/**
 * @param {any} ctx
 * @param {import('./store.js').BridgeStore} store
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleSnapshot(ctx, store, request) {
  const url = new URL(request.url)
  const requested = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT))
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested)))
    : DEFAULT_LIMIT
  const messages = store.recentMessages(limit)
  const items = await listSessions(ctx, request.signal)
  return Response.json({ ...buildSnapshot(messages, items, Date.now()), version: store.version }, {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Queue one request from the panel's composer.
 * @param {any} ctx
 * @param {{ store: import('./store.js').BridgeStore, policy: import('./policy.js').BridgePolicy, config: object, worker: { kick: () => void } }} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleSend(ctx, deps, request) {
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 })
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 })
  }
  const fromSessionId = typeof body?.fromSessionId === 'string' ? body.fromSessionId : ''
  const toSessionId = typeof body?.toSessionId === 'string' ? body.toSessionId : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (fromSessionId === '' || toSessionId === '') return Response.json({ error: 'fromSessionId and toSessionId are required' }, { status: 400 })
  if (fromSessionId === toSessionId) return Response.json({ error: 'a session cannot message itself' }, { status: 400 })
  if (text === '') return Response.json({ error: 'text is required' }, { status: 400 })
  if ([...text].length > deps.config.limits.maxContentChars) {
    return Response.json({ error: `text exceeds ${deps.config.limits.maxContentChars} characters` }, { status: 400 })
  }
  if (!deps.config.security.allowDirectSessionTargets) {
    return Response.json({ error: 'direct session targeting is disabled' }, { status: 403 })
  }
  const items = await listSessions(ctx, request.signal)
  const from = items.find(item => String(item.sessionId) === fromSessionId)
  const to = items.find(item => String(item.sessionId) === toSessionId)
  if (from === undefined || to === undefined) return Response.json({ error: 'session is not visible' }, { status: 404 })
  if (from.origin === 'subagent' || to.origin === 'subagent') {
    return Response.json({ error: 'subagent sessions cannot use the bridge' }, { status: 400 })
  }
  const fromRole = deps.policy.resolveCaller(fromSessionId)?.role ?? 'direct'
  const toRole = deps.policy.resolveCaller(toSessionId)?.role ?? 'direct'
  const rate = deps.policy.checkRate(fromRole)
  if (!rate.allowed) return Response.json({ error: rate.reason }, { status: 429 })
  if (deps.store.pendingTargetCount(toSessionId, toRole) >= deps.config.limits.maxPendingPerSession) {
    return Response.json({ error: 'the destination queue is full' }, { status: 429 })
  }
  const now = Date.now()
  const threadId = newThreadId()
  const { message } = deps.store.insertMessage({
    id: newMessageId(),
    threadId,
    replyTo: undefined,
    fromRole,
    fromSessionId,
    toRole,
    toSessionId,
    kind: 'request',
    priority: 'normal',
    content: text,
    metadata: undefined,
    idempotencyKey: undefined,
    status: 'pending',
    createdAt: now,
    expiresAt: now + deps.config.limits.messageTtlMs,
  })
  deps.store.audit({
    at: now,
    action: 'send',
    messageId: message.id,
    actorRole: fromRole,
    actorSession: fromSessionId,
    toRole,
    toSession: toSessionId,
    detail: `kind=request thread=${threadId} source=view`,
  })
  deps.worker.kick()
  return Response.json({ messageId: message.id, status: 'pending' }, { status: 201 })
}

/**
 * Open one server-sent event stream. The first frame is the current snapshot;
 * each committed message change schedules one coalesced replacement snapshot.
 * @param {any} ctx
 * @param {import('./store.js').BridgeStore} store
 * @param {Request} request
 * @param {Set<() => void>} streams
 * @returns {Promise<Response>}
 */
function openEventStream(ctx, store, request, streams) {
  const encoder = new TextEncoder()
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let controller
  let closed = false
  let debounce = null
  let flushing = false
  let pending = false
  /** @type {() => void} */
  let unsubscribe = () => {}
  let keepAlive = null

  const close = () => {
    if (closed) return
    closed = true
    unsubscribe()
    if (debounce !== null) clearTimeout(debounce)
    if (keepAlive !== null) clearInterval(keepAlive)
    streams.delete(close)
    try {
      controller?.close()
    } catch {
      // The bridge may already have torn down the underlying socket.
    }
  }
  /** @param {object} payload */
  const send = payload => {
    if (closed || controller === undefined) return
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
    } catch {
      close()
    }
  }
  const flush = async () => {
    if (closed) return
    if (flushing) {
      pending = true
      return
    }
    flushing = true
    try {
      const messages = store.recentMessages(MAX_LIMIT)
      const items = await listSessions(ctx, request.signal)
      if (closed) return
      send({ type: 'snapshot', ...buildSnapshot(messages, items, Date.now()), version: store.version })
    } catch (error) {
      if (request.signal.aborted) {
        close()
        return
      }
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      flushing = false
      if (pending) {
        pending = false
        schedule()
      }
    }
  }
  const schedule = () => {
    if (closed || debounce !== null) return
    debounce = setTimeout(() => {
      debounce = null
      void flush()
    }, CHANGE_DEBOUNCE_MS)
  }

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController
      unsubscribe = store.subscribe(schedule)
      streams.add(close)
      request.signal.addEventListener('abort', close, { once: true })
      keepAlive = setInterval(() => {
        if (closed || controller === undefined) return
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'))
        } catch {
          close()
        }
      }, KEEP_ALIVE_MS)
      void flush()
    },
    cancel() {
      close()
    },
  })
  return Promise.resolve(new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  }))
}

/**
 * Read the visible Session list for display labels; a failure keeps ids only.
 * @param {any} ctx
 * @param {AbortSignal} signal
 * @returns {Promise<any[]>}
 */
async function listSessions(ctx, signal) {
  try {
    const value = await ctx.sessionController.list({}, signal)
    return Array.isArray(value?.items) ? value.items : []
  } catch {
    return []
  }
}

/**
 * Group messages by session pair and attach display metadata for each session.
 *
 * One conversation is one pair of sessions. Several threads between the same
 * pair are messages of the same chat, not separate chats.
 * @param {import('./types.js').BridgeMessage[]} messages - oldest first.
 * @param {any[]} sessions - `sessionController.list` items.
 * @param {number} now
 * @returns {object}
 */
export function buildSnapshot(messages, sessions, now) {
  /** @type {Map<string, { id: string, updatedAt: number, participants: Map<string, { role: string, sessionId: string | undefined }>, threadIds: Set<string>, messages: any[] }>} */
  const conversations = new Map()
  for (const message of messages) {
    const id = pairKey(message)
    let conversation = conversations.get(id)
    if (conversation === undefined) {
      conversation = { id, updatedAt: 0, participants: new Map(), threadIds: new Set(), messages: [] }
      conversations.set(id, conversation)
    }
    conversation.messages.push(publicMessage(message))
    conversation.updatedAt = Math.max(conversation.updatedAt, message.createdAt)
    conversation.threadIds.add(message.threadId)
    setParticipant(conversation.participants, message.fromRole, message.fromSessionId)
    setParticipant(conversation.participants, message.toRole, message.toSessionId)
  }
  const sessionMap = {}
  for (const item of sessions) {
    const sessionId = String(item.sessionId)
    sessionMap[sessionId] = {
      ...(typeof item.projections?.values?.title === 'string'
        ? { title: item.projections.values.title }
        : {}),
      running: item.running === true,
    }
  }
  return {
    generatedAt: now,
    totalMessages: messages.length,
    conversations: [...conversations.values()]
      .map(conversation => ({
        id: conversation.id,
        updatedAt: conversation.updatedAt,
        participants: [...conversation.participants.values()],
        threadIds: [...conversation.threadIds],
        messages: conversation.messages,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    sessions: sessionMap,
  }
}

/**
 * Stable unordered identity for the two sides of one message.
 * @param {import('./types.js').BridgeMessage} message
 * @returns {string}
 */
function pairKey(message) {
  const from = message.fromSessionId === undefined ? `role:${message.fromRole}` : message.fromSessionId
  const to = message.toSessionId === undefined ? `role:${message.toRole}` : message.toSessionId
  return from <= to ? `${from}|${to}` : `${to}|${from}`
}

/**
 * Keep one entry per side, with the role from the latest message.
 * @param {Map<string, { role: string, sessionId: string | undefined }>} participants
 * @param {string} role
 * @param {string | undefined} sessionId
 */
function setParticipant(participants, role, sessionId) {
  const key = sessionId === undefined ? `role:${role}` : sessionId
  participants.set(key, { role, sessionId })
}

/**
 * Strip internal delivery bookkeeping from one message.
 * @param {import('./types.js').BridgeMessage} message
 * @returns {object}
 */
function publicMessage(message) {
  return {
    id: message.id,
    threadId: message.threadId,
    replyTo: message.replyTo,
    fromRole: message.fromRole,
    fromSessionId: message.fromSessionId,
    toRole: message.toRole,
    toSessionId: message.toSessionId,
    kind: message.kind,
    priority: message.priority,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt,
    readAt: message.readAt,
    ackedAt: message.ackedAt,
  }
}

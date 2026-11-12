/**
 * Read-only HTTP snapshot served to the Bridge conversation view.
 *
 * The route sits inside Connection's owner firewall, so only this profile's
 * authenticated browser can read it. It exposes routing metadata and message
 * bodies for display; the audit log, database path, and internal errors stay
 * on the Host.
 *
 * @module dsh-session-bridge/routes
 */

/** Route path used by the client bundle. */
export const SNAPSHOT_PATH = '/api/session-bridge/snapshot'

/** Default and maximum messages returned in one snapshot. */
const DEFAULT_LIMIT = 300
const MAX_LIMIT = 500

/**
 * Register the snapshot route on an optional `connection` service.
 * @param {any} ctx - context whose `connection` is available.
 * @param {{ store: import('./store.js').BridgeStore }} deps
 */
export function registerBridgeRoutes(ctx, deps) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: SNAPSHOT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => handleSnapshot(ctx, deps.store, request),
  }), 'session-bridge: snapshot route')
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
  let items = []
  try {
    const value = await ctx.sessionController.list({}, request.signal)
    items = Array.isArray(value?.items) ? value.items : []
  } catch {
    // Session labels are presentation metadata; the panel still renders ids.
  }
  return Response.json(buildSnapshot(messages, items, Date.now()), {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Group messages by thread and attach display metadata for each session.
 * @param {import('./types.js').BridgeMessage[]} messages - oldest first.
 * @param {any[]} sessions - `sessionController.list` items.
 * @param {number} now
 * @returns {object}
 */
export function buildSnapshot(messages, sessions, now) {
  /** @type {Map<string, { id: string, updatedAt: number, participants: Map<string, { role: string, sessionId: string | undefined }>, messages: any[] }>} */
  const threads = new Map()
  for (const message of messages) {
    let thread = threads.get(message.threadId)
    if (thread === undefined) {
      thread = { id: message.threadId, updatedAt: 0, participants: new Map(), messages: [] }
      threads.set(message.threadId, thread)
    }
    thread.messages.push(publicMessage(message))
    thread.updatedAt = Math.max(thread.updatedAt, message.createdAt)
    addParticipant(thread.participants, message.fromRole, message.fromSessionId)
    addParticipant(thread.participants, message.toRole, message.toSessionId)
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
    threads: [...threads.values()]
      .map(thread => ({
        id: thread.id,
        updatedAt: thread.updatedAt,
        participants: [...thread.participants.values()],
        messages: thread.messages,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    sessions: sessionMap,
  }
}

/**
 * @param {Map<string, { role: string, sessionId: string | undefined }>} participants
 * @param {string} role
 * @param {string | undefined} sessionId
 */
function addParticipant(participants, role, sessionId) {
  const key = sessionId === undefined ? `role:${role}` : sessionId
  if (!participants.has(key)) participants.set(key, { role, sessionId })
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

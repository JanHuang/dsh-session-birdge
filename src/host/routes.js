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

import { newGroupMessageId, newMessageId, newThreadId } from './ids.js'

/** One-shot snapshot route used by the client bundle. */
export const SNAPSHOT_PATH = '/api/session-bridge/snapshot'

/** Live snapshot stream used by the client bundle. */
export const EVENTS_PATH = '/api/session-bridge/events'

/** Composer send route used by the client bundle. */
export const SEND_PATH = '/api/session-bridge/send'

/** Paged conversation history used by the client bundle. */
export const HISTORY_PATH = '/api/session-bridge/history'

/** Dissolve one group from the panel. */
export const GROUP_DISSOLVE_PATH = '/api/session-bridge/group/dissolve'

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
      fetch: request => handleSnapshot(ctx, deps, request),
    })
    const disposeEvents = ctx.connection.fetch.register({
      path: EVENTS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => openEventStream(ctx, deps, request, streams),
    })
    const disposeSend = ctx.connection.fetch.register({
      path: SEND_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleSend(ctx, deps, request),
    })
    const disposeHistory = ctx.connection.fetch.register({
      path: HISTORY_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleHistory(deps.store, request),
    })
    const disposeDissolve = ctx.connection.fetch.register({
      path: GROUP_DISSOLVE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleGroupDissolve(ctx, deps, request),
    })
    return async () => {
      await disposeDissolve()
      await disposeHistory()
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
async function handleSnapshot(ctx, deps, request) {
  const url = new URL(request.url)
  const requested = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT))
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested)))
    : DEFAULT_LIMIT
  const messages = deps.store.recentMessages(limit)
  const groupMessages = deps.store.recentGroupMessages(limit)
  const groups = groupsWithMembers(deps.store, deps.policy)
  const items = await listSessions(ctx, request.signal)
  return Response.json({
    ...buildSnapshot(messages, groupMessages, groups, items, Date.now()),
    version: deps.store.version,
  }, {
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Page one conversation's history, newest page first.
 * @param {import('./store.js').BridgeStore} store
 * @param {Request} request
 * @returns {Response}
 */
function handleHistory(store, request) {
  const url = new URL(request.url)
  const groupId = url.searchParams.get('group') ?? ''
  const sessionA = url.searchParams.get('a') ?? ''
  const sessionB = url.searchParams.get('b') ?? ''
  const limitRaw = Number(url.searchParams.get('limit') ?? '20')
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.trunc(limitRaw))) : 20
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw === null ? undefined : Number(beforeRaw)
  const beforeId = url.searchParams.get('beforeId') ?? ''
  if (before !== undefined && (!Number.isFinite(before) || beforeId === '')) {
    return Response.json({ error: 'before and beforeId must be supplied together' }, { status: 400 })
  }
  if (groupId !== '') {
    const group = store.getGroup(groupId)
    if (group === null) return Response.json({ error: 'group not found' }, { status: 404 })
    const page = store.groupMessagesBefore(group.id, before, beforeId, limit)
    return Response.json({
      messages: page.messages.map(message => publicGroupMessage(store, message)),
      hasMore: page.hasMore,
    }, {
      headers: { 'cache-control': 'no-store' },
    })
  }
  if (sessionA === '' || sessionB === '' || sessionA === sessionB) {
    return Response.json({ error: 'a and b are required distinct session ids, or supply group' }, { status: 400 })
  }
  const page = store.messagesBefore(sessionA, sessionB, before, beforeId, limit)
  return Response.json({ messages: page.messages.map(publicMessage), hasMore: page.hasMore }, {
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
  const groupId = typeof body?.groupId === 'string' ? body.groupId : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (fromSessionId === '') return Response.json({ error: 'fromSessionId is required' }, { status: 400 })
  if (text === '') return Response.json({ error: 'text is required' }, { status: 400 })
  if ([...text].length > deps.config.limits.maxContentChars) {
    return Response.json({ error: `text exceeds ${deps.config.limits.maxContentChars} characters` }, { status: 400 })
  }
  if (groupId !== '') {
    const group = deps.store.getGroup(groupId)
    if (group === null) return Response.json({ error: 'group not found' }, { status: 404 })
    if (group.dissolvedAt !== undefined) return Response.json({ error: 'group is dissolved' }, { status: 409 })
    const items = await listSessions(ctx, request.signal)
    const from = items.find(item => String(item.sessionId) === fromSessionId)
    if (from === undefined) return Response.json({ error: 'session is not visible' }, { status: 404 })
    if (from.origin === 'subagent') return Response.json({ error: 'subagent sessions cannot use the chat' }, { status: 400 })
    const members = deps.store.groupMembers(group.id)
    if (!members.some(member => member.sessionId === fromSessionId)) {
      return Response.json({ error: 'this session is not a member of the group' }, { status: 403 })
    }
    const fromRole = deps.policy.resolveCaller(fromSessionId)?.role ?? 'direct'
    const rate = deps.policy.checkRate(fromRole)
    if (!rate.allowed) return Response.json({ error: rate.reason }, { status: 429 })
    const recipients = members
      .filter(member => member.sessionId !== fromSessionId)
      .map(member => ({
        sessionId: member.sessionId,
        role: deps.policy.resolveCaller(member.sessionId)?.role ?? 'direct',
      }))
    for (const recipient of recipients) {
      if (deps.store.pendingTargetCount(recipient.sessionId, recipient.role) >= deps.config.limits.maxPendingPerSession) {
        return Response.json({ error: `session ${recipient.sessionId} queue is full` }, { status: 429 })
      }
    }
    const now = Date.now()
    const { groupMessage, deliveries } = deps.store.insertGroupMessage({
      id: newGroupMessageId(),
      groupId: group.id,
      fromRole,
      fromSessionId,
      content: text,
      kind: 'request',
      threadId: `group:${group.id}`,
      metadata: undefined,
      createdAt: now,
      priority: 'normal',
      expiresAt: now + deps.config.limits.messageTtlMs,
      recipients,
    })
    deps.store.audit({
      at: now,
      action: 'group_send',
      messageId: groupMessage.id,
      actorRole: fromRole,
      actorSession: fromSessionId,
      toRole: 'group',
      toSession: group.id,
      detail: `kind=request source=view recipients=${deliveries.length}`,
    })
    deps.worker.kick()
    return Response.json({ groupMessageId: groupMessage.id, recipients: deliveries.length }, { status: 201 })
  }
  if (toSessionId === '') return Response.json({ error: 'toSessionId or groupId is required' }, { status: 400 })
  if (fromSessionId === toSessionId) return Response.json({ error: 'a session cannot message itself' }, { status: 400 })
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
 * Dissolve one group from the panel.
 * @param {any} ctx
 * @param {{ store: import('./store.js').BridgeStore, policy: import('./policy.js').BridgePolicy }} deps
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleGroupDissolve(ctx, deps, request) {
  if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 })
  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 })
  }
  const fromSessionId = typeof body?.fromSessionId === 'string' ? body.fromSessionId : ''
  const groupId = typeof body?.groupId === 'string' ? body.groupId : ''
  if (fromSessionId === '' || groupId === '') {
    return Response.json({ error: 'fromSessionId and groupId are required' }, { status: 400 })
  }
  const group = deps.store.getGroup(groupId)
  if (group === null) return Response.json({ error: 'group not found' }, { status: 404 })
  if (group.dissolvedAt !== undefined) return Response.json({ error: 'group is already dissolved' }, { status: 409 })
  const items = await listSessions(ctx, request.signal)
  const from = items.find(item => String(item.sessionId) === fromSessionId)
  if (from === undefined) return Response.json({ error: 'session is not visible' }, { status: 404 })
  if (from.origin === 'subagent') return Response.json({ error: 'subagent sessions cannot use the chat' }, { status: 400 })
  const callerRole = deps.policy.resolveCaller(fromSessionId)?.role
  if (group.createdBySession !== fromSessionId && callerRole !== 'lead') {
    return Response.json({ error: 'only the group creator or the lead role may dissolve it' }, { status: 403 })
  }
  const now = Date.now()
  const result = deps.store.dissolveGroup(group.id, now)
  if (!result.dissolved) return Response.json({ error: 'group is already dissolved' }, { status: 409 })
  deps.store.audit({
    at: now,
    action: 'group_dissolve',
    actorSession: fromSessionId,
    actorRole: callerRole,
    toSession: group.id,
    detail: `name="${group.name}" removed_members=${result.removedMembers} source=view messages_preserved=true`,
  })
  return Response.json({ dissolved: true, removedMembers: result.removedMembers }, { status: 200 })
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
function openEventStream(ctx, deps, request, streams) {
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
      const messages = deps.store.recentMessages(MAX_LIMIT)
      const groupMessages = deps.store.recentGroupMessages(MAX_LIMIT)
      const groups = groupsWithMembers(deps.store, deps.policy)
      const items = await listSessions(ctx, request.signal)
      if (closed) return
      send({ type: 'snapshot', ...buildSnapshot(messages, groupMessages, groups, items, Date.now()), version: deps.store.version })
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
      unsubscribe = deps.store.subscribe(schedule)
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
export function buildSnapshot(messages, groupMessages, groups, sessions, now) {
  /** @type {Map<string, any>} */
  const conversations = new Map()
  for (const message of messages) {
    const id = pairKey(message)
    let conversation = conversations.get(id)
    if (conversation === undefined) {
      conversation = {
        id, kind: 'direct', updatedAt: 0, participants: new Map(), threadIds: new Set(), messages: [],
      }
      conversations.set(id, conversation)
    }
    conversation.messages.push(publicMessage(message))
    conversation.updatedAt = Math.max(conversation.updatedAt, message.createdAt)
    conversation.threadIds.add(message.threadId)
    setParticipant(conversation.participants, message.fromRole, message.fromSessionId)
    setParticipant(conversation.participants, message.toRole, message.toSessionId)
  }
  const groupById = new Map(groups.map(group => [group.id, group]))
  for (const message of groupMessages) {
    const group = groupById.get(message.groupId)
    if (group === undefined) continue
    const id = `group:${message.groupId}`
    let conversation = conversations.get(id)
    if (conversation === undefined) {
      conversation = {
        id,
        kind: 'group',
        groupId: message.groupId,
        title: group.name,
        updatedAt: 0,
        members: group.members,
        participants: group.members.map(member => ({ role: member.role, sessionId: member.sessionId })),
        threadIds: new Set(),
        messages: [],
      }
      conversations.set(id, conversation)
    }
    conversation.messages.push(publicGroupMessageRaw(message, group.name))
    conversation.updatedAt = Math.max(conversation.updatedAt, message.createdAt)
    conversation.threadIds.add(message.threadId)
  }
  for (const group of groups) {
    const id = `group:${group.id}`
    if (conversations.has(id)) continue
    conversations.set(id, {
      id,
      kind: 'group',
      groupId: group.id,
      title: group.name,
      updatedAt: group.updatedAt,
      members: group.members,
      participants: group.members.map(member => ({ role: member.role, sessionId: member.sessionId })),
      threadIds: new Set(),
      messages: [],
    })
  }
  const sessionMap = {}
  for (const item of sessions) {
    const sessionId = String(item.sessionId)
    sessionMap[sessionId] = {
      ...(typeof item.projections?.values?.title === 'string'
        ? { title: item.projections.values.title }
        : {}),
      running: item.running === true,
      ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    }
  }
  return {
    generatedAt: now,
    totalMessages: messages.length + groupMessages.length,
    conversations: [...conversations.values()]
      .map(conversation => ({
        id: conversation.id,
        kind: conversation.kind,
        updatedAt: conversation.updatedAt,
        participants: [...conversation.participants.values()],
        threadIds: [...conversation.threadIds],
        messages: conversation.messages,
        ...(conversation.kind === 'group'
          ? {
            groupId: conversation.groupId,
            title: conversation.title,
            members: conversation.members,
          }
          : {}),
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    sessions: sessionMap,
  }
}

/**
 * @param {import('./store.js').BridgeStore} store
 * @param {import('./policy.js').BridgePolicy} policy
 * @returns {Array<object>}
 */
function groupsWithMembers(store, policy) {
  return store.listGroups().map(group => ({
    ...group,
    members: store.groupMembers(group.id).map(member => ({
      sessionId: member.sessionId,
      role: policy.resolveCaller(member.sessionId)?.role ?? 'direct',
    })),
  }))
}

/**
 * @param {object} message
 * @param {string} groupName
 * @returns {object}
 */
function publicGroupMessageRaw(message, groupName) {
  return {
    id: message.id,
    threadId: message.threadId,
    replyTo: message.replyTo,
    fromRole: message.fromRole,
    fromSessionId: message.fromSessionId,
    toRole: 'group',
    toSessionId: undefined,
    kind: message.kind,
    priority: 'normal',
    content: message.content,
    status: 'delivered',
    createdAt: message.createdAt,
    groupId: message.groupId,
    groupName,
  }
}

/**
 * @param {import('./store.js').BridgeStore} store
 * @param {object} message
 * @returns {object}
 */
function publicGroupMessage(store, message) {
  return publicGroupMessageRaw(message, store.getGroup(message.groupId)?.name ?? '')
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
    groupId: message.groupId,
    groupMessageId: message.groupMessageId,
  }
}

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { buildSnapshot, EVENTS_PATH, HISTORY_PATH, registerBridgeRoutes, SEND_PATH, SNAPSHOT_PATH } from '../src/host/routes.js'
import { BridgeStore } from '../src/host/store.js'
import { seedMessage, tempDirectory } from './helpers.mjs'

function message(overrides) {
  return {
    id: 'msg_1',
    threadId: 'thr_1',
    replyTo: undefined,
    fromRole: 'lead',
    fromSessionId: 'session-lead',
    toRole: 'direct',
    toSessionId: 'session-target',
    kind: 'request',
    priority: 'normal',
    content: 'hello',
    status: 'delivered',
    createdAt: 1_000_000,
    ...overrides,
  }
}

test('buildSnapshot groups every thread of one session pair into one conversation', () => {
  const snapshot = buildSnapshot([
    message({ id: 'a', createdAt: 10 }),
    message({
      id: 'b',
      createdAt: 20,
      threadId: 'thr_2',
      fromRole: 'direct',
      fromSessionId: 'session-target',
      toRole: 'lead',
      toSessionId: 'session-lead',
      kind: 'reply',
    }),
    message({ id: 'c', createdAt: 30 }),
    message({
      id: 'd',
      createdAt: 40,
      threadId: 'thr_3',
      fromRole: 'reviewer',
      fromSessionId: 'session-reviewer',
      toRole: 'lead',
      toSessionId: 'session-lead',
    }),
  ], [
    {
      sessionId: 'session-lead',
      running: true,
      cwd: '/work',
      projections: { values: { title: 'Lead session' } },
    },
    { sessionId: 'session-target', cwd: '/target' },
    { sessionId: 'session-reviewer' },
  ], 1_234)

  assert.equal(snapshot.generatedAt, 1_234)
  assert.equal(snapshot.totalMessages, 4)
  assert.deepEqual(snapshot.conversations.map(conversation => conversation.id), [
    'session-lead|session-reviewer',
    'session-lead|session-target',
  ])
  const target = snapshot.conversations[1]
  assert.deepEqual(target.messages.map(entry => entry.id), ['a', 'b', 'c'])
  assert.deepEqual(target.threadIds, ['thr_1', 'thr_2'])
  assert.deepEqual(target.participants, [
    { role: 'lead', sessionId: 'session-lead' },
    { role: 'direct', sessionId: 'session-target' },
  ])
  assert.equal(snapshot.sessions['session-lead'].title, 'Lead session')
  assert.equal(snapshot.sessions['session-lead'].running, true)
  assert.equal(snapshot.sessions['session-lead'].cwd, '/work')
  assert.equal(snapshot.sessions['session-target'].title, undefined)
})

test('buildSnapshot keeps role-only participants for an unbound destination', () => {
  const snapshot = buildSnapshot([
    message({ id: 'x', toRole: 'reviewer', toSessionId: undefined }),
  ], [], 1)
  assert.equal(snapshot.conversations.length, 1)
  assert.deepEqual(snapshot.conversations[0].participants, [
    { role: 'lead', sessionId: 'session-lead' },
    { role: 'reviewer', sessionId: undefined },
  ])
})

function fakeRoutes(store) {
  const routes = new Map()
  const kicks = { count: 0 }
  const ctx = {
    connection: {
      fetch: {
        register: registration => {
          routes.set(registration.path, registration)
          return async () => {}
        },
      },
    },
    effect: execute => execute(),
    sessionController: {
      list: async () => ({
        items: [
          { sessionId: 'session-lead' },
          { sessionId: 'session-reviewer', projections: { values: { title: 'Reviewer' } } },
        ],
      }),
    },
  }
  registerBridgeRoutes(ctx, {
    store,
    config: {
      security: { allowDirectSessionTargets: true },
      limits: { maxContentChars: 8_000, maxPendingPerSession: 50, messageTtlMs: 86_400_000 },
    },
    policy: {
      resolveCaller: () => null,
      checkRate: () => ({ allowed: true }),
    },
    worker: { kick: () => { kicks.count += 1 } },
  })
  return { routes, kicks }
}

test('the snapshot route reads messages and session labels', async t => {
  const store = new BridgeStore(path.join(tempDirectory(t), 'routes.db'))
  t.after(() => store.close())
  seedMessage({ store, clock: { now: () => 1_000_000 } }, { id: 'msg_route', content: 'route body' })
  const { routes } = fakeRoutes(store)
  const route = routes.get(SNAPSHOT_PATH)
  assert.deepEqual(route.methods, ['GET'])

  const response = await route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/snapshot?limit=10'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.totalMessages, 1)
  assert.equal(body.version, store.version)
  assert.equal(body.conversations[0].messages[0].id, 'msg_route')
  assert.equal(body.sessions['session-reviewer'].title, 'Reviewer')
})

test('the event route streams an initial snapshot and pushes new messages', async t => {
  const store = new BridgeStore(path.join(tempDirectory(t), 'routes.db'))
  t.after(() => store.close())
  const { routes } = fakeRoutes(store)
  const route = routes.get(EVENTS_PATH)
  assert.deepEqual(route.methods, ['GET'])

  const abort = new AbortController()
  const response = await route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/events', {
    signal: abort.signal,
  }))
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const readFrame = async () => {
    for (;;) {
      const index = buffer.indexOf('\n\n')
      if (index !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = block.split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data !== '') return JSON.parse(data)
        continue
      }
      const { done, value } = await reader.read()
      if (done) throw new Error('event stream ended')
      buffer += decoder.decode(value, { stream: true })
    }
  }

  const initial = await readFrame()
  assert.equal(initial.type, 'snapshot')
  assert.equal(initial.totalMessages, 0)
  assert.equal(initial.version, store.version)

  seedMessage({ store, clock: { now: () => 1_000_000 } }, { id: 'msg_live' })
  const update = await readFrame()
  assert.equal(update.type, 'snapshot')
  assert.equal(update.totalMessages, 1)
  assert.equal(update.conversations[0].messages[0].id, 'msg_live')

  abort.abort()
  await reader.cancel().catch(() => {})
})


test('the send route queues one request and kicks delivery', async t => {
  const store = new BridgeStore(path.join(tempDirectory(t), 'routes.db'))
  t.after(() => store.close())
  const { routes, kicks } = fakeRoutes(store)
  const route = routes.get(SEND_PATH)
  assert.deepEqual(route.methods, ['POST'])

  const response = await route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromSessionId: 'session-lead',
      toSessionId: 'session-reviewer',
      text: 'hello from the view',
    }),
  }))
  assert.equal(response.status, 201)
  const body = await response.json()
  assert.equal(body.status, 'pending')
  const stored = store.getMessage(body.messageId)
  assert.equal(stored.content, 'hello from the view')
  assert.equal(stored.toSessionId, 'session-reviewer')
  assert.equal(kicks.count, 1)
})

test('the send route rejects invalid requests', async t => {
  const store = new BridgeStore(path.join(tempDirectory(t), 'routes.db'))
  t.after(() => store.close())
  const { routes } = fakeRoutes(store)
  const route = routes.get(SEND_PATH)
  const send = body => route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  assert.equal((await send({ fromSessionId: 'session-lead', toSessionId: 'session-lead', text: 'x' })).status, 400)
  assert.equal((await send({ fromSessionId: 'session-lead', toSessionId: 'session-reviewer', text: '   ' })).status, 400)
  assert.equal((await send({ fromSessionId: 'session-lead', toSessionId: 'missing', text: 'x' })).status, 404)
})


test('the history route pages a conversation twenty at a time', async t => {
  const store = new BridgeStore(path.join(tempDirectory(t), 'routes.db'))
  t.after(() => store.close())
  for (let index = 0; index < 25; index++) {
    seedMessage({ store, clock: { now: () => 1_000_000 + index } }, {
      id: `hist_${String(index).padStart(2, '0')}`,
      createdAt: 1_000_000 + index,
    })
  }
  const { routes } = fakeRoutes(store)
  const route = routes.get(HISTORY_PATH)
  assert.deepEqual(route.methods, ['GET'])

  const response = await route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/history?a=session-impl&b=session-reviewer&limit=20'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.messages.length, 20)
  assert.equal(body.hasMore, true)
  assert.equal(body.messages[0].id, 'hist_05')
  assert.equal(body.messages[19].id, 'hist_24')

  const next = await route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/history?a=session-impl&b=session-reviewer&limit=20&before=1000005&beforeId=hist_05'))
  const nextBody = await next.json()
  assert.equal(nextBody.messages.length, 5)
  assert.equal(nextBody.hasMore, false)
  assert.equal(nextBody.messages[0].id, 'hist_00')
})

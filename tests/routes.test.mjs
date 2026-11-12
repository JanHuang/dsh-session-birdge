import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { buildSnapshot, registerBridgeRoutes } from '../src/host/routes.js'
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

test('buildSnapshot groups threads, dedupes participants, and labels sessions', () => {
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
  ], [
    {
      sessionId: 'session-lead',
      running: true,
      cwd: '/work',
      projections: { values: { title: 'Lead session' } },
    },
    { sessionId: 'session-target', cwd: '/target' },
  ], 1_234)

  assert.equal(snapshot.generatedAt, 1_234)
  assert.equal(snapshot.totalMessages, 3)
  assert.deepEqual(snapshot.threads.map(thread => thread.id), ['thr_1', 'thr_2'])
  const first = snapshot.threads[0]
  assert.deepEqual(first.messages.map(entry => entry.id), ['a', 'c'])
  assert.deepEqual(first.participants, [
    { role: 'lead', sessionId: 'session-lead' },
    { role: 'direct', sessionId: 'session-target' },
  ])
  assert.equal(snapshot.sessions['session-lead'].title, 'Lead session')
  assert.equal(snapshot.sessions['session-lead'].running, true)
  assert.equal(snapshot.sessions['session-target'].title, undefined)
})

test('buildSnapshot keeps role-only participants for an unbound destination', () => {
  const snapshot = buildSnapshot([
    message({ id: 'x', toRole: 'reviewer', toSessionId: undefined }),
  ], [], 1)
  assert.deepEqual(snapshot.threads[0].participants, [
    { role: 'lead', sessionId: 'session-lead' },
    { role: 'reviewer', sessionId: undefined },
  ])
})

test('the snapshot route reads messages and session labels', async t => {
  const store = new BridgeStore(path.join(tempDirectory(t), 'routes.db'))
  t.after(() => store.close())
  seedMessage({ store, clock: { now: () => 1_000_000 } }, { id: 'msg_route', content: 'route body' })

  let route
  const ctx = {
    connection: {
      fetch: {
        register: registration => {
          route = registration
          return async () => {}
        },
      },
    },
    effect: execute => execute(),
    sessionController: {
      list: async () => ({
        items: [{ sessionId: 'session-reviewer', projections: { values: { title: 'Reviewer' } } }],
      }),
    },
  }
  registerBridgeRoutes(ctx, { store })
  assert.equal(route.path, '/api/session-bridge/snapshot')
  assert.deepEqual(route.methods, ['GET'])

  const response = await route.fetch(new Request('http://127.0.0.1:1/api/session-bridge/snapshot?limit=10'))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.totalMessages, 1)
  assert.equal(body.threads[0].messages[0].id, 'msg_route')
  assert.equal(body.sessions['session-reviewer'].title, 'Reviewer')
})

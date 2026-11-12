import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteError, remoteErrorWithDetails, createBridge, seedMessage } from './helpers.mjs'

const LIVE_IDLE = Object.freeze({ cursor: 4, active: true, running: false, queue: [], pendingInput: [] })

function bindAll(bridge, extra = {}) {
  const now = bridge.clock.now()
  for (const [role, sessionId] of Object.entries({
    impl: 'session-impl',
    reviewer: 'session-reviewer',
    designer: 'session-designer',
    lead: 'session-lead',
    ...extra,
  })) {
    bridge.store.setRoleBinding(role, sessionId, undefined, now)
  }
  bridge.controller.states.set('session-reviewer', { ...LIVE_IDLE })
  bridge.controller.states.set('session-impl', { ...LIVE_IDLE })
  bridge.controller.states.set('session-designer', { ...LIVE_IDLE })
  bridge.controller.states.set('session-lead', { ...LIVE_IDLE })
}

test('a queued message becomes one prompt with a generated envelope', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  const message = seedMessage(bridge)
  await bridge.worker.drain()
  assert.equal(bridge.store.getMessage(message.id).status, 'delivered')
  assert.equal(bridge.store.getMessage(message.id).attempts, 1)
  assert.equal(bridge.controller.prompts.length, 1)
  const [prompt] = bridge.controller.prompts
  assert.equal(prompt.requestId, message.id)
  assert.equal(prompt.sessionId, 'session-reviewer')
  assert.equal(prompt.mode, 'queue')
  assert.equal(prompt.clientTimeZone, 'UTC')
  assert.deepEqual(prompt.content.map(part => part.type), ['text'])
  const text = prompt.content[0].text
  assert.match(text, /^\[session-bridge\]\n/)
  assert.match(text, /from: impl \(session-impl\)/)
  assert.match(text, /to: reviewer/)
  assert.match(text, /kind: request/)
  assert.match(text, new RegExp(`messageId: ${message.id}`))
  assert.match(text, /thread: thr_seed/)
  assert.match(text, /untrusted data/)
  assert.match(text, /session_reply with messageId/)
})

test('a running target still receives a queued prompt', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  bridge.controller.states.set('session-reviewer', { ...LIVE_IDLE, running: true, queue: [{ id: 'x' }] })
  const message = seedMessage(bridge)
  await bridge.worker.drain()
  assert.equal(bridge.controller.prompts.length, 1)
  assert.equal(bridge.controller.prompts[0].mode, 'queue')
  assert.equal(bridge.store.getMessage(message.id).status, 'delivered')
})

test('pending approval input defers without counting an attempt', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  bridge.controller.states.set('session-reviewer', { ...LIVE_IDLE, pendingInput: ['approval'] })
  const message = seedMessage(bridge)
  const startedAt = bridge.clock.now()
  await bridge.worker.drain()
  const stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.attempts, 0)
  assert.equal(stored.nextAttemptAt, startedAt + 30_000)
  assert.equal(bridge.controller.prompts.length, 0)
})

test('a missing target fails the message and queues a notice to the sender', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  bridge.controller.states.set('session-reviewer', 'missing')
  const message = seedMessage(bridge)
  await bridge.worker.drain()
  const stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'failed')
  assert.match(stored.lastError, /session\/not-found/)
  const pending = bridge.store.duePending(bridge.clock.now(), 10)
  const notice = pending.find(candidate => candidate.fromRole === 'session-bridge')
  assert.ok(notice, 'a failure notice should be queued')
  assert.equal(notice.toRole, 'impl')
  assert.equal(notice.toSessionId, 'session-impl')
  assert.equal(notice.replyTo, message.id)
  assert.match(notice.content, /Delivery failed/)
})

test('a transient failure retries with backoff and then delivers', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  bridge.controller.promptFailures.push(remoteError('session/agent-busy', 'turn already running'))
  const message = seedMessage(bridge)
  const startedAt = bridge.clock.now()
  await bridge.worker.drain()
  let stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.attempts, 1)
  assert.equal(stored.nextAttemptAt, startedAt + 2_000)
  assert.match(stored.lastError, /agent-busy/)

  bridge.clock.advance(2_000)
  await bridge.worker.drain()
  stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'delivered')
  assert.equal(stored.attempts, 2)
  assert.equal(bridge.controller.prompts.length, 1)
})

test('exhausted attempts fail and notify the sender', async t => {
  const bridge = createBridge(t, { config: { delivery: { maxAttempts: 2 } } })
  bindAll(bridge)
  bridge.controller.promptFailures.push(remoteError('session/writer-held', 'writer held'))
  bridge.controller.promptFailures.push(remoteError('session/writer-held', 'writer held'))
  const message = seedMessage(bridge)
  await bridge.worker.drain()
  assert.equal(bridge.store.getMessage(message.id).status, 'pending')
  bridge.clock.advance(5_000)
  await bridge.worker.drain()
  const stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'failed')
  assert.match(stored.lastError, /gave up after 2 attempts/)
  assert.ok(bridge.store.duePending(bridge.clock.now(), 10).some(entry => entry.replyTo === message.id))
})

test('an unbound destination waits, then delivers once the role binds', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  const message = seedMessage(bridge, { toRole: 'deployer', toSessionId: undefined })
  const startedAt = bridge.clock.now()
  await bridge.worker.drain()
  let stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.attempts, 0)
  assert.equal(stored.nextAttemptAt, startedAt + 30_000)
  assert.equal(bridge.controller.prompts.length, 0)

  bridge.store.setRoleBinding('deployer', 'session-designer', undefined, startedAt)
  bridge.clock.advance(30_000)
  await bridge.worker.drain()
  stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'delivered')
  assert.equal(stored.toSessionId, 'session-designer')
})

test('high priority steers only for an allowed role', async t => {
  const steering = createBridge(t)
  bindAll(steering)
  const first = seedMessage(steering, { fromRole: 'lead', fromSessionId: 'session-lead', priority: 'high' })
  await steering.worker.drain()
  assert.equal(steering.controller.prompts[0].mode, 'steer')
  assert.equal(steering.store.getMessage(first.id).status, 'delivered')

  const queued = createBridge(t)
  bindAll(queued)
  seedMessage(queued, { priority: 'high' })
  await queued.worker.drain()
  assert.equal(queued.controller.prompts[0].mode, 'queue')
})

test('an expired message is never prompted', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  const message = seedMessage(bridge, { expiresAt: bridge.clock.now() - 1 })
  await bridge.worker.drain()
  assert.equal(bridge.store.getMessage(message.id).status, 'expired')
  assert.equal(bridge.controller.prompts.length, 0)
})

test('start recovers interrupted deliveries', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  const message = seedMessage(bridge)
  bridge.store.claim(message.id)
  bridge.worker.start()
  t.after(async () => bridge.worker.stop())
  assert.equal(bridge.store.getMessage(message.id).status, 'pending')
  await bridge.worker.drain()
  assert.equal(bridge.store.getMessage(message.id).status, 'delivered')
})


test('a subagent-owned target fails terminally instead of retrying', async t => {
  const bridge = createBridge(t)
  bindAll(bridge)
  bridge.controller.promptFailures.push(remoteErrorWithDetails(
    'session/agent-busy',
    'session "session-reviewer" is owned by subagent routing',
    { reason: 'use subagent delivery for this child session' },
  ))
  const message = seedMessage(bridge)
  await bridge.worker.drain()
  const stored = bridge.store.getMessage(message.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.attempts, 1)
  assert.match(stored.lastError, /subagent session/)
  const notice = bridge.store.duePending(bridge.clock.now(), 10)
    .find(candidate => candidate.replyTo === message.id)
  assert.ok(notice, 'the sender should be notified')
  assert.match(notice.content, /subagent session/)
})

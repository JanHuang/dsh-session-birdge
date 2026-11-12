import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { BridgeStore } from '../src/host/store.js'
import { seedMessage, tempDirectory } from './helpers.mjs'

function freshStore(t) {
  const store = new BridgeStore(path.join(tempDirectory(t), 'store.db'))
  t.after(() => store.close())
  return store
}

function base(overrides = {}) {
  const now = 1_000_000
  return {
    id: 'msg_1',
    threadId: 'thr_1',
    replyTo: undefined,
    fromRole: 'impl',
    fromSessionId: 'session-impl',
    toRole: 'reviewer',
    toSessionId: 'session-reviewer',
    kind: 'request',
    priority: 'normal',
    content: 'hello',
    metadata: undefined,
    idempotencyKey: undefined,
    status: 'pending',
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  }
}

test('messages round-trip and metadata survives JSON encoding', t => {
  const store = freshStore(t)
  const { message, inserted } = store.insertMessage(base({ metadata: { pr: 36 } }))
  assert.equal(inserted, true)
  assert.deepEqual(message.metadata, { pr: 36 })
  assert.equal(store.getMessage('msg_1').content, 'hello')
})

test('an idempotency key returns the original message instead of a duplicate', t => {
  const store = freshStore(t)
  store.insertMessage(base({ idempotencyKey: 'review-36' }))
  const second = store.insertMessage(base({ id: 'msg_2', idempotencyKey: 'review-36' }))
  assert.equal(second.inserted, false)
  assert.equal(second.message.id, 'msg_1')
  assert.equal(store.findByIdempotencyKey('review-36').id, 'msg_1')
})

test('claim is exclusive and release makes a message due again', t => {
  const store = freshStore(t)
  store.insertMessage(base())
  assert.equal(store.claim('msg_1'), true)
  assert.equal(store.claim('msg_1'), false)
  assert.deepEqual(store.duePending(1_000_000, 10), [])
  store.release('msg_1', 1_000_000)
  assert.equal(store.duePending(1_000_000, 10).length, 1)
  store.claim('msg_1')
  store.recordAttempt('msg_1')
  store.markDelivered('msg_1', 1_000_500)
  assert.equal(store.getMessage('msg_1').status, 'delivered')
  assert.equal(store.getMessage('msg_1').attempts, 1)
  assert.equal(store.getMessage('msg_1').deliveredAt, 1_000_500)
})

test('due ordering prefers high priority and respects the retry time', t => {
  const store = freshStore(t)
  store.insertMessage(base({ id: 'low', priority: 'low', createdAt: 1 }))
  store.insertMessage(base({ id: 'high', priority: 'high', createdAt: 2 }))
  store.insertMessage(base({ id: 'normal', priority: 'normal', createdAt: 3 }))
  store.insertMessage(base({ id: 'later', toRole: 'designer', toSessionId: 'session-designer' }))
  store.claim('later')
  store.release('later', 9_999_999)
  assert.deepEqual(store.duePending(1_000_000, 10).map(message => message.id), ['high', 'normal', 'low'])
})

test('expiry closes only pending messages', t => {
  const store = freshStore(t)
  store.insertMessage(base({ id: 'fresh', expiresAt: 2_000_000 }))
  store.insertMessage(base({ id: 'stale', expiresAt: 999_999 }))
  store.claim('fresh')
  const expired = store.expireDue(1_500_000)
  assert.deepEqual(expired, ['stale'])
  assert.equal(store.getMessage('stale').status, 'expired')
  assert.equal(store.getMessage('fresh').status, 'delivering')
})

test('interrupted deliveries are requeued', t => {
  const store = freshStore(t)
  store.insertMessage(base())
  store.claim('msg_1')
  assert.equal(store.resetInterrupted(), 1)
  assert.equal(store.getMessage('msg_1').status, 'pending')
})

test('inbox ordering, read state, and acknowledgement', t => {
  const store = freshStore(t)
  store.insertMessage(base({ id: 'a', toSessionId: 'session-reviewer', priority: 'normal', createdAt: 1 }))
  store.insertMessage(base({ id: 'b', toSessionId: 'session-reviewer', priority: 'high', createdAt: 2 }))
  for (const id of ['a', 'b']) {
    store.claim(id)
    store.markDelivered(id, 10)
  }
  assert.deepEqual(store.inbox('session-reviewer', { limit: 10, includeRead: false }).map(m => m.id), ['b', 'a'])
  assert.equal(store.unreadCount('session-reviewer'), 2)
  assert.equal(store.markRead(['a'], 20), 1)
  assert.deepEqual(store.inbox('session-reviewer', { limit: 10, includeRead: false }).map(m => m.id), ['b'])
  assert.deepEqual(store.inbox('session-reviewer', { limit: 10, includeRead: true }).map(m => m.id), ['b', 'a'])
  store.markAcked('a', 30)
  assert.equal(store.getMessage('a').status, 'acked')
  assert.equal(store.getMessage('a').ackedAt, 30)
  assert.deepEqual(store.inbox('session-reviewer', { limit: 10, includeRead: true }).map(m => m.id), ['b'])
})

test('a session holds at most one role binding', t => {
  const store = freshStore(t)
  store.setRoleBinding('impl', 'session-a', undefined, 1)
  store.setRoleBinding('reviewer', 'session-a', undefined, 2)
  assert.equal(store.getRoleBinding('impl'), null)
  assert.equal(store.getRoleBinding('reviewer').sessionId, 'session-a')
  assert.equal(store.findRoleBySession('session-a').role, 'reviewer')
  assert.equal(store.listRoleBindings().length, 1)
})

test('deferred messages stay pending until their retry time', t => {
  const store = freshStore(t)
  store.insertMessage(base())
  store.deferPending('msg_1', 1_050_000)
  assert.equal(store.duePending(1_000_000, 10).length, 0)
  assert.equal(store.duePending(1_050_000, 10).length, 1)
  assert.equal(store.getMessage('msg_1').status, 'pending')
})

test('pending target capacity counts pending and delivering rows', t => {
  const store = freshStore(t)
  store.insertMessage(base({ id: 'one' }))
  store.insertMessage(base({ id: 'two' }))
  store.insertMessage(base({ id: 'unbound', toSessionId: undefined }))
  assert.equal(store.pendingTargetCount('session-reviewer', 'reviewer'), 2)
  store.claim('one')
  store.markDelivered('one', 5)
  assert.equal(store.pendingTargetCount('session-reviewer', 'reviewer'), 1)
  assert.equal(store.pendingTargetCount('', 'reviewer'), 1)
})

test('audit rows are bounded by retention', t => {
  const store = freshStore(t)
  store.audit({ at: 10, action: 'send', messageId: 'msg_1' })
  store.audit({ at: 100, action: 'delivered', messageId: 'msg_1' })
  assert.equal(store.pruneAudit(50), 1)
})

test('seeded helper produces a readable message', t => {
  const store = freshStore(t)
  const message = seedMessage({ config: {}, store, clock: { now: () => 1_000_000 } })
  assert.equal(store.getMessage(message.id).toRole, 'reviewer')
})


test('recent messages return the newest window in chronological order', t => {
  const store = freshStore(t)
  for (let index = 0; index < 5; index++) {
    store.insertMessage(base({
      id: `m${index}`,
      createdAt: 1_000_000 + index,
      threadId: `thr-${index}`,
    }))
  }
  assert.deepEqual(store.recentMessages(2).map(message => message.id), ['m3', 'm4'])
  assert.deepEqual(store.recentMessages(10).map(message => message.id), ['m0', 'm1', 'm2', 'm3', 'm4'])
})


test('committed message changes advance the store version', t => {
  const store = freshStore(t)
  const versions = []
  const unsubscribe = store.subscribe(version => versions.push(version))
  store.insertMessage(base())
  store.claim('msg_1')
  store.recordAttempt('msg_1')
  store.markDelivered('msg_1', 1_000_100)
  assert.equal(store.version, 2)
  assert.deepEqual(versions, [1, 2])
  unsubscribe()
  store.markRead(['msg_1'], 1_000_200)
  assert.equal(store.version, 3)
  assert.deepEqual(versions, [1, 2])
})


test('conversation history pages newest-first and returns pages oldest-first', t => {
  const store = freshStore(t)
  for (let index = 0; index < 5; index++) {
    store.insertMessage(base({
      id: `h${index}`,
      createdAt: 1_000_000 + index,
      fromSessionId: 'session-a',
      toSessionId: 'session-b',
      toRole: 'impl',
    }))
  }
  store.insertMessage(base({
    id: 'other',
    createdAt: 1_000_003,
    fromSessionId: 'session-x',
    toSessionId: 'session-y',
  }))

  const latest = store.messagesBefore('session-a', 'session-b', undefined, '', 2)
  assert.deepEqual(latest.messages.map(message => message.id), ['h3', 'h4'])
  assert.equal(latest.hasMore, true)

  const oldest = latest.messages[0]
  const earlier = store.messagesBefore('session-a', 'session-b', oldest.createdAt, oldest.id, 2)
  assert.deepEqual(earlier.messages.map(message => message.id), ['h1', 'h2'])
  assert.equal(earlier.hasMore, true)

  const first = earlier.messages[0]
  const rest = store.messagesBefore('session-a', 'session-b', first.createdAt, first.id, 2)
  assert.deepEqual(rest.messages.map(message => message.id), ['h0'])
  assert.equal(rest.hasMore, false)
})

test('groups fan out one logical message and keep direct history clean', t => {
  const store = freshStore(t)
  store.createGroup({
    id: 'grp_1',
    name: 'frontend',
    createdBySession: 'session-impl',
    memberIds: ['session-impl', 'session-reviewer', 'session-designer'],
    now: 10,
  })
  assert.deepEqual(store.groupMembers('grp_1').map(member => member.sessionId), [
    'session-designer', 'session-impl', 'session-reviewer',
  ])
  const first = store.insertGroupMessage({
    id: 'gmsg_1',
    groupId: 'grp_1',
    fromRole: 'impl',
    fromSessionId: 'session-impl',
    content: 'hello group',
    kind: 'request',
    threadId: 'group:grp_1',
    createdAt: 20,
    priority: 'normal',
    expiresAt: 1_000,
    recipients: [
      { sessionId: 'session-reviewer', role: 'reviewer' },
      { sessionId: 'session-designer', role: 'designer' },
    ],
  })
  assert.equal(first.inserted, true)
  assert.equal(first.deliveries.length, 2)
  assert.equal(store.recentGroupMessages(10).length, 1)
  assert.equal(store.groupDeliveryStatus('gmsg_1').length, 2)
  assert.equal(store.recentMessages(10).length, 0)
  assert.equal(store.groupMessagesBefore('grp_1', undefined, '', 20).messages[0].content, 'hello group')

  const duplicate = store.insertGroupMessage({
    id: 'gmsg_2',
    groupId: 'grp_1',
    fromRole: 'impl',
    fromSessionId: 'session-impl',
    content: 'hello group',
    kind: 'request',
    threadId: 'group:grp_1',
    createdAt: 30,
    priority: 'normal',
    expiresAt: 1_000,
    idempotencyKey: 'group-once',
    recipients: [{ sessionId: 'session-reviewer', role: 'reviewer' }],
  })
  assert.equal(duplicate.inserted, true)
  const repeated = store.insertGroupMessage({
    id: 'gmsg_3',
    groupId: 'grp_1',
    fromRole: 'impl',
    fromSessionId: 'session-impl',
    content: 'hello group',
    kind: 'request',
    threadId: 'group:grp_1',
    createdAt: 40,
    priority: 'normal',
    expiresAt: 1_000,
    idempotencyKey: 'group-once',
    recipients: [{ sessionId: 'session-reviewer', role: 'reviewer' }],
  })
  assert.equal(repeated.inserted, false)
  assert.equal(repeated.groupMessage.id, 'gmsg_2')
  assert.equal(store.removeGroupMember('grp_1', 'session-designer', 50), true)
  assert.equal(store.groupMembers('grp_1').length, 2)
})

test('dissolving a group removes members but keeps its messages', t => {
  const store = freshStore(t)
  store.createGroup({
    id: 'grp_dissolve',
    name: 'temporary',
    createdBySession: 'session-impl',
    memberIds: ['session-impl', 'session-reviewer'],
    now: 10,
  })
  store.insertGroupMessage({
    id: 'gmsg_keep',
    groupId: 'grp_dissolve',
    fromRole: 'impl',
    fromSessionId: 'session-impl',
    content: 'keep me',
    kind: 'request',
    threadId: 'group:grp_dissolve',
    createdAt: 20,
    priority: 'normal',
    expiresAt: 1_000,
    recipients: [{ sessionId: 'session-reviewer', role: 'reviewer' }],
  })
  const result = store.dissolveGroup('grp_dissolve', 30)
  assert.equal(result.dissolved, true)
  assert.equal(result.removedMembers, 2)
  assert.equal(store.groupMembers('grp_dissolve').length, 0)
  assert.equal(store.getGroup('grp_dissolve').dissolvedAt, 30)
  assert.equal(store.listGroups().length, 0)
  assert.equal(store.listGroups(true).length, 1)
  assert.equal(store.groupMessagesBefore('grp_dissolve', undefined, '', 20).messages[0].content, 'keep me')
  assert.equal(store.dissolveGroup('grp_dissolve', 40).dissolved, false)
})

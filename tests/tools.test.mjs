import assert from 'node:assert/strict'
import test from 'node:test'
import { createBridge } from './helpers.mjs'

const LIVE_IDLE = Object.freeze({ cursor: 1, active: true, running: false, queue: [], pendingInput: [] })

function idle(bridge, ...sessionIds) {
  for (const sessionId of sessionIds) bridge.controller.states.set(sessionId, { ...LIVE_IDLE })
}

async function bind(bridge, sessionId, role) {
  return bridge.call('session_bind', sessionId, { role })
}

async function waitFor(condition, timeoutMs = 3_000) {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not reached in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('a session without a role is told how to bind', async t => {
  const bridge = createBridge(t)
  await assert.rejects(
    bridge.call('session_send', 'session-x', { toRole: 'reviewer', text: 'hi' }),
    /not bound to a bridge role yet; call session_bind/,
  )
  const inbox = await bridge.call('session_inbox', 'session-x', {})
  assert.match(inbox, /inbox is empty \(role=unbound, session=session-x\)/)
})

test('bind, send, inbox, reply, and status form one closed loop', async t => {
  const bridge = createBridge(t)
  idle(bridge, 'session-impl', 'session-reviewer')
  assert.match(await bind(bridge, 'session-impl', 'impl'), /bound session=session-impl role=impl/)
  assert.match(await bind(bridge, 'session-reviewer', 'reviewer'), /bound session=session-reviewer role=reviewer/)

  const sent = await bridge.call('session_send', 'session-impl', {
    toRole: 'reviewer',
    text: 'Please review PR #36, HEAD b572560',
    threadId: 'pr-36',
  })
  const messageId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)?.[1]
  assert.ok(messageId, sent)
  assert.match(sent, /status=pending/)
  assert.match(sent, /session_status/)

  await bridge.worker.drain()
  assert.equal(bridge.store.getMessage(messageId).status, 'delivered')
  assert.equal(bridge.controller.prompts.length, 1)

  const inbox = await bridge.call('session_inbox', 'session-reviewer', { limit: 10 })
  assert.match(inbox, new RegExp(messageId))
  assert.match(inbox, /from=impl/)
  assert.match(inbox, /thread=pr-36/)
  assert.match(inbox, /Please review PR #36/)
  assert.equal(bridge.store.getMessage(messageId).status, 'read')

  const reply = await bridge.call('session_reply', 'session-reviewer', {
    messageId,
    text: 'Approved: P0=0, P1=0',
  })
  const replyId = /messageId=(msg_[0-9a-f-]+)/.exec(reply)?.[1]
  assert.ok(replyId, reply)
  assert.equal(bridge.store.getMessage(messageId).status, 'acked')

  await bridge.worker.drain()
  const replyInbox = await bridge.call('session_inbox', 'session-impl', {})
  assert.match(replyInbox, new RegExp(replyId))
  assert.match(replyInbox, /Approved: P0=0, P1=0/)
  assert.match(replyInbox, /thread=pr-36/)

  const status = await bridge.call('session_status', 'session-impl', { messageId })
  assert.match(status, /status: acked/)
  assert.match(status, /attempts: 1/)
  assert.match(status, /delivered: /)
  assert.match(status, /read: /)
})

test('canSendTo is enforced and the refusal names the role', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'designer', text: 'hello' }),
    /role "impl" may not send to "designer"/,
  )
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'nobody', text: 'hello' }),
    /unknown role "nobody"; declared roles:/,
  )
})

test('the per-sender rate limit stops a burst', async t => {
  const bridge = createBridge(t, { config: { limits: { rateLimitPerMinute: 2 } } })
  await bind(bridge, 'session-impl', 'impl')
  await bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'one' })
  await bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'two' })
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'three' }),
    /rate limit of 2 messages per minute/,
  )
})

test('the pending cap keeps one destination from growing without bound', async t => {
  const bridge = createBridge(t, { config: { limits: { maxPendingPerSession: 1 } } })
  await bind(bridge, 'session-impl', 'impl')
  await bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'one' })
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'two' }),
    /already has 1 queued or in-flight messages/,
  )
})

test('an idempotency key makes a retried send a no-op', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  const first = await bridge.call('session_send', 'session-impl', {
    toRole: 'reviewer',
    text: 'deploy build 42',
    idempotencyKey: 'deploy-42',
  })
  const second = await bridge.call('session_send', 'session-impl', {
    toRole: 'reviewer',
    text: 'deploy build 42',
    idempotencyKey: 'deploy-42',
  })
  assert.match(second, /^duplicate: messageId=/)
  const firstId = /messageId=(msg_[0-9a-f-]+)/.exec(first)[1]
  assert.match(second, new RegExp(firstId))
  assert.equal(bridge.store.duePending(bridge.clock.now(), 10).length, 1)
})

test('a role already bound to another session requires force', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-a', 'impl')
  await assert.rejects(
    bind(bridge, 'session-b', 'impl'),
    /role "impl" is bound to session session-a; pass force: true/,
  )
  assert.match(await bridge.call('session_bind', 'session-b', { role: 'impl', force: true }), /role=impl/)
  assert.equal(bridge.policy.resolveTarget('impl').sessionId, 'session-b')
  assert.equal(bridge.policy.resolveCaller('session-a'), null)

  await assert.rejects(
    bridge.call('session_bind', 'session-b', { role: 'reviewer' }),
    /already bound to role "impl"/,
  )
  assert.match(
    await bridge.call('session_bind', 'session-b', { role: 'reviewer', force: true }),
    /bound session=session-b role=reviewer/,
  )
})

test('a configuration-pinned role rejects runtime binding', async t => {
  const bridge = createBridge(t, { config: { roles: { impl: { sessionId: 'session-pinned' } } } })
  await assert.rejects(
    bridge.call('session_bind', 'session-impl', { role: 'impl' }),
    /pinned to a session by configuration/,
  )
  const caller = bridge.policy.resolveCaller('session-pinned')
  assert.equal(caller.role, 'impl')
  await assert.rejects(
    bridge.call('session_bind', 'session-pinned', { role: 'reviewer', force: true }),
    /pinned to role "impl" by configuration/,
  )
})

test('session_list marks roles and the calling session', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  bridge.controller.sessionsList = [
    {
      sessionId: 'session-impl',
      cwd: '/work/impl',
      running: true,
      projections: { values: { title: 'Implement PR 36' } },
    },
    { sessionId: 'session-reviewer', cwd: '/work/review' },
  ]
  const listing = await bridge.call('session_list', 'session-impl', {})
  assert.match(listing, /sessions: 2 total, 2 independent, showing 2/)
  assert.match(listing, /session-impl {2}role=impl {2}running {2}this session {2}"Implement PR 36" {2}cwd=\/work\/impl/)
  assert.match(listing, /session-reviewer {2}unbound {2}idle/)
  assert.match(listing, /Only the target session can bind a role/)
})

test('session_roles reports permissions and bindings', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  const roles = await bridge.call('session_roles', 'session-impl', {})
  assert.match(roles, /- impl: session=session-impl <- this session/)
  assert.match(roles, /may inject into active turn: no/)
  assert.match(roles, /canSendTo: reviewer, deployer, lead/)
  assert.match(roles, /- lead: session=unbound/)
  assert.match(roles, /system sender: session-bridge/)
})

test('only a participant can read status or reply', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  await bind(bridge, 'session-reviewer', 'reviewer')
  await bind(bridge, 'session-designer', 'designer')
  const sent = await bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'ping' })
  const messageId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)[1]
  await assert.rejects(
    bridge.call('session_status', 'session-designer', { messageId }),
    /not sent by or addressed to this session/,
  )
  await assert.rejects(
    bridge.call('session_reply', 'session-designer', { messageId, text: 'nope' }),
    /addressed to role "reviewer"/,
  )
})

test('a sender cannot reply to its own message', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  const sent = await bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'self' })
  const messageId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)[1]
  await bridge.store.markDelivered(messageId, bridge.clock.now())
  await assert.rejects(
    bridge.call('session_reply', 'session-impl', { messageId, text: 'me' }),
    /was addressed to role "reviewer"/,
  )
})

test('a reply sent through session_send keeps the original thread and sender', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  await bind(bridge, 'session-reviewer', 'reviewer')
  const sent = await bridge.call('session_send', 'session-impl', {
    toRole: 'reviewer',
    text: 'review please',
    threadId: 'pr-9',
  })
  const originalId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)[1]
  await bridge.store.markDelivered(originalId, bridge.clock.now())
  const reply = await bridge.call('session_send', 'session-reviewer', {
    toRole: 'impl',
    text: 'done',
    replyTo: originalId,
  })
  assert.match(reply, /kind=reply/)
  assert.match(reply, /thread=pr-9/)
  await assert.rejects(
    bridge.call('session_send', 'session-reviewer', {
      toRole: 'reviewer',
      text: 'wrong target',
      replyTo: originalId,
    }),
    /a reply must target that role/,
  )
})

test('invalid arguments are rejected before a message is stored', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: '   ' }),
    /text must be a non-empty string/,
  )
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'x'.repeat(8001) }),
    /the limit is 8000/,
  )
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'x', kind: 'shout' }),
    /kind must be one of/,
  )
  await assert.rejects(
    bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'x', metadata: [1] }),
    /metadata must be an object/,
  )
  assert.equal(bridge.store.duePending(bridge.clock.now(), 10).length, 0)
})


test('session_list hides subagent sessions unless asked and marks them', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  bridge.controller.sessionsList = [
    { sessionId: 'session-impl', cwd: '/work/impl', updatedAt: 30 },
    { sessionId: 'sub-1', cwd: '/work/impl', origin: 'subagent', updatedAt: 20 },
    { sessionId: 'session-reviewer', cwd: '/work/review', updatedAt: 10 },
  ]
  const hidden = await bridge.call('session_list', 'session-impl', {})
  assert.match(hidden, /sessions: 3 total, 2 independent \(1 subagent hidden\), showing 2/)
  assert.doesNotMatch(hidden, /sub-1/)
  const shown = await bridge.call('session_list', 'session-impl', { includeSubagents: true, limit: 1 })
  assert.match(shown, /sessions: 3 total, showing 1 \(includes subagents; only independent sessions can receive\)/)
  assert.match(shown, /- session-impl {2}role=impl/)
  assert.match(shown, /\.\.\. 2 more row\(s\); raise limit up to 100\./)
})

test('binding a subagent session is rejected', async t => {
  const bridge = createBridge(t)
  bridge.controller.sessionsList = [
    { sessionId: 'sub-1', cwd: '/work/impl', origin: 'subagent' },
  ]
  await assert.rejects(
    bind(bridge, 'sub-1', 'reviewer'),
    /this is a subagent session; the bridge only binds independent top-level sessions/,
  )
  assert.equal(bridge.policy.resolveTarget('reviewer'), null)
})


test('a direct @ session target works without any role binding', async t => {
  const bridge = createBridge(t)
  bridge.controller.sessionsList = [
    { sessionId: 'session-me', cwd: '/work/me', updatedAt: 2 },
    { sessionId: 'session-other', cwd: '/work/other', updatedAt: 1 },
  ]
  idle(bridge, 'session-me', 'session-other')

  const sent = await bridge.call('session_send', 'session-me', {
    toSessionId: 'session-other',
    text: 'hello from the @ reference',
  })
  const messageId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)[1]
  assert.match(sent, /to=direct \(session-other\)/)
  await bridge.worker.drain()
  assert.equal(bridge.store.getMessage(messageId).status, 'delivered')
  assert.equal(bridge.controller.prompts[0].sessionId, 'session-other')

  const inbox = await bridge.call('session_inbox', 'session-other', {})
  assert.match(inbox, new RegExp(messageId))
  assert.match(inbox, /role=unbound/)
  assert.match(inbox, /hello from the @ reference/)

  const reply = await bridge.call('session_reply', 'session-other', { messageId, text: 'recebido' })
  assert.match(reply, /to=direct \(session-me\)/)
  await bridge.worker.drain()
  const back = await bridge.call('session_inbox', 'session-me', {})
  assert.match(back, /recebido/)
})

test('session_ask waits for and returns the reply in the same call', async t => {
  const bridge = createBridge(t, { config: { delivery: { askTimeoutMs: 5_000 } } })
  bridge.controller.sessionsList = [
    { sessionId: 'session-me', cwd: '/work/me' },
    { sessionId: 'session-other', cwd: '/work/other' },
  ]
  idle(bridge, 'session-me', 'session-other')

  const ask = bridge.call('session_ask', 'session-me', {
    toSessionId: 'session-other',
    text: 'ping',
    timeoutMs: 3_000,
  })
  await waitFor(() => bridge.controller.prompts.length === 1)
  const requestId = bridge.controller.prompts[0].requestId
  await bridge.call('session_reply', 'session-other', { messageId: requestId, text: 'pong' })
  const result = await ask
  assert.match(result, /reply from direct \(messageId=msg_/)
  assert.match(result, /pong/)

  const reply = bridge.store.findRepliesTo(requestId)[0]
  assert.equal(reply.status, 'acked')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(bridge.controller.prompts.length, 1, 'the consumed reply must not be delivered again')
})

test('session_ask falls back to asynchronous delivery on timeout', async t => {
  const bridge = createBridge(t, { config: { delivery: { askTimeoutMs: 1_000 } } })
  bridge.controller.sessionsList = [
    { sessionId: 'session-me', cwd: '/work/me' },
    { sessionId: 'session-other', cwd: '/work/other' },
  ]
  idle(bridge, 'session-me', 'session-other')

  const ask = bridge.call('session_ask', 'session-me', {
    toSessionId: 'session-other',
    text: 'slow request',
    timeoutMs: 1_000,
  })
  await waitFor(() => bridge.controller.prompts.length === 1)
  const requestId = bridge.controller.prompts[0].requestId
  const result = await ask
  assert.match(result, /no reply from direct within 1s/)
  assert.equal(bridge.store.getMessage(requestId).metadata.awaitReply, false)

  await bridge.call('session_reply', 'session-other', { messageId: requestId, text: 'late reply' })
  await bridge.worker.drain()
  const reply = bridge.store.findRepliesTo(requestId)[0]
  assert.equal(reply.status, 'delivered')
  assert.match(await bridge.call('session_inbox', 'session-me', {}), /late reply/)
})

test('a reply does not need send permission in the reverse direction', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-designer', 'designer')
  await bind(bridge, 'session-impl', 'impl')
  idle(bridge, 'session-designer', 'session-impl')

  const sent = await bridge.call('session_send', 'session-designer', {
    toRole: 'impl',
    text: 'please implement',
  })
  const messageId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)[1]
  await bridge.worker.drain()
  const reply = await bridge.call('session_reply', 'session-impl', { messageId, text: 'implemented' })
  assert.match(reply, /replied messageId=/)
  await bridge.worker.drain()
  assert.match(await bridge.call('session_inbox', 'session-designer', {}), /implemented/)
})

test('inbox reports how many messages remain', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-reviewer', 'reviewer')
  for (const id of ['a', 'b', 'c']) {
    bridge.store.insertMessage({
      id,
      threadId: 'thr_many',
      replyTo: undefined,
      fromRole: 'impl',
      fromSessionId: 'session-impl',
      toRole: 'reviewer',
      toSessionId: 'session-reviewer',
      kind: 'request',
      priority: 'normal',
      content: `message ${id}`,
      metadata: undefined,
      idempotencyKey: undefined,
      status: 'pending',
      createdAt: bridge.clock.now(),
      expiresAt: bridge.clock.now() + 86_400_000,
    })
    bridge.store.claim(id)
    bridge.store.markDelivered(id, bridge.clock.now())
  }
  const inbox = await bridge.call('session_inbox', 'session-reviewer', { limit: 1, markRead: false })
  assert.match(inbox, /showing 1 of 3/)
  assert.match(inbox, /2 more message\(s\)/)
})

test('status explains an unbound destination', async t => {
  const bridge = createBridge(t)
  await bind(bridge, 'session-impl', 'impl')
  const sent = await bridge.call('session_send', 'session-impl', { toRole: 'reviewer', text: 'hello' })
  const messageId = /messageId=(msg_[0-9a-f-]+)/.exec(sent)[1]
  const status = await bridge.call('session_status', 'session-impl', { messageId })
  assert.match(status, /waiting: destination role has no bound session yet/)
})

test('a group fans out and a reply broadcasts to the other members', async t => {
  const bridge = createBridge(t)
  bridge.controller.sessionsList = [
    { sessionId: 'session-impl', origin: 'root' },
    { sessionId: 'session-reviewer', origin: 'root' },
    { sessionId: 'session-designer', origin: 'root' },
  ]
  idle(bridge, 'session-impl', 'session-reviewer', 'session-designer')
  await bind(bridge, 'session-impl', 'impl')
  await bind(bridge, 'session-reviewer', 'reviewer')
  await bind(bridge, 'session-designer', 'designer')

  const created = await bridge.call('session_group_create', 'session-impl', {
    name: 'frontend',
    members: ['session-reviewer', 'session-designer'],
  })
  const groupId = /groupId=(grp_[0-9a-f-]+)/.exec(created)?.[1]
  assert.ok(groupId, created)
  assert.match(created, /members=3/)

  const sent = await bridge.call('session_send', 'session-impl', {
    toGroup: 'frontend',
    text: 'hello group',
  })
  const groupMessageId = /groupMessageId=(gmsg_[0-9a-f-]+)/.exec(sent)?.[1]
  assert.ok(groupMessageId, sent)
  assert.match(sent, /recipients=2/)
  await bridge.worker.drain()
  assert.equal(bridge.store.groupDeliveryStatus(groupMessageId).length, 2)

  const reviewerInbox = await bridge.call('session_inbox', 'session-reviewer', {})
  assert.match(reviewerInbox, /group="frontend"/)
  const deliveryId = /messageId=(msg_[0-9a-f-]+)/.exec(reviewerInbox)?.[1]
  assert.ok(deliveryId, reviewerInbox)

  const reply = await bridge.call('session_reply', 'session-reviewer', {
    messageId: deliveryId,
    text: 'ack from reviewer',
  })
  assert.match(reply, /broadcasts to every other member/)
  await bridge.worker.drain()
  const implInbox = await bridge.call('session_inbox', 'session-impl', {})
  assert.match(implInbox, /ack from reviewer/)
  const designerInbox = await bridge.call('session_inbox', 'session-designer', {})
  assert.match(designerInbox, /ack from reviewer/)

  const status = await bridge.call('session_status', 'session-impl', { messageId: groupMessageId })
  assert.match(status, /group message/)
  assert.match(status, /recipients: 2/)
  const listed = await bridge.call('session_group_list', 'session-reviewer', {})
  assert.match(listed, /frontend/)
  assert.match(listed, /members=3/)
})

test('group membership and administration are enforced', async t => {
  const bridge = createBridge(t)
  bridge.controller.sessionsList = [
    { sessionId: 'session-impl', origin: 'root' },
    { sessionId: 'session-reviewer', origin: 'root' },
    { sessionId: 'session-designer', origin: 'root' },
  ]
  idle(bridge, 'session-impl', 'session-reviewer', 'session-designer')
  await bind(bridge, 'session-impl', 'impl')
  await bind(bridge, 'session-reviewer', 'reviewer')

  await bridge.call('session_group_create', 'session-impl', {
    name: 'restricted',
    members: ['session-reviewer'],
  })
  await assert.rejects(
    bridge.call('session_send', 'session-designer', { toGroup: 'restricted', text: 'not allowed' }),
    /not a member of group/,
  )
  await assert.rejects(
    bridge.call('session_group_add', 'session-reviewer', { group: 'restricted', sessionId: 'session-designer' }),
    /only the creator/,
  )
  assert.match(
    await bridge.call('session_group_add', 'session-impl', { group: 'restricted', sessionId: 'session-designer' }),
    /added session=session-designer/,
  )
  await assert.rejects(
    bridge.call('session_group_remove', 'session-impl', { group: 'restricted', sessionId: 'session-impl' }),
    /creator cannot be removed/,
  )
  assert.match(
    await bridge.call('session_group_remove', 'session-reviewer', { group: 'restricted', sessionId: 'session-reviewer' }),
    /removed session=session-reviewer/,
  )
})

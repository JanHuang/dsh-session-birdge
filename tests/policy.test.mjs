import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { BridgePolicy } from '../src/host/policy.js'
import { BridgeStore } from '../src/host/store.js'
import { makeConfig, seedMessage, tempDirectory } from './helpers.mjs'

function freshPolicy(t, config = {}) {
  const resolved = makeConfig(t, config)
  const store = new BridgeStore(path.join(tempDirectory(t), 'policy.db'))
  t.after(() => store.close())
  return { policy: new BridgePolicy(resolved, store), store, config: resolved }
}

test('the starter graph permits the documented directions', t => {
  const { policy } = freshPolicy(t)
  assert.equal(policy.canSend('impl', 'reviewer'), true)
  assert.equal(policy.canSend('impl', 'deployer'), true)
  assert.equal(policy.canSend('impl', 'designer'), false)
  assert.equal(policy.canSend('reviewer', 'impl'), true)
  assert.equal(policy.canSend('lead', 'deployer'), true)
  assert.equal(policy.canSend('deployer', 'impl'), true)
  assert.equal(policy.canSend('impl', 'session-bridge'), false)
  assert.equal(policy.canSend('impl', 'nobody'), false)
  assert.match(policy.denyReason('impl', 'nobody'), /unknown role "nobody"/)
  assert.match(policy.denyReason('impl', 'designer'), /may not send to "designer"/)
  assert.equal(policy.denyReason('impl', 'reviewer'), null)
})

test('configuration overrides starter permissions and adds roles', t => {
  const { policy } = freshPolicy(t, {
    roles: {
      impl: { canSendTo: [] },
      auditor: { canSendTo: ['impl'] },
      reviewer: { sessionId: 'session-pinned' },
    },
  })
  assert.match(policy.denyReason('impl', 'reviewer'), /\(none\)/)
  assert.equal(policy.canSend('auditor', 'impl'), true)
  assert.deepEqual(policy.resolveTarget('reviewer'), {
    role: 'reviewer',
    sessionId: 'session-pinned',
    pinned: true,
  })
  assert.equal(policy.resolveCaller('session-pinned').role, 'reviewer')
  assert.equal(policy.resolveCaller('session-pinned').pinned, true)
})

test('a database binding resolves a target and its caller', t => {
  const { policy, store } = freshPolicy(t)
  assert.equal(policy.resolveTarget('impl'), null)
  store.setRoleBinding('impl', 'session-impl', undefined, 100)
  assert.deepEqual(policy.resolveTarget('impl'), {
    role: 'impl',
    sessionId: 'session-impl',
    pinned: false,
  })
  const caller = policy.resolveCaller('session-impl')
  assert.equal(caller.role, 'impl')
  assert.equal(caller.pinned, false)
  assert.equal(policy.resolveCaller('session-other'), null)
})

test('configuration pins win over a database binding', t => {
  const { policy, store } = freshPolicy(t, { roles: { impl: { sessionId: 'session-pinned' } } })
  store.setRoleBinding('impl', 'session-bound', undefined, 100)
  assert.equal(policy.resolveTarget('impl').sessionId, 'session-pinned')
  assert.equal(policy.resolveCaller('session-pinned').role, 'impl')
  assert.equal(policy.resolveCaller('session-pinned').pinned, true)
})

test('steer permission combines configuration list and per-role flag', t => {
  const { policy } = freshPolicy(t, {
    delivery: { allowSteerRoles: ['lead'] },
    roles: { reviewer: { allowSteer: true } },
  })
  assert.equal(policy.allowSteer('lead'), true)
  assert.equal(policy.allowSteer('reviewer'), true)
  assert.equal(policy.allowSteer('impl'), false)
})

test('the rate limit counts recent messages from the sending role', t => {
  const { policy, store } = freshPolicy(t, { limits: { rateLimitPerMinute: 2 } })
  const message = seedMessage({ store, clock: { now: () => 1_000_000 } })
  assert.equal(policy.checkRate('impl', message.createdAt + 1).allowed, true)
  seedMessage({ store, clock: { now: () => 1_000_000 } })
  const denied = policy.checkRate('impl', message.createdAt + 1)
  assert.equal(denied.allowed, false)
  assert.match(denied.reason, /rate limit of 2/)
  assert.equal(policy.checkRate('reviewer', message.createdAt + 1).allowed, true)
  assert.equal(policy.checkRate('impl', message.createdAt + 120_000).allowed, true)
})

test('role names are validated before use', t => {
  const { policy } = freshPolicy(t)
  assert.equal(policy.validateRoleName('impl'), null)
  assert.match(policy.validateRoleName('Impl'), /invalid role name/)
  assert.match(policy.validateRoleName('has space'), /invalid role name/)
  assert.match(policy.validateRoleName(''), /non-empty/)
})

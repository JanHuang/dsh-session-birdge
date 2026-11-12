import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_ROLES, mergeRoles, resolveConfig } from '../src/host/config.js'
import { makeConfig, tempDirectory } from './helpers.mjs'

test('defaults provide starter roles and a queue delivery mode', () => {
  const config = resolveConfig({}, {})
  assert.equal(config.delivery.defaultMode, 'queue')
  assert.equal(config.delivery.maxAttempts, 5)
  assert.equal(config.limits.maxContentChars, 8000)
  assert.equal(config.delivery.askTimeoutMs, 90_000)
  assert.equal(config.security.allowDirectSessionTargets, true)
  assert.deepEqual(Object.keys(config.roles), Object.keys(DEFAULT_ROLES))
  assert.ok(config.storage.sqlitePath.endsWith(path.join('.dsh', 'session-bridge', 'default', 'bridge.db')))
})

test('the default database path follows the active profile', () => {
  const config = resolveConfig({}, { DSH_PROFILE: 'desktop' })
  assert.ok(config.storage.sqlitePath.endsWith(path.join('.dsh', 'session-bridge', 'desktop', 'bridge.db')))
  const hostile = resolveConfig({}, { DSH_PROFILE: 'a/b' })
  assert.equal(
    path.dirname(hostile.storage.sqlitePath),
    path.join(os.homedir(), '.dsh', 'session-bridge', 'a_b'),
  )
})

test('a tilde path expands to the home directory', () => {
  const config = resolveConfig({ storage: { sqlitePath: '~/bridge/bridge.db' } }, {})
  assert.equal(config.storage.sqlitePath, path.join(os.homedir(), 'bridge', 'bridge.db'))
})

test('explicit storage and delivery values are validated and kept', t => {
  const directory = tempDirectory(t)
  const sqlitePath = path.join(directory, 'custom.db')
  const config = resolveConfig({
    storage: { sqlitePath, auditRetentionDays: 7 },
    delivery: {
      defaultMode: 'steer',
      allowSteerRoles: ['lead'],
      maxAttempts: 3,
      retryBaseMs: 500,
      retryMaxMs: 9000,
      clientTimeZone: 'Asia/Shanghai',
    },
    limits: { maxContentChars: 100, rateLimitPerMinute: 5 },
    security: { allowDirectSessionTargets: false },
  }, {})
  assert.equal(config.storage.sqlitePath, sqlitePath)
  assert.equal(config.storage.auditRetentionDays, 7)
  assert.equal(config.delivery.defaultMode, 'steer')
  assert.deepEqual(config.delivery.allowSteerRoles, ['lead'])
  assert.equal(config.delivery.maxAttempts, 3)
  assert.equal(config.delivery.clientTimeZone, 'Asia/Shanghai')
  assert.equal(config.limits.maxContentChars, 100)
  assert.equal(config.limits.rateLimitPerMinute, 5)
  assert.equal(config.security.allowDirectSessionTargets, false)
})

test('invalid configuration fails with an actionable message', () => {
  assert.throws(() => resolveConfig({ delivery: { retryBaseMs: 4000, retryMaxMs: 3000 } }, {}), /retryMaxMs/)
  assert.throws(() => resolveConfig({ delivery: { clientTimeZone: 'Mars/Olympus' } }, {}), /time zone/)
  assert.throws(() => resolveConfig({ delivery: { defaultMode: 'interrupt' } }, {}), /defaultMode/)
  assert.throws(() => resolveConfig({ limits: { messageTtlMs: 1 } }, {}), /messageTtlMs/)
  assert.throws(() => resolveConfig({ delivery: { askTimeoutMs: 5 } }, {}), /askTimeoutMs/)
  assert.throws(() => resolveConfig({ security: { allowDirectSessionTargets: 'yes' } }, {}), /allowDirectSessionTargets/)
  assert.throws(() => resolveConfig({ roles: 'not-an-object' }, {}), /roles must be an object/)
})

test('roles merge defaults with configuration and reject dangling targets', () => {
  const roles = mergeRoles({
    impl: { sessionId: 'session-impl', canSendTo: ['reviewer'] },
    reviewer: { canSendTo: ['impl'], allowSteer: true },
    auditor: { canSendTo: ['impl'] },
  })
  assert.equal(roles.impl.sessionId, 'session-impl')
  assert.deepEqual(roles.impl.canSendTo, ['reviewer'])
  assert.equal(roles.impl.pinned, true)
  assert.equal(roles.reviewer.allowSteer, true)
  assert.ok(Object.hasOwn(roles, 'auditor'))
  assert.throws(
    () => mergeRoles({ impl: { canSendTo: ['nope'] } }),
    /undeclared role "nope"/,
  )
  assert.throws(
    () => mergeRoles({ impl: { sessionId: 'same' }, reviewer: { sessionId: 'same' } }),
    /pin the same session id/,
  )
  assert.throws(() => mergeRoles({ 'Bad Name': {} }), /invalid role name/)
})

test('resolved configuration is deeply frozen', t => {
  const config = makeConfig(t)
  assert.throws(() => {
    config.limits.maxContentChars = 1
  }, TypeError)
  assert.throws(() => {
    config.roles.impl.canSendTo.push('auditor')
  }, TypeError)
})

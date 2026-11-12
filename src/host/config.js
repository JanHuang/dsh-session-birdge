/**
 * Configuration resolution for the session bridge.
 *
 * Every field is optional. Defaults are chosen so that a fresh install works
 * after each session binds itself with `session_bind`; nothing here reads or
 * writes the profile's files.
 *
 * @module dsh-session-bridge/config
 */

import os from 'node:os'
import path from 'node:path'
import { ROLE_NAME_PATTERN } from './types.js'

/** Starter roles and their send permissions, merged with user configuration. */
export const DEFAULT_ROLES = Object.freeze({
  lead: { canSendTo: ['impl', 'reviewer', 'designer', 'deployer'] },
  impl: { canSendTo: ['reviewer', 'deployer', 'lead'] },
  reviewer: { canSendTo: ['impl', 'deployer', 'lead'] },
  designer: { canSendTo: ['impl', 'reviewer', 'lead'] },
  deployer: { canSendTo: ['impl', 'lead'] },
})

/**
 * Resolve one raw plugin config into validated values.
 * @param {unknown} raw - the `config` object from `cordis.patch.yml`.
 * @param {NodeJS.ProcessEnv} [env] - environment used for the profile-scoped database path.
 * @returns {object} resolved configuration.
 */
export function resolveConfig(raw, env = process.env) {
  const input = isRecord(raw) ? raw : {}
  const storage = isRecord(input.storage) ? input.storage : {}
  const delivery = isRecord(input.delivery) ? input.delivery : {}
  const limits = isRecord(input.limits) ? input.limits : {}
  const security = isRecord(input.security) ? input.security : {}
  const profile = resolveProfileName(env)
  const defaultDatabase = path.join(os.homedir(), '.dsh', 'session-bridge', profile, 'bridge.db')
  const sqlitePath = storage.sqlitePath === undefined
    ? defaultDatabase
    : expandHome(string(storage.sqlitePath, 'storage.sqlitePath'))
  if (sqlitePath.trim() === '') throw configError('storage.sqlitePath must not be empty')

  const retryBaseMs = integer(delivery.retryBaseMs, 2_000, 'delivery.retryBaseMs', 100, 600_000)
  const retryMaxMs = integer(delivery.retryMaxMs, 60_000, 'delivery.retryMaxMs', 100, 3_600_000)
  if (retryMaxMs < retryBaseMs) {
    throw configError('delivery.retryMaxMs must be greater than or equal to delivery.retryBaseMs')
  }

  const allowSteerRoles = stringArray(delivery.allowSteerRoles, ['lead', 'deployer'], 'delivery.allowSteerRoles')
  for (const role of allowSteerRoles) assertRoleName(role, 'delivery.allowSteerRoles')

  const roles = mergeRoles(input.roles)

  return Object.freeze({
    storage: Object.freeze({
      sqlitePath,
      auditRetentionDays: integer(storage.auditRetentionDays, 30, 'storage.auditRetentionDays', 1, 3_650),
    }),
    delivery: Object.freeze({
      defaultMode: enumValue(delivery.defaultMode, 'queue', ['queue', 'steer'], 'delivery.defaultMode'),
      allowSteerRoles: Object.freeze(allowSteerRoles),
      maxAttempts: integer(delivery.maxAttempts, 5, 'delivery.maxAttempts', 1, 100),
      retryBaseMs,
      retryMaxMs,
      tickMs: integer(delivery.tickMs, 1_000, 'delivery.tickMs', 250, 60_000),
      askTimeoutMs: integer(delivery.askTimeoutMs, 90_000, 'delivery.askTimeoutMs', 1_000, 300_000),
      promptTimeoutMs: integer(delivery.promptTimeoutMs, 60_000, 'delivery.promptTimeoutMs', 1_000, 600_000),
      pendingInputDelayMs: integer(delivery.pendingInputDelayMs, 30_000, 'delivery.pendingInputDelayMs', 1_000, 3_600_000),
      unboundRoleRetryMs: integer(delivery.unboundRoleRetryMs, 30_000, 'delivery.unboundRoleRetryMs', 1_000, 3_600_000),
      notifySenderOnFailure: booleanValue(delivery.notifySenderOnFailure, true, 'delivery.notifySenderOnFailure'),
      clientTimeZone: resolveTimeZone(delivery.clientTimeZone),
    }),
    limits: Object.freeze({
      maxContentChars: integer(limits.maxContentChars, 8_000, 'limits.maxContentChars', 1, 1_000_000),
      maxMetadataChars: integer(limits.maxMetadataChars, 4_000, 'limits.maxMetadataChars', 0, 100_000),
      maxPendingPerSession: integer(limits.maxPendingPerSession, 50, 'limits.maxPendingPerSession', 1, 10_000),
      messageTtlMs: integer(limits.messageTtlMs, 86_400_000, 'limits.messageTtlMs', 60_000, 31_536_000_000),
      rateLimitPerMinute: integer(limits.rateLimitPerMinute, 30, 'limits.rateLimitPerMinute', 1, 10_000),
      maxInboxItems: integer(limits.maxInboxItems, 100, 'limits.maxInboxItems', 1, 1_000),
    }),
    security: Object.freeze({
      allowDirectSessionTargets: booleanValue(
        security.allowDirectSessionTargets,
        true,
        'security.allowDirectSessionTargets',
      ),
    }),
    roles: deepFreeze(roles),
  })
}

/**
 * Merge starter roles with user-declared roles and validate the resulting graph.
 * @param {unknown} raw - `roles` mapping from configuration.
 * @returns {Record<string, { sessionId: string | null, canSendTo: string[], allowSteer: boolean, pinned: boolean }>}
 */
export function mergeRoles(raw) {
  if (raw !== undefined && !isRecord(raw)) throw configError('roles must be an object keyed by role name')
  const declared = new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(isRecord(raw) ? raw : {})])
  const roles = {}
  for (const name of declared) {
    assertRoleName(name, 'roles')
    const fallback = DEFAULT_ROLES[name] ?? { canSendTo: [] }
    const entry = isRecord(raw) && isRecord(raw[name]) ? raw[name] : {}
    const sessionId = entry.sessionId === undefined || entry.sessionId === null
      ? null
      : string(entry.sessionId, `roles.${name}.sessionId`).trim()
    if (sessionId === '') throw configError(`roles.${name}.sessionId must not be empty`)
    const canSendTo = stringArray(entry.canSendTo, fallback.canSendTo, `roles.${name}.canSendTo`)
    for (const target of canSendTo) assertRoleName(target, `roles.${name}.canSendTo`)
    roles[name] = {
      sessionId,
      canSendTo: [...new Set(canSendTo)],
      allowSteer: booleanValue(entry.allowSteer, false, `roles.${name}.allowSteer`),
      pinned: sessionId !== null,
    }
  }
  for (const [name, role] of Object.entries(roles)) {
    for (const target of role.canSendTo) {
      if (!Object.hasOwn(roles, target)) {
        throw configError(`roles.${name}.canSendTo refers to undeclared role "${target}"`)
      }
    }
  }
  const pinned = new Map()
  for (const [name, role] of Object.entries(roles)) {
    if (role.sessionId === null) continue
    const previous = pinned.get(role.sessionId)
    if (previous !== undefined) {
      throw configError(`roles.${previous} and roles.${name} pin the same session id`)
    }
    pinned.set(role.sessionId, name)
  }
  return roles
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} message
 * @returns {TypeError}
 */
function configError(message) {
  return new TypeError(`session-bridge: ${message}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function string(value, name) {
  if (typeof value !== 'string') throw configError(`${name} must be a string`)
  return value
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function integer(value, fallback, name, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw configError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} name
 * @returns {boolean}
 */
function booleanValue(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw configError(`${name} must be a boolean`)
  return value
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {T} fallback
 * @param {readonly T[]} accepted
 * @param {string} name
 * @returns {T}
 */
function enumValue(value, fallback, accepted, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !accepted.includes(/** @type {T} */ (value))) {
    throw configError(`${name} must be one of ${accepted.join(', ')}`)
  }
  return /** @type {T} */ (value)
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @param {string} name
 * @returns {string[]}
 */
function stringArray(value, fallback, name) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw configError(`${name} must be an array of strings`)
  }
  return [...new Set(value)]
}

/**
 * @param {string} name
 * @param {string} field
 */
function assertRoleName(name, field) {
  if (!ROLE_NAME_PATTERN.test(name)) {
    throw configError(`${field} contains invalid role name "${name}"`)
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Identify the profile serving this Host process.
 *
 * `DSH_PROFILE` is set for CLI-launched Harnesses. The Desktop launcher instead
 * passes the profile directory as one of the Host process arguments, so both
 * routes are checked before falling back to a shared `default` directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {readonly string[]} [argv]
 * @returns {string}
 */
export function resolveProfileName(env = process.env, argv = process.argv) {
  const direct = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  if (direct !== '') return sanitizeProfile(direct)
  for (const argument of argv) {
    const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]?$/.exec(String(argument))
    if (match !== null) return sanitizeProfile(match[1])
  }
  return sanitizeProfile(undefined)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeProfile(value) {
  const profile = typeof value === 'string' ? value.trim() : ''
  const safe = profile.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return safe === '' ? 'default' : safe
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function resolveTimeZone(value) {
  const candidate = value === undefined
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : string(value, 'delivery.clientTimeZone').trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
  } catch {
    throw configError(`delivery.clientTimeZone is not a valid IANA time zone: "${candidate}"`)
  }
  return candidate
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

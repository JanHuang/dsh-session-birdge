/**
 * Role resolution and send policy.
 *
 * The model never supplies a session id: the caller is the tool execution's
 * agent, and a destination is a role name resolved here. Configuration pins a
 * role to a session, while a DB binding records the session that called
 * `session_bind`; configuration wins for the same role.
 *
 * @module dsh-session-bridge/policy
 */

import { ROLE_NAME_PATTERN, SYSTEM_ROLE } from './types.js'

/** Window used by the per-sender rate limit. */
const RATE_WINDOW_MS = 60_000

export class BridgePolicy {
  #config
  #store

  /**
   * @param {object} config - resolved plugin configuration.
   * @param {import('./store.js').BridgeStore} store - durable role bindings.
   */
  constructor(config, store) {
    this.#config = config
    this.#store = store
  }

  /** @returns {object} resolved configuration. */
  get config() {
    return this.#config
  }

  /** @returns {string[]} every declared role name. */
  roleNames() {
    return Object.keys(this.#config.roles)
  }

  /**
   * @param {string} name
   * @returns {import('./types.js').RoleDefinition | null}
   */
  role(name) {
    const role = this.#config.roles[name]
    return role === undefined ? null : role
  }

  /**
   * Resolve one role to a session id.
   * @param {string} roleName
   * @returns {{ role: string, sessionId: string, pinned: boolean } | null}
   */
  resolveTarget(roleName) {
    const definition = this.role(roleName)
    if (definition === null) return null
    if (definition.sessionId !== null) {
      return { role: roleName, sessionId: definition.sessionId, pinned: true }
    }
    const binding = this.#store.getRoleBinding(roleName)
    return binding === null
      ? null
      : { role: roleName, sessionId: binding.sessionId, pinned: false }
  }

  /**
   * Identify the role of a calling session.
   * @param {string} sessionId
   * @returns {{ role: string, sessionId: string, pinned: boolean, definition: import('./types.js').RoleDefinition } | null}
   */
  resolveCaller(sessionId) {
    for (const [name, definition] of Object.entries(this.#config.roles)) {
      if (definition.sessionId === sessionId) {
        return { role: name, sessionId, pinned: true, definition }
      }
    }
    const binding = this.#store.findRoleBySession(sessionId)
    if (binding === null) return null
    const definition = this.role(binding.role)
    if (definition === null) return null
    return { role: binding.role, sessionId, pinned: false, definition }
  }

  /**
   * Whether one role may send to another.
   * @param {string} fromRole
   * @param {string} toRole
   * @returns {boolean}
   */
  canSend(fromRole, toRole) {
    if (toRole === SYSTEM_ROLE) return false
    if (this.role(toRole) === null) return false
    if (fromRole === SYSTEM_ROLE) return true
    const definition = this.role(fromRole)
    if (definition === null) return false
    return definition.canSendTo.includes(toRole)
  }

  /**
   * Explain why a send is not allowed.
   * @param {string} fromRole
   * @param {string} toRole
   * @returns {string | null} a model-facing reason, or null when allowed.
   */
  denyReason(fromRole, toRole) {
    if (this.role(toRole) === null) {
      return `unknown role "${toRole}"; declared roles: ${this.roleNames().join(', ')}`
    }
    if (fromRole === SYSTEM_ROLE) return null
    const definition = this.role(fromRole)
    if (definition === null) return `role "${fromRole}" is not declared`
    if (!definition.canSendTo.includes(toRole)) {
      const allowed = definition.canSendTo.length > 0 ? definition.canSendTo.join(', ') : '(none)'
      return `role "${fromRole}" may not send to "${toRole}" (canSendTo: ${allowed})`
    }
    return null
  }

  /**
   * Whether this role may steer its target.
   * @param {string} roleName
   * @returns {boolean}
   */
  allowSteer(roleName) {
    const definition = this.role(roleName)
    return definition?.allowSteer === true || this.#config.delivery.allowSteerRoles.includes(roleName)
  }

  /**
   * Enforce the per-sender rate limit.
   * @param {string} fromRole
   * @param {number} [now]
   * @returns {{ allowed: true } | { allowed: false, reason: string }}
   */
  checkRate(fromRole, now = Date.now()) {
    if (fromRole === SYSTEM_ROLE) return { allowed: true }
    const recent = this.#store.countRecentByRole(fromRole, now - RATE_WINDOW_MS)
    if (recent >= this.#config.limits.rateLimitPerMinute) {
      return {
        allowed: false,
        reason: `role "${fromRole}" reached its rate limit of ${this.#config.limits.rateLimitPerMinute} messages per minute`,
      }
    }
    return { allowed: true }
  }

  /**
   * Validate a role name supplied by the model.
   * @param {string} name
   * @returns {string | null} a model-facing reason, or null when valid.
   */
  validateRoleName(name) {
    if (typeof name !== 'string' || name.trim() === '') return 'role name must be a non-empty string'
    if (!ROLE_NAME_PATTERN.test(name)) {
      return `invalid role name "${name}"; roles use lowercase letters, digits, "-" and "_"`
    }
    return null
  }
}

/** Identity helpers shared by tools and delivery. @module dsh-session-bridge/ids */

import { randomUUID } from 'node:crypto'

/**
 * @returns {string} a new message identity.
 */
export function newMessageId() {
  return `msg_${randomUUID()}`
}

/**
 * @returns {string} a new thread identity.
 */
export function newThreadId() {
  return `thr_${randomUUID()}`
}

/**
 * @returns {string} a new group identity.
 */
export function newGroupId() {
  return `grp_${randomUUID()}`
}

/**
 * @returns {string} a new logical group-message identity.
 */
export function newGroupMessageId() {
  return `gmsg_${randomUUID()}`
}

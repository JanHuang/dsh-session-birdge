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

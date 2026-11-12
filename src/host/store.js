/**
 * Durable SQLite message store for the session bridge.
 *
 * The bridge keeps its own database instead of the Session log: messages are
 * cross-session delivery state, not conversation history. `node:sqlite` is
 * synchronous, so every store operation completes before the next JavaScript
 * task runs, which removes the need for an in-process lock.
 *
 * @module dsh-session-bridge/store
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { newMessageId } from './ids.js'

/** Statuses that still consume delivery capacity. */
const IN_FLIGHT = "('pending', 'delivering')"

/** Priority ordering used by delivery and the inbox. */
const PRIORITY_ORDER = "CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END"

/** Current store layout version. */
const SCHEMA_VERSION = 2

export class BridgeStore {
  #db
  #closed = false
  #statements = new Map()
  #version = 0
  #listeners = new Set()

  /**
   * @param {string} databasePath - absolute database file path.
   */
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    this.#db = new DatabaseSync(databasePath)
    try {
      fs.chmodSync(databasePath, 0o600)
    } catch {
      // Best effort: Windows has no POSIX mode and some filesystems reject chmod.
    }
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec('PRAGMA busy_timeout = 5000')
    this.#migrate()
  }

  /** Create the schema and reset interrupted deliveries. */
  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        reply_to TEXT,
        from_role TEXT NOT NULL,
        from_session_id TEXT NOT NULL,
        to_role TEXT NOT NULL,
        to_session_id TEXT,
        kind TEXT NOT NULL,
        priority TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        read_at INTEGER,
        acked_at INTEGER,
        expires_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_idempotency
        ON messages(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_inbox
        ON messages(to_session_id, status, created_at);

      CREATE INDEX IF NOT EXISTS idx_due
        ON messages(status, next_attempt_at, created_at);

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_by_session TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dissolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        added_by_session TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_group_members_session
        ON group_members(session_id);

      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        reply_to TEXT,
        from_role TEXT NOT NULL,
        from_session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'request',
        thread_id TEXT NOT NULL,
        metadata TEXT,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uniq_group_idempotency
        ON group_messages(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_group_messages
        ON group_messages(group_id, created_at);

      CREATE TABLE IF NOT EXISTS roles (
        role TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        note TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_roles_session
        ON roles(session_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        message_id TEXT,
        actor_role TEXT,
        actor_session TEXT,
        to_role TEXT,
        to_session TEXT,
        detail TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_at
        ON audit_events(at);
    `)
    // Older databases predate group fan-out; add the two delivery links in
    // place so existing messages and bindings survive the upgrade.
    this.#ensureColumn('messages', 'group_id', 'TEXT')
    this.#ensureColumn('messages', 'group_message_id', 'TEXT')
    this.#ensureColumn('group_messages', 'kind', "TEXT NOT NULL DEFAULT 'request'")
    this.#ensureColumn('groups', 'dissolved_at', 'INTEGER')
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_group
        ON messages(group_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_group_message
        ON messages(group_message_id);
    `)
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /**
   * Add one column to an existing table when an older schema lacks it.
   * @param {string} table
   * @param {string} column
   * @param {string} type
   */
  #ensureColumn(table, column, type) {
    const rows = this.#db.prepare(`PRAGMA table_info(${table})`).all()
    if (rows.some(row => String(row.name) === column)) return
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  /** Monotonic change counter used by the live snapshot stream. */
  get version() {
    return this.#version
  }

  /**
   * Observe committed message changes.
   * @param {(version: number) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Bump the change counter and notify stream subscribers. */
  #changed() {
    if (this.#closed) return
    this.#version += 1
    for (const listener of this.#listeners) {
      try {
        listener(this.#version)
      } catch {
        // One failed subscriber must not break the write path.
      }
    }
  }

  /** @param {string} sql */
  #statement(sql) {
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      statement = this.#db.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }

  #assertOpen() {
    if (this.#closed) throw new Error('session-bridge: store is closed')
  }

  /** Close the database; later operations fail until a new store is opened. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#statements.clear()
    this.#db.close()
  }

  /**
   * Insert one message unless its idempotency key already exists.
   * @param {import('./types.js').SendMessageInput & { id: string, status: string }} input
   * @returns {{ message: import('./types.js').BridgeMessage, inserted: boolean }}
   */
  insertMessage(input) {
    this.#assertOpen()
    if (input.idempotencyKey !== undefined) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey)
      if (existing !== null) return { message: existing, inserted: false }
    }
    this.#statement(`
      INSERT INTO messages (
        id, thread_id, reply_to, from_role, from_session_id, to_role, to_session_id,
        kind, priority, content, metadata, idempotency_key, status, attempts,
        next_attempt_at, last_error, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
    `).run(
      input.id,
      input.threadId,
      nullIfUndefined(input.replyTo),
      input.fromRole,
      input.fromSessionId,
      input.toRole,
      nullIfUndefined(input.toSessionId),
      input.kind,
      input.priority,
      input.content,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
      nullIfUndefined(input.idempotencyKey),
      input.status,
      input.createdAt,
      nullIfUndefined(input.expiresAt),
    )
    const message = this.getMessage(input.id)
    if (message === null) throw new Error(`session-bridge: message ${input.id} vanished after insert`)
    this.#changed()
    return { message, inserted: true }
  }

  /**
   * @param {string} id
   * @returns {import('./types.js').BridgeMessage | null}
   */
  getMessage(id) {
    this.#assertOpen()
    return rowToMessage(this.#statement('SELECT * FROM messages WHERE id = ?').get(id))
  }

  /**
   * @param {string} key
   * @returns {import('./types.js').BridgeMessage | null}
   */
  findByIdempotencyKey(key) {
    this.#assertOpen()
    return rowToMessage(this.#statement('SELECT * FROM messages WHERE idempotency_key = ?').get(key))
  }

  /**
   * Fill in a role's session once it becomes bound.
   * @param {string} id
   * @param {string} sessionId
   */
  setTargetSession(id, sessionId) {
    this.#assertOpen()
    const result = this.#statement('UPDATE messages SET to_session_id = ? WHERE id = ? AND to_session_id IS NULL')
      .run(sessionId, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * Count messages that still occupy the destination queue.
   * @param {string} sessionId - resolved destination session, when known.
   * @param {string} role - destination role.
   * @returns {number}
   */
  pendingTargetCount(sessionId, role) {
    this.#assertOpen()
    const row = sessionId === ''
      ? this.#statement(`
          SELECT COUNT(*) AS total FROM messages
          WHERE status IN ${IN_FLIGHT} AND to_session_id IS NULL AND to_role = ?
        `).get(role)
      : this.#statement(`
          SELECT COUNT(*) AS total FROM messages
          WHERE status IN ${IN_FLIGHT} AND to_session_id = ?
        `).get(sessionId)
    return Number(row?.total ?? 0)
  }

  /**
   * Messages whose next attempt is due, in delivery order.
   * @param {number} now
   * @param {number} limit
   * @returns {import('./types.js').BridgeMessage[]}
   */
  duePending(now, limit) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM messages
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY ${PRIORITY_ORDER}, created_at
      LIMIT ?
    `).all(now, limit).map(rowToMessage)
  }

  /**
   * Take ownership of one pending message without counting an attempt.
   * @param {string} id
   * @returns {boolean} whether this caller claimed it.
   */
  claim(id) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'delivering'
      WHERE id = ? AND status = 'pending'
    `).run(id)
    return Number(result.changes) > 0
  }

  /**
   * Count one actual prompt attempt.
   * @param {string} id
   */
  recordAttempt(id) {
    this.#assertOpen()
    this.#statement('UPDATE messages SET attempts = attempts + 1 WHERE id = ?').run(id)
  }

  /**
   * Delay a still-pending message without claiming it.
   * @param {string} id
   * @param {number} nextAttemptAt
   */
  deferPending(id, nextAttemptAt) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET next_attempt_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(nextAttemptAt, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * Return a claimed message to the queue without counting a failure.
   * @param {string} id
   * @param {number} nextAttemptAt
   */
  release(id, nextAttemptAt) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'pending', next_attempt_at = ?
      WHERE id = ? AND status = 'delivering'
    `).run(nextAttemptAt, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * @param {string} id
   * @param {number} now
   */
  markDelivered(id, now) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages
      SET status = 'delivered', delivered_at = ?, next_attempt_at = NULL, last_error = NULL
      WHERE id = ?
    `).run(now, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * @param {string} id
   * @param {number} nextAttemptAt
   * @param {string} error
   */
  markRetry(id, nextAttemptAt, error) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'pending', next_attempt_at = ?, last_error = ?
      WHERE id = ?
    `).run(nextAttemptAt, error, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * @param {string} id
   * @param {string} error
   */
  markFailed(id, error) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'failed', next_attempt_at = NULL, last_error = ?
      WHERE id = ?
    `).run(error, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * @param {string} id
   * @param {string} reason
   */
  markExpired(id, reason) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'expired', next_attempt_at = NULL, last_error = ?
      WHERE id = ?
    `).run(reason, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * Expire every queued message whose TTL has passed.
   * @param {number} now
   * @returns {string[]} ids that expired.
   */
  expireDue(now) {
    this.#assertOpen()
    const due = this.#statement(`
      SELECT id FROM messages
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).all(now).map(row => String(row.id))
    if (due.length === 0) return []
    this.#statement(`
      UPDATE messages SET status = 'expired', next_attempt_at = NULL, last_error = 'message expired before delivery'
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now)
    this.#changed()
    return due
  }

  /**
   * Requeue deliveries interrupted by a previous process.
   * @returns {number} number of rows requeued.
   */
  resetInterrupted() {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'pending'
      WHERE status = 'delivering'
    `).run()
    if (Number(result.changes) > 0) this.#changed()
    return Number(result.changes)
  }

  /**
   * Read the recipient inbox.
   * @param {string} sessionId
   * @param {{ limit: number, includeRead: boolean, includeAcked?: boolean }} options
   * @returns {import('./types.js').BridgeMessage[]}
   */
  inbox(sessionId, options) {
    this.#assertOpen()
    const statuses = options.includeRead ? ['delivered', 'read'] : ['delivered']
    if (options.includeAcked === true) statuses.push('acked')
    const placeholders = statuses.map(() => '?').join(', ')
    return this.#statement(`
      SELECT * FROM messages
      WHERE to_session_id = ? AND status IN (${placeholders})
      ORDER BY ${PRIORITY_ORDER}, created_at
      LIMIT ?
    `).all(sessionId, ...statuses, options.limit).map(rowToMessage)
  }

  /**
   * Page one conversation before a cursor, newest first internally and
   * returned oldest first for prepending.
   * @param {string} sessionA
   * @param {string} sessionB
   * @param {number | undefined} before - cursor created_at; omit for the latest page.
   * @param {string} beforeId - tiebreaker for equal timestamps.
   * @param {number} limit
   * @returns {{ messages: import('./types.js').BridgeMessage[], hasMore: boolean }}
   */
  messagesBefore(sessionA, sessionB, before, beforeId, limit) {
    this.#assertOpen()
    const pair = '((from_session_id = ? AND to_session_id = ?) OR (from_session_id = ? AND to_session_id = ?))'
    const rows = before === undefined
      ? this.#statement(`
          SELECT * FROM messages WHERE ${pair} AND group_id IS NULL
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(sessionA, sessionB, sessionB, sessionA, limit + 1)
      : this.#statement(`
          SELECT * FROM messages
          WHERE (created_at < ? OR (created_at = ? AND id < ?)) AND ${pair} AND group_id IS NULL
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(before, before, beforeId, sessionA, sessionB, sessionB, sessionA, limit + 1)
    const hasMore = rows.length > limit
    return {
      messages: rows.slice(0, limit).reverse().map(rowToMessage),
      hasMore,
    }
  }

  /**
   * Create one group and its initial members.
   * @param {{ id: string, name: string, description?: string, createdBySession: string, memberIds: string[], now: number }} input
   * @returns {object}
   */
  createGroup(input) {
    this.#assertOpen()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#statement(`
        INSERT INTO groups (id, name, description, created_by_session, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.id, input.name, nullIfUndefined(input.description), input.createdBySession, input.now, input.now)
      for (const sessionId of [...new Set(input.memberIds)]) {
        this.#statement(`
          INSERT OR IGNORE INTO group_members (group_id, session_id, added_by_session, added_at)
          VALUES (?, ?, ?, ?)
        `).run(input.id, sessionId, input.createdBySession, input.now)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    const group = this.getGroup(input.id)
    if (group === null) throw new Error(`session-bridge: group ${input.id} vanished after insert`)
    this.#changed()
    return group
  }

  /**
   * @param {string} idOrName
   * @returns {object | null}
   */
  getGroup(idOrName) {
    this.#assertOpen()
    const row = this.#statement('SELECT * FROM groups WHERE id = ? OR name = ?').get(idOrName, idOrName)
    return row === undefined ? null : rowToGroup(row)
  }

  /**
   * @returns {Array<object>}
   */
  listGroups(includeDissolved = false) {
    this.#assertOpen()
    return this.#statement(`
      SELECT g.*, (
        SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id
      ) AS member_count
      FROM groups g
      ${includeDissolved ? '' : 'WHERE g.dissolved_at IS NULL'}
      ORDER BY g.updated_at DESC, g.created_at DESC
    `).all().map(row => ({ ...rowToGroup(row), memberCount: Number(row.member_count) }))
  }

  /**
   * Dissolve a group: remove every member but keep the group row and its
   * canonical messages for history and audit.
   * @param {string} groupId
   * @param {number} now
   * @returns {{ dissolved: boolean, removedMembers: number }}
   */
  dissolveGroup(groupId, now) {
    this.#assertOpen()
    const group = this.getGroup(groupId)
    if (group === null) return { dissolved: false, removedMembers: 0 }
    if (group.dissolvedAt !== undefined) return { dissolved: false, removedMembers: 0 }
    const removedMembers = this.groupMembers(group.id).length
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#statement('UPDATE groups SET dissolved_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, group.id)
      this.#statement('DELETE FROM group_members WHERE group_id = ?').run(group.id)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    this.#changed()
    return { dissolved: true, removedMembers }
  }

  /**
   * @param {string} groupId
   * @returns {Array<{ sessionId: string, addedBySession: string, addedAt: number }>}
   */
  groupMembers(groupId) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM group_members WHERE group_id = ? ORDER BY added_at, session_id
    `).all(groupId).map(row => ({
      sessionId: String(row.session_id),
      addedBySession: String(row.added_by_session),
      addedAt: Number(row.added_at),
    }))
  }

  /**
   * @param {{ groupId: string, sessionId: string, addedBySession: string, now: number }} input
   * @returns {boolean} whether a new member was added.
   */
  addGroupMember(input) {
    this.#assertOpen()
    const group = this.getGroup(input.groupId)
    if (group === null || group.dissolvedAt !== undefined) return false
    const result = this.#statement(`
      INSERT OR IGNORE INTO group_members (group_id, session_id, added_by_session, added_at)
      VALUES (?, ?, ?, ?)
    `).run(input.groupId, input.sessionId, input.addedBySession, input.now)
    if (Number(result.changes) > 0) {
      this.#statement('UPDATE groups SET updated_at = ? WHERE id = ?').run(input.now, input.groupId)
      this.#changed()
      return true
    }
    return false
  }

  /**
   * @param {string} groupId
   * @param {string} sessionId
   * @param {number} now
   * @returns {boolean} whether the member existed.
   */
  removeGroupMember(groupId, sessionId, now) {
    this.#assertOpen()
    const result = this.#statement(`
      DELETE FROM group_members WHERE group_id = ? AND session_id = ?
    `).run(groupId, sessionId)
    if (Number(result.changes) > 0) {
      this.#statement('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, groupId)
      this.#changed()
      return true
    }
    return false
  }

  /**
   * Insert one logical group message and one delivery row per recipient.
   * The logical message is canonical for the chat view; delivery rows carry
   * independent status and retries.
   * @param {{
   *   id: string, groupId: string, replyToGroupMessageId?: string,
   *   fromRole: string, fromSessionId: string, content: string, threadId: string,
   *   metadata?: Record<string, unknown>, idempotencyKey?: string, createdAt: number,
   *   priority: string, expiresAt?: number,
   *   recipients: Array<{ sessionId: string, role: string }>,
   * }} input
   * @returns {{ groupMessage: object, deliveries: import('./types.js').BridgeMessage[], inserted: boolean }}
   */
  insertGroupMessage(input) {
    this.#assertOpen()
    const group = this.getGroup(input.groupId)
    if (group === null) throw new Error('session-bridge: group does not exist')
    if (group.dissolvedAt !== undefined) throw new Error('session-bridge: group is dissolved')
    if (input.idempotencyKey !== undefined) {
      const existing = this.#statement('SELECT * FROM group_messages WHERE idempotency_key = ?')
        .get(input.idempotencyKey)
      if (existing !== undefined) {
        return {
          groupMessage: rowToGroupMessage(existing),
          deliveries: this.groupDeliveryStatus(String(existing.id)),
          inserted: false,
        }
      }
    }
    const deliveries = []
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#statement(`
        INSERT INTO group_messages (
          id, group_id, reply_to, from_role, from_session_id, content, kind, thread_id,
          metadata, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.groupId,
        nullIfUndefined(input.replyToGroupMessageId),
        input.fromRole,
        input.fromSessionId,
        input.content,
        input.kind ?? 'request',
        input.threadId,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        nullIfUndefined(input.idempotencyKey),
        input.createdAt,
      )
      const insertDelivery = this.#statement(`
        INSERT INTO messages (
          id, thread_id, reply_to, from_role, from_session_id, to_role, to_session_id,
          kind, priority, content, metadata, idempotency_key, status, attempts,
          next_attempt_at, last_error, created_at, expires_at, group_id, group_message_id
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', 0, NULL, NULL, ?, ?, ?, ?)
      `)
      for (const recipient of input.recipients) {
        const id = newMessageId()
        insertDelivery.run(
          id,
          input.threadId,
          input.fromRole,
          input.fromSessionId,
          recipient.role,
          recipient.sessionId,
          input.kind ?? 'request',
          input.priority,
          input.content,
          input.createdAt,
          nullIfUndefined(input.expiresAt),
          input.groupId,
          input.id,
        )
        deliveries.push(id)
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    const groupMessage = this.getGroupMessage(input.id)
    if (groupMessage === null) throw new Error(`session-bridge: group message ${input.id} vanished after insert`)
    this.#changed()
    return {
      groupMessage,
      deliveries: deliveries.map(id => this.getMessage(id)).filter(message => message !== null),
      inserted: true,
    }
  }

  /**
   * @param {string} id
   * @returns {object | null}
   */
  getGroupMessage(id) {
    this.#assertOpen()
    const row = this.#statement('SELECT * FROM group_messages WHERE id = ?').get(id)
    return row === undefined ? null : rowToGroupMessage(row)
  }

  /**
   * Page one group chat before a cursor, newest first internally.
   * @param {string} groupId
   * @param {number | undefined} before
   * @param {string} beforeId
   * @param {number} limit
   * @returns {{ messages: object[], hasMore: boolean }}
   */
  groupMessagesBefore(groupId, before, beforeId, limit) {
    this.#assertOpen()
    const rows = before === undefined
      ? this.#statement(`
          SELECT * FROM group_messages WHERE group_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(groupId, limit + 1)
      : this.#statement(`
          SELECT * FROM group_messages
          WHERE group_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?
        `).all(groupId, before, before, beforeId, limit + 1)
    const hasMore = rows.length > limit
    return {
      messages: rows.slice(0, limit).reverse().map(rowToGroupMessage),
      hasMore,
    }
  }

  /**
   * @param {number} limit
   * @returns {object[]}
   */
  recentGroupMessages(limit) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM (
        SELECT gm.* FROM group_messages gm
        JOIN groups g ON g.id = gm.group_id
        WHERE g.dissolved_at IS NULL
        ORDER BY gm.created_at DESC LIMIT ?
      ) ORDER BY created_at
    `).all(limit).map(rowToGroupMessage)
  }

  /**
   * @param {string} groupMessageId
   * @returns {object[]}
   */
  groupRepliesTo(groupMessageId) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM group_messages WHERE reply_to = ? ORDER BY created_at
    `).all(groupMessageId).map(rowToGroupMessage)
  }

  /**
   * @param {string} groupMessageId
   * @returns {import('./types.js').BridgeMessage[]}
   */
  groupDeliveryStatus(groupMessageId) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM messages WHERE group_message_id = ? ORDER BY created_at, id
    `).all(groupMessageId).map(rowToMessage)
  }

  /**
   * The newest messages across every thread, oldest first.
   * @param {number} limit
   * @returns {import('./types.js').BridgeMessage[]}
   */
  recentMessages(limit) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM (
        SELECT * FROM messages WHERE group_id IS NULL ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at
    `).all(limit).map(rowToMessage)
  }

  /**
   * @param {string} sessionId
   * @returns {number}
   */
  unreadCount(sessionId) {
    this.#assertOpen()
    const row = this.#statement(`
      SELECT COUNT(*) AS total FROM messages WHERE to_session_id = ? AND status = 'delivered'
    `).get(sessionId)
    return Number(row?.total ?? 0)
  }

  /**
   * Count inbox messages matching the same filter used by `inbox`.
   * @param {string} sessionId
   * @param {boolean} includeRead
   * @returns {number}
   */
  inboxCount(sessionId, includeRead) {
    this.#assertOpen()
    const statuses = includeRead ? ['delivered', 'read'] : ['delivered']
    const placeholders = statuses.map(() => '?').join(', ')
    const row = this.#statement(`
      SELECT COUNT(*) AS total FROM messages
      WHERE to_session_id = ? AND status IN (${placeholders})
    `).get(sessionId, ...statuses)
    return Number(row?.total ?? 0)
  }

  /**
   * Every message that answers one message, in arrival order.
   * @param {string} messageId
   * @returns {import('./types.js').BridgeMessage[]}
   */
  findRepliesTo(messageId) {
    this.#assertOpen()
    return this.#statement(`
      SELECT * FROM messages WHERE reply_to = ? ORDER BY created_at
    `).all(messageId).map(rowToMessage)
  }

  /**
   * Mark a message acknowledged without requiring a prior delivered/read state.
   * Used for a reply consumed synchronously by `session_ask`.
   * @param {string} id
   * @param {number} now
   */
  markAckedNow(id, now) {
    this.#assertOpen()
    this.#statement(`
      UPDATE messages SET status = 'acked', acked_at = ?, read_at = COALESCE(read_at, ?)
      WHERE id = ?
    `).run(now, now, id)
    this.#changed()
  }

  /**
   * Replace one message's metadata.
   * @param {string} id
   * @param {Record<string, unknown>} metadata
   */
  updateMetadata(id, metadata) {
    this.#assertOpen()
    const result = this.#statement('UPDATE messages SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * Return synchronously consumed replies to normal delivery after a timeout.
   * @param {string} messageId
   * @returns {number}
   */
  requeueAckedReplies(messageId) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages SET status = 'pending', acked_at = NULL, read_at = NULL
      WHERE reply_to = ? AND status = 'acked'
    `).run(messageId)
    if (Number(result.changes) > 0) this.#changed()
    return Number(result.changes)
  }

  /**
   * @param {string[]} ids
   * @param {number} now
   * @returns {number}
   */
  markRead(ids, now) {
    this.#assertOpen()
    if (ids.length === 0) return 0
    let changed = 0
    for (const id of ids) {
      const result = this.#statement(`
        UPDATE messages SET status = 'read', read_at = ?
        WHERE id = ? AND status = 'delivered'
      `).run(now, id)
      changed += Number(result.changes)
    }
    if (changed > 0) this.#changed()
    return changed
  }

  /**
   * @param {string} id
   * @param {number} now
   */
  markAcked(id, now) {
    this.#assertOpen()
    const result = this.#statement(`
      UPDATE messages
      SET status = 'acked', acked_at = ?, read_at = COALESCE(read_at, ?)
      WHERE id = ? AND status IN ('delivered', 'read')
    `).run(now, now, id)
    if (Number(result.changes) > 0) this.#changed()
  }

  /**
   * Count messages created by one role since a cutoff.
   * @param {string} role
   * @param {number} since
   * @returns {number}
   */
  countRecentByRole(role, since) {
    this.#assertOpen()
    const row = this.#statement(`
      SELECT COUNT(*) AS total FROM (
        SELECT id FROM messages
        WHERE from_role = ? AND created_at >= ? AND group_message_id IS NULL
        UNION ALL
        SELECT group_message_id FROM messages
        WHERE from_role = ? AND created_at >= ? AND group_message_id IS NOT NULL
        GROUP BY group_message_id
      )
    `).get(role, since, role, since)
    return Number(row?.total ?? 0)
  }

  /**
   * Bind one role to one session, removing any other role of that session.
   * @param {string} role
   * @param {string} sessionId
   * @param {string | undefined} note
   * @param {number} now
   */
  setRoleBinding(role, sessionId, note, now) {
    this.#assertOpen()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#statement('DELETE FROM roles WHERE session_id = ? AND role <> ?').run(sessionId, role)
      this.#statement(`
        INSERT INTO roles (role, session_id, note, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          session_id = excluded.session_id,
          note = excluded.note,
          updated_at = excluded.updated_at
      `).run(role, sessionId, nullIfUndefined(note), now)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * @param {string} role
   * @returns {{ role: string, sessionId: string, note: string | undefined, updatedAt: number } | null}
   */
  getRoleBinding(role) {
    this.#assertOpen()
    const row = this.#statement('SELECT * FROM roles WHERE role = ?').get(role)
    if (row === undefined) return null
    return {
      role: String(row.role),
      sessionId: String(row.session_id),
      note: row.note === null ? undefined : String(row.note),
      updatedAt: Number(row.updated_at),
    }
  }

  /**
   * @returns {Array<{ role: string, sessionId: string, note: string | undefined, updatedAt: number }>}
   */
  listRoleBindings() {
    this.#assertOpen()
    return this.#statement('SELECT * FROM roles ORDER BY role').all().map(row => ({
      role: String(row.role),
      sessionId: String(row.session_id),
      note: row.note === null ? undefined : String(row.note),
      updatedAt: Number(row.updated_at),
    }))
  }

  /**
   * @param {string} sessionId
   * @returns {{ role: string, sessionId: string } | null}
   */
  findRoleBySession(sessionId) {
    this.#assertOpen()
    const row = this.#statement(`
      SELECT role, session_id FROM roles WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId)
    if (row === undefined) return null
    return { role: String(row.role), sessionId: String(row.session_id) }
  }

  /**
   * Append one audit row. Bodies are never recorded.
   * @param {{ at: number, action: string, messageId?: string, actorRole?: string, actorSession?: string, toRole?: string, toSession?: string, detail?: string }} event
   */
  audit(event) {
    if (this.#closed) return
    this.#statement(`
      INSERT INTO audit_events (at, action, message_id, actor_role, actor_session, to_role, to_session, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.at,
      event.action,
      nullIfUndefined(event.messageId),
      nullIfUndefined(event.actorRole),
      nullIfUndefined(event.actorSession),
      nullIfUndefined(event.toRole),
      nullIfUndefined(event.toSession),
      nullIfUndefined(event.detail),
    )
  }

  /**
   * @param {number} before
   * @returns {number}
   */
  pruneAudit(before) {
    this.#assertOpen()
    return Number(this.#statement('DELETE FROM audit_events WHERE at < ?').run(before).changes)
  }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function nullIfUndefined(value) {
  return value === undefined ? null : value
}

/**
 * @param {Record<string, unknown> | undefined} row
 * @returns {import('./types.js').BridgeMessage | null}
 */
function rowToMessage(row) {
  if (row === undefined || row === null) return null
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    replyTo: row.reply_to === null ? undefined : String(row.reply_to),
    fromRole: String(row.from_role),
    fromSessionId: String(row.from_session_id),
    toRole: String(row.to_role),
    toSessionId: row.to_session_id === null ? undefined : String(row.to_session_id),
    kind: String(row.kind),
    priority: String(row.priority),
    content: String(row.content),
    metadata: parseMetadata(row.metadata),
    idempotencyKey: row.idempotency_key === null ? undefined : String(row.idempotency_key),
    status: String(row.status),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? undefined : Number(row.next_attempt_at),
    lastError: row.last_error === null ? undefined : String(row.last_error),
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at === null ? undefined : Number(row.delivered_at),
    readAt: row.read_at === null ? undefined : Number(row.read_at),
    ackedAt: row.acked_at === null ? undefined : Number(row.acked_at),
    expiresAt: row.expires_at === null ? undefined : Number(row.expires_at),
    groupId: row.group_id === null || row.group_id === undefined ? undefined : String(row.group_id),
    groupMessageId: row.group_message_id === null || row.group_message_id === undefined ? undefined : String(row.group_message_id),
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {object}
 */
function rowToGroup(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description === null ? undefined : String(row.description),
    createdBySession: String(row.created_by_session),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.dissolved_at === null || row.dissolved_at === undefined
      ? {}
      : { dissolvedAt: Number(row.dissolved_at) }),
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {object}
 */
function rowToGroupMessage(row) {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    replyTo: row.reply_to === null ? undefined : String(row.reply_to),
    fromRole: String(row.from_role),
    fromSessionId: String(row.from_session_id),
    content: String(row.content),
    kind: String(row.kind ?? 'request'),
    threadId: String(row.thread_id),
    metadata: parseMetadata(row.metadata),
    createdAt: Number(row.created_at),
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function parseMetadata(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

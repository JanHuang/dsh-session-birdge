/**
 * Shared message vocabulary for the session bridge.
 *
 * A message is stored once per send. Delivery rows never copy the content, so
 * the same durable record backs the sender's status view and the recipient's
 * inbox. Content is always plain text and is never interpreted by the bridge.
 *
 * @module dsh-session-bridge/types
 */

/** @typedef {'request' | 'reply' | 'notice' | 'control'} MessageKind */
/** @typedef {'low' | 'normal' | 'high'} MessagePriority */
/** @typedef {'pending' | 'delivering' | 'delivered' | 'read' | 'acked' | 'failed' | 'expired'} MessageStatus */

/** @typedef {object} BridgeMessage
 * @property {string} id Stable identity, also used as the prompt request id.
 * @property {string} threadId Conversation thread shared by related messages.
 * @property {string | undefined} replyTo Message this one answers, when any.
 * @property {string} fromRole Role of the sending session.
 * @property {string} fromSessionId Session that sent the message.
 * @property {string} toRole Role of the destination session.
 * @property {string | undefined} toSessionId Resolved destination, when bound.
 * @property {MessageKind} kind Message kind.
 * @property {MessagePriority} priority Delivery ordering hint.
 * @property {string} content Plain-text body, already length-checked.
 * @property {Record<string, unknown> | undefined} metadata Non-rendered structured data.
 * @property {string | undefined} idempotencyKey Sender-supplied deduplication key.
 * @property {MessageStatus} status Current delivery status.
 * @property {number} attempts Count of prompt attempts that actually started.
 * @property {number | undefined} nextAttemptAt Earliest retry time, epoch ms.
 * @property {string | undefined} lastError Last delivery failure summary.
 * @property {number} createdAt Creation time, epoch ms.
 * @property {number | undefined} deliveredAt Time the target accepted the prompt.
 * @property {number | undefined} readAt Time the target read the message.
 * @property {number | undefined} ackedAt Time the target replied to the message.
 * @property {number | undefined} expiresAt Expiry time, epoch ms.
 */

/** @typedef {object} RoleDefinition
 * @property {string | null} sessionId Session pinned by configuration, if any.
 * @property {readonly string[]} canSendTo Roles this role may send to.
 * @property {boolean} allowSteer Whether high-priority messages may steer.
 * @property {boolean} pinned Whether the session id comes from configuration.
 */

/** @typedef {object} SendMessageInput
 * @property {string} threadId
 * @property {string | undefined} replyTo
 * @property {string} fromRole
 * @property {string} fromSessionId
 * @property {string} toRole
 * @property {string | undefined} toSessionId
 * @property {MessageKind} kind
 * @property {MessagePriority} priority
 * @property {string} content
 * @property {Record<string, unknown> | undefined} metadata
 * @property {string | undefined} idempotencyKey
 * @property {number} createdAt
 * @property {number | undefined} expiresAt
 */

/** System sender used for bridge-generated notices. */
export const SYSTEM_ROLE = 'session-bridge'

/** Role written on a direct session-targeted message whose session holds no role. */
export const DIRECT_ROLE = 'direct'

/** Kind values accepted by `session_send`. */
export const MESSAGE_KINDS = Object.freeze(['request', 'reply', 'notice', 'control'])

/** Priority values accepted by `session_send`. */
export const MESSAGE_PRIORITIES = Object.freeze(['low', 'normal', 'high'])

/** Role names are lowercase and deliberately narrow. */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/

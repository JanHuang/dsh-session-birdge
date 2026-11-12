# Session bridge

Asynchronous, durable messaging between independent DeepSeek Harness sessions.

The bridge is a Host plugin: it delivers through the Host's own
`sessionController`, so it needs no external `dsh headless` process, never
takes a Session writer lock, and a target keeps its own preset and permissions.
Messages are ordinary user text in the target session, labelled with the sender,
kind, thread, and message id.

## Install

Build the package in this checkout, then install the directory as a bundle:

1. Open **Plugins** in DSH.
2. Choose **Add plugin** and select this directory.
3. Restart or let HMR load it; the row is `session-bridge`.

Installing requires Full access. The plugin creates
`~/.dsh/session-bridge/<profile>/bridge.db` on first activation.

## Quick start

In each DSH session, bind it to a role once:

```text
session_bind  { "role": "impl" }        # or reviewer, designer, deployer, lead
```

Then send work from it:

```text
session_send  { "toRole": "reviewer", "kind": "request",
                "text": "Please review PR #36, HEAD b572560",
                "threadId": "pr-36", "idempotencyKey": "review-pr-36-b572560" }
```

The reviewer session reads the queued inputs with:

```text
session_inbox { "limit": 20, "markRead": true }
```

and answers one:

```text
session_reply { "messageId": "msg_...", "text": "Approved: P0=0, P1=0" }
```

To message a session the user points at with `@` instead, pass the session id
from that reference. No role binding is needed on either side:

```text
session_send { "toSessionId": "session-2cb151f8-...",
               "text": "Please run the export and report the result" }
```

For a request whose reply you want in the same turn, use `session_ask`:

```text
session_ask  { "toSessionId": "session-2cb151f8-...", "text": "Ping" }
# -> reply from direct (messageId=msg_..., thread=...):
#
#    pong
```

`session_ask` waits up to `delivery.askTimeoutMs` (90 s). If the reply does
not arrive in time, it returns a timeout notice, leaves the request queued, and
the reply arrives later as a normal bridge message. A reply that was consumed
synchronously is marked acknowledged and is not delivered twice.

`session_send` returns immediately. Delivery happens in the background: a
running target receives a queued prompt after its current turn, a cold target
is resumed through its own preset, and an unbound role waits until a session
binds it. Nothing is lost if the Host restarts; the user message carries the
prompt request id, so a re-delivered prompt is accepted once.

## Tools

| Tool | Purpose |
|---|---|
| `session_send` | Queue a `request`, `reply`, `notice`, or `control` to a role or an `@` session id. |
| `session_ask` | Send a request and wait for the reply in this turn (bounded timeout). |
| `session_inbox` | Read messages delivered to this session; marks them read. |
| `session_reply` | Answer one received message; marks the original acknowledged. |
| `session_status` | Delivery status, attempts, waiting reason, and timestamps. |
| `session_list` | Independent sessions with bound role, running state, cwd, title (`limit`, `includeSubagents`). |
| `session_bind` | Bind this session to a role (one role per session). |
| `session_roles` | Declared roles, bindings, and send permissions. |

The caller identity is never a tool argument: it comes from the execution's
Agent. A destination is either a role or an explicit session id taken from the
user's `@` reference. A direct session target must be visible in this profile
and must not be a subagent; a subagent session cannot send through the bridge.
Role routing still enforces `canSendTo`; direct `@` targets are explicit user
direction and skip that check. Replies also skip `canSendTo`: answering a
message you received is always allowed. Set
`security.allowDirectSessionTargets: false` to disable direct targeting.

## Roles and permissions

Five starter roles exist without configuration:

| Role | May send to |
|---|---|
| `lead` | impl, reviewer, designer, deployer |
| `impl` | reviewer, deployer, lead |
| `reviewer` | impl, deployer, lead |
| `designer` | impl, reviewer, lead |
| `deployer` | impl, lead |

A `roles` entry in configuration adds a role or overrides a starter role's
`canSendTo`, `allowSteer`, or `sessionId`. A configured `sessionId` pins the
role to that session and blocks `session_bind` for it. Duplicate pins and
unknown `canSendTo` targets are rejected at activation.

A reply is a response to a message this session received, so it bypasses
`canSendTo`; the starter graph's asymmetric edges therefore cannot dead-end a
conversation. The `lead` role can inspect any message's status and body
summary, which participants can already see.

## Configuration

All fields are optional. Add them to the `session-bridge` row in the profile's
`cordis.patch.yml`:

```yaml
- id: session-bridge
  name: dsh-session-bridge
  config:
    storage:
      # Default: ~/.dsh/session-bridge/<DSH_PROFILE>/bridge.db
      # sqlitePath: ~/.dsh/session-bridge/desktop/bridge.db
      auditRetentionDays: 30
    delivery:
      defaultMode: queue          # queue | steer
      allowSteerRoles: [lead, deployer]
      maxAttempts: 5
      retryBaseMs: 2000
      retryMaxMs: 60000
      tickMs: 1000
      askTimeoutMs: 90000         # session_ask wait; falls back to async delivery
      promptTimeoutMs: 60000
      pendingInputDelayMs: 30000  # retry delay while the target waits for approval/question
      unboundRoleRetryMs: 30000   # retry delay while the destination role has no session
      notifySenderOnFailure: true # queue a notice to the sender after a terminal failure
      clientTimeZone: Asia/Shanghai
    limits:
      maxContentChars: 8000
      maxMetadataChars: 4000
      maxPendingPerSession: 50
      messageTtlMs: 86400000
      rateLimitPerMinute: 30
      maxInboxItems: 100
    security:
      allowDirectSessionTargets: true  # accept a session id from an @ reference
    roles:
      impl: { sessionId: session-..., canSendTo: [reviewer, deployer] }
```

Omit `sqlitePath` to accept the profile-scoped default.

## Delivery semantics

```text
send -> pending -> delivering -> delivered -> read -> acked
                        |            |
                        +-> pending (retry, backoff)
                        +-> failed  (session/not-found or attempts exhausted)
pending -> expired (message TTL elapsed)
```

- `session/not-found`, and a subagent-owned destination, are terminal and
  queue a notice to the sender. A direct target id that is not visible fails
  before a message is stored.
- `session/agent-busy`, `session/writer-held`, `gateway/internal`, timeouts,
  and unknown failures retry with exponential backoff and jitter.
- A target with pending approval or question input is left alone; the message
  is requeued after `pendingInputDelayMs` without counting an attempt.
- High priority uses `steer` only when the sender role is allowed to steer;
  otherwise it queues.
- A message to an unbound role stays pending and is resolved at delivery time.

## Security model

- The caller identity comes from `exec.agent`, never from arguments.
- `canSendTo` is enforced for sends and replies; there is no broadcast.
- Rate limit per sender role, bounded content, metadata, queue capacity, and
  TTL.
- The bridge does not bypass a target's preset, tool restrictions, or
  permissions: it only admits a normal user message.
- Delivered text is explicitly labelled as untrusted data from another session.
- Audit rows record who sent what to whom, the message id, status, and errors,
  never the message body.

## Storage

The SQLite file (`node:sqlite`) holds three tables: `messages`, `roles`, and
`audit_events`. It is profile-scoped so two DSH profiles do not share role
bindings. The file is created with owner-only permissions. Delete the database
to reset all bindings and history.

## Tests

```sh
node --test tests/*.test.mjs
```

The suite needs a Node with `node:sqlite` (Node 22.13+, or the Node bundled
with DSH). On a desktop install, run it through the DSH runtime:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test tests/*.test.mjs
```

## Limitations

- One DSH Host/profile only; no cross-machine delivery.
- `session_ask` occupies the calling turn while it waits; the target must be
  idle or finish its current turn within the timeout. Use `session_send` for
  fire-and-forget work.
- Subagent sessions are not bridge targets. The Host's Session controller
  reserves them for subagent routing (`session/agent-busy`), so `session_bind`
  rejects them and a stale binding fails with an explanation instead of
  retrying. Use independent top-level chat sessions.
- Session ids are volatile, so roles are bound at runtime or pinned in config.
- A session must load the bridge tools to reply; sessions under a preset that
  denies them receive messages but cannot answer with the tools.
- Delivery is at-least-once at the DSH boundary; the prompt request id makes it
  idempotent inside the target Agent.
- `sessionController` is an internal Host API; pin the DSH release and retest
  after an upgrade.

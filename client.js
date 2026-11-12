/**
 * Bridge conversation view.
 *
 * Registers one `conversation.view` tab after Trajectory. The tab lists every
 * bridge thread in this profile and renders each one as a chat window. Data
 * comes from the Host's read-only `/api/session-bridge/snapshot` route, so the
 * browser never reads the SQLite file and never sees the audit log.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-bridge',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'session-bridge'
    const SNAPSHOT_URL = '/api/session-bridge/snapshot?limit=500'
    const REFRESH_MS = 5_000

    const zh = {
      'view.bridge': '会话桥',
      'title': '会话桥',
      'subtitle': '所有通过 bridge 沟通的会话',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'auto': '每 5 秒自动刷新',
      'loading': '正在读取桥接消息…',
      'error': '无法读取桥接消息',
      'retry': '重试',
      'empty.title': '还没有桥接消息',
      'empty.hint': '在一个会话里 @ 另一个会话发送消息后，这里会出现对话。',
      'count.threads': '个对话',
      'count.messages': '条消息',
      'role.direct': '直连',
      'kind.request': '请求',
      'kind.reply': '回复',
      'kind.notice': '通知',
      'kind.control': '控制',
      'priority.high': '高优先级',
      'priority.low': '低优先级',
      'status.pending': '等待投递',
      'status.delivering': '投递中',
      'status.failed': '投递失败',
      'status.expired': '已过期',
      'unknown.session': '未知会话',
    }

    const en = {
      'view.bridge': 'Bridge',
      'title': 'Session bridge',
      'subtitle': 'Every session conversation carried by the bridge',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'auto': 'Auto-refresh every 5s',
      'loading': 'Reading bridge messages…',
      'error': 'Could not read bridge messages',
      'retry': 'Retry',
      'empty.title': 'No bridge messages yet',
      'empty.hint': 'Mention another session with @ and send a message; the conversation appears here.',
      'count.threads': 'conversations',
      'count.messages': 'messages',
      'role.direct': 'direct',
      'kind.request': 'request',
      'kind.reply': 'reply',
      'kind.notice': 'notice',
      'kind.control': 'control',
      'priority.high': 'high priority',
      'priority.low': 'low priority',
      'status.pending': 'queued',
      'status.delivering': 'delivering',
      'status.failed': 'failed',
      'status.expired': 'expired',
      'unknown.session': 'Unknown session',
    }

    const CSS = `
.dsb-root { display:flex; flex-direction:column; height:100%; min-height:320px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.dsb-header { display:flex; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsb-heading { min-width:0; }
.dsb-title { font-size:15px; font-weight:600; letter-spacing:0.01em; }
.dsb-sub { margin-top:2px; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsb-actions { margin-left:auto; display:flex; align-items:center; gap:10px; flex:0 0 auto; }
.dsb-auto { color:var(--dsw-alias-label-secondary); font-size:11px; display:inline-flex; align-items:center; gap:5px; }
.dsb-auto::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.dsb-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; padding:5px 10px; font-size:12px; cursor:pointer; }
.dsb-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dsb-btn:disabled { opacity:.6; cursor:default; }
.dsb-error-strip { padding:8px 18px; color:var(--dsw-alias-state-error-primary); border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12px; }
.dsb-center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:32px; text-align:center; color:var(--dsw-alias-label-secondary); }
.dsb-center-title { color:var(--dsw-alias-label-primary); font-weight:600; font-size:14px; }
.dsb-body { flex:1; min-height:0; display:flex; }
.dsb-list { width:300px; flex:0 0 300px; min-height:0; overflow:auto; border-right:1px solid var(--dsw-alias-border-l1); padding:6px; }
.dsb-thread { width:100%; display:flex; flex-direction:column; gap:5px; text-align:left; padding:10px 12px; border:1px solid transparent; border-radius:10px; background:transparent; color:inherit; cursor:pointer; font:inherit; }
.dsb-thread:hover { background:var(--dsw-alias-bg-layer-2); }
.dsb-thread[data-active="true"] { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
.dsb-row { display:flex; align-items:center; gap:8px; min-width:0; }
.dsb-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.dsb-time { margin-left:auto; flex:0 0 auto; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsb-roles { flex-wrap:wrap; }
.dsb-role { display:inline-flex; align-items:center; padding:0 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; color:var(--dsw-alias-label-secondary); font-size:10px; line-height:16px; }
.dsb-preview { color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsb-chat { flex:1; min-width:0; display:flex; flex-direction:column; }
.dsb-chat-head { padding:12px 18px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dsb-chat-head .dsb-name { font-size:14px; }
.dsb-messages { flex:1; min-height:0; overflow:auto; padding:18px; display:flex; flex-direction:column; gap:12px; }
.dsb-msg { display:flex; flex-direction:column; gap:4px; max-width:82%; }
.dsb-msg[data-side="right"] { align-self:flex-end; align-items:flex-end; }
.dsb-meta { display:flex; align-items:center; gap:6px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsb-who { color:var(--dsw-alias-label-primary); font-weight:600; }
.dsb-bubble { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; padding:9px 12px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.5; }
.dsb-msg[data-side="right"] .dsb-bubble { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1)); border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l1)); }
.dsb-msg-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; color:var(--dsw-alias-label-secondary); font-size:10px; }
.dsb-chip { padding:0 6px; line-height:16px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); }
.dsb-kind-request { color:var(--dsw-alias-brand-primary); border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l1)); }
.dsb-kind-reply { color:var(--dsw-alias-state-success-primary); }
.dsb-kind-notice { color:var(--dsw-alias-state-warn-primary); }
.dsb-kind-control { color:var(--dsw-alias-state-idle-primary); }
.dsb-status-pending, .dsb-status-delivering { color:var(--dsw-alias-state-warn-primary); }
.dsb-status-failed, .dsb-status-expired { color:var(--dsw-alias-state-error-primary); }
.dsb-to { margin-left:auto; }
@media (max-width: 760px) {
  .dsb-body { flex-direction:column; }
  .dsb-list { width:auto; flex:0 0 auto; max-height:36%; border-right:0; border-bottom:1px solid var(--dsw-alias-border-l1); }
  .dsb-msg { max-width:94%; }
  .dsb-auto { display:none; }
}
`

    /**
     * @param {string} value
     * @param {number} max
     * @returns {string}
     */
    function summarize(value, max) {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim()
      return text.length <= max ? text : `${text.slice(0, max - 1)}…`
    }

    /** @param {string} id */
    function shortId(id) {
      return id.length <= 20 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`
    }

    /** @param {number} value */
    function formatClock(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      const date = new Date(value)
      const now = new Date()
      const pad = number => String(number).padStart(2, '0')
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      return date.toDateString() === now.toDateString()
        ? time
        : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
    }

    /** The tab component. */
    function BridgeView(props) {
      const translate = useCallback((key, fallback) => {
        let value
        try {
          value = typeof props.t === 'function' ? props.t(key) : undefined
        } catch {
          value = undefined
        }
        return typeof value === 'string' && value !== '' && value !== key ? value : fallback
      }, [props.t])

      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [selectedId, setSelectedId] = useState(null)
      const mounted = useRef(true)
      const messagesRef = useRef(null)

      const load = useCallback(async () => {
        setRefreshing(true)
        try {
          const response = await fetch(SNAPSHOT_URL, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (!mounted.current) return
          setSnapshot(data)
          setError(null)
        } catch (failure) {
          if (!mounted.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (mounted.current) {
            setRefreshing(false)
            setLoading(false)
          }
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void load()
        const timer = setInterval(() => { void load() }, REFRESH_MS)
        return () => {
          mounted.current = false
          clearInterval(timer)
        }
      }, [load])

      const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : []
      const sessions = snapshot?.sessions ?? {}
      const totalMessages = typeof snapshot?.totalMessages === 'number' ? snapshot.totalMessages : 0
      const active = threads.find(thread => thread.id === selectedId) ?? threads[0]

      useEffect(() => {
        const node = messagesRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [active?.id, active?.messages?.length])

      const nameOf = id => {
        if (typeof id !== 'string' || id === '') return null
        const info = sessions[id]
        return info !== undefined && typeof info.title === 'string' && info.title !== ''
          ? info.title
          : shortId(id)
      }
      const roleLabel = role => role === 'direct'
        ? translate('role.direct', 'direct')
        : String(role)
      const participantLabel = participant => nameOf(participant.sessionId) ?? roleLabel(participant.role)
      const threadLabel = thread => thread.participants.map(participantLabel).join(' ⇄ ')
      const kindLabel = kind => translate(`kind.${kind}`, String(kind))
      const statusLabel = status => translate(`status.${status}`, String(status))

      const header = h('div', { className: 'dsb-header' },
        h('div', { className: 'dsb-heading' },
          h('div', { className: 'dsb-title' }, translate('title', 'Session bridge')),
          h('div', { className: 'dsb-sub' },
            `${translate('subtitle', 'Every session conversation carried by the bridge')} · `
            + `${threads.length} ${translate('count.threads', 'conversations')} · `
            + `${totalMessages} ${translate('count.messages', 'messages')}`,
          ),
        ),
        h('div', { className: 'dsb-actions' },
          h('span', { className: 'dsb-auto' }, translate('auto', 'Auto-refresh every 5s')),
          h('button', {
            type: 'button',
            className: 'dsb-btn',
            onClick: () => { void load() },
            disabled: refreshing,
          }, refreshing ? translate('refreshing', 'Refreshing…') : translate('refresh', 'Refresh')),
        ),
      )

      const errorStrip = error !== null && snapshot !== null
        ? h('div', { className: 'dsb-error-strip' }, `${translate('error', 'Could not read bridge messages')}: ${error}`)
        : null

      const center = (title, hint, extra) => h('div', { className: 'dsb-center' },
        h('div', { className: 'dsb-center-title' }, title),
        hint === null ? null : h('div', null, hint),
        extra ?? null,
      )

      if (loading && snapshot === null) {
        return h('div', { className: 'dsb-root' }, h('style', null, CSS), header,
          errorStrip,
          center(translate('loading', 'Reading bridge messages…'), null))
      }

      if (snapshot === null) {
        return h('div', { className: 'dsb-root' }, h('style', null, CSS), header,
          center(
            translate('error', 'Could not read bridge messages'),
            error ?? null,
            h('button', {
              type: 'button',
              className: 'dsb-btn',
              onClick: () => { void load() },
              disabled: refreshing,
            }, translate('retry', 'Retry')),
          ))
      }

      if (threads.length === 0) {
        return h('div', { className: 'dsb-root' }, h('style', null, CSS), header,
          errorStrip,
          center(translate('empty.title', 'No bridge messages yet'), translate('empty.hint', 'Mention another session with @ and send a message; the conversation appears here.')))
      }

      const list = h('div', { className: 'dsb-list', role: 'list' },
        threads.map(thread => {
          const last = thread.messages[thread.messages.length - 1]
          return h('button', {
            key: thread.id,
            type: 'button',
            role: 'listitem',
            className: 'dsb-thread',
            'data-active': String(thread.id === active?.id),
            title: thread.id,
            onClick: () => setSelectedId(thread.id),
          },
            h('div', { className: 'dsb-row' },
              h('span', { className: 'dsb-name' }, threadLabel(thread)),
              h('span', { className: 'dsb-time' }, formatClock(thread.updatedAt)),
            ),
            h('div', { className: 'dsb-row dsb-roles' },
              thread.participants.map((participant, index) => h('span', {
                key: `${participant.role}:${participant.sessionId ?? index}`,
                className: 'dsb-role',
              }, roleLabel(participant.role))),
            ),
            h('div', { className: 'dsb-preview' },
              last === undefined ? '' : `${roleLabel(last.fromRole)}: ${summarize(last.content, 90)}`),
          )
        }),
      )

      const chat = active === undefined
        ? center(translate('empty.title', 'No bridge messages yet'), null)
        : h('div', { className: 'dsb-chat' },
          h('div', { className: 'dsb-chat-head' },
            h('div', { className: 'dsb-name' }, threadLabel(active)),
            h('div', { className: 'dsb-sub' },
              `${active.id} · ${active.messages.length} ${translate('count.messages', 'messages')}`),
          ),
          h('div', { className: 'dsb-messages', ref: messagesRef },
            active.messages.map(message => {
              const side = message.fromSessionId === active.messages[0]?.fromSessionId ? 'right' : 'left'
              const showStatus = ['pending', 'delivering', 'failed', 'expired'].includes(message.status)
              return h('div', {
                key: message.id,
                className: 'dsb-msg',
                'data-side': side,
              },
                h('div', { className: 'dsb-meta' },
                  h('span', { className: 'dsb-who' },
                    nameOf(message.fromSessionId) ?? translate('unknown.session', 'Unknown session')),
                  h('span', { className: 'dsb-role' }, roleLabel(message.fromRole)),
                  h('span', { className: 'dsb-time' }, formatClock(message.createdAt)),
                ),
                h('div', { className: 'dsb-bubble' }, message.content),
                h('div', { className: 'dsb-msg-foot' },
                  h('span', { className: `dsb-chip dsb-kind-${message.kind}` }, kindLabel(message.kind)),
                  message.priority === 'high'
                    ? h('span', { className: 'dsb-chip' }, translate('priority.high', 'high priority'))
                    : null,
                  showStatus
                    ? h('span', { className: `dsb-chip dsb-status-${message.status}` }, statusLabel(message.status))
                    : null,
                  h('span', { className: 'dsb-to' }, `→ ${nameOf(message.toSessionId) ?? roleLabel(message.toRole)}`),
                ),
              )
            }),
          ),
        )

      return h('div', { className: 'dsb-root' }, h('style', null, CSS), header, errorStrip,
        h('div', { className: 'dsb-body' }, list, chat))
    }

    return {
      name: 'session-bridge',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-bridge: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'bridge',
          order: 15,
          locale: NS,
          label: () => t('view.bridge'),
        }, BridgeView))
      },
    }
  },
})

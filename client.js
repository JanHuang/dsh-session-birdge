/**
 * Bridge conversation view.
 *
 * Registers one `conversation.view` tab after Trajectory. One card is one pair
 * of sessions: every thread and historical message between that pair lives in
 * the same chat, newest activity first, with today's messages visible and older
 * history collapsed by default. Data comes from the Host's read-only
 * `/api/session-bridge/snapshot` route.
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
    const MESSAGE_LIMIT = 320

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
      'count.conversations': '个会话',
      'count.threads': '个线程',
      'count.messages': '条消息',
      'role.direct': '直连',
      'kind.request': '请求',
      'kind.reply': '回复',
      'kind.notice': '通知',
      'kind.control': '控制',
      'priority.high': '高优先级',
      'status.pending': '等待投递',
      'status.delivering': '投递中',
      'status.failed': '投递失败',
      'status.expired': '已过期',
      'unknown.session': '未知会话',
      'current.tag': '当前',
      'day.today': '今天',
      'day.yesterday': '昨天',
      'history.older': '更早的消息',
      'history.collapse': '收起更早的消息',
      'history.emptyToday': '今天还没有新消息',
      'history.hint': '展开更早的消息查看历史沟通。',
      'message.expand': '展开',
      'message.collapse': '收起',
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
      'count.conversations': 'conversations',
      'count.threads': 'threads',
      'count.messages': 'messages',
      'role.direct': 'direct',
      'kind.request': 'request',
      'kind.reply': 'reply',
      'kind.notice': 'notice',
      'kind.control': 'control',
      'priority.high': 'high priority',
      'status.pending': 'queued',
      'status.delivering': 'delivering',
      'status.failed': 'failed',
      'status.expired': 'expired',
      'unknown.session': 'Unknown session',
      'current.tag': 'current',
      'day.today': 'Today',
      'day.yesterday': 'Yesterday',
      'history.older': 'Earlier messages',
      'history.collapse': 'Hide earlier messages',
      'history.emptyToday': 'No messages today yet',
      'history.hint': 'Expand earlier messages to read the history.',
      'message.expand': 'Expand',
      'message.collapse': 'Collapse',
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
.dsb-center-inline { padding:20px; }
.dsb-center-title { color:var(--dsw-alias-label-primary); font-weight:600; font-size:14px; }
.dsb-body { flex:1; min-height:0; display:flex; }
.dsb-list { width:300px; flex:0 0 300px; min-height:0; overflow:auto; padding:6px; background:var(--dsw-alias-bg-layer-1); border-right:1px solid var(--dsw-alias-border-l1); }
.dsb-thread { width:100%; display:flex; align-items:flex-start; gap:10px; text-align:left; padding:10px; border:1px solid transparent; border-radius:10px; background:transparent; color:inherit; cursor:pointer; font:inherit; }
.dsb-thread:hover { background:var(--dsw-alias-bg-layer-2); }
.dsb-thread[data-active="true"] { background:var(--dsw-alias-bg-base); border-color:var(--dsw-alias-border-l2); }
.dsb-avatar { width:28px; height:28px; flex:0 0 28px; display:flex; align-items:center; justify-content:center; border-radius:50%; font-size:12px; font-weight:600; color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-2)); border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l1)); }
.dsb-avatar-lg { width:34px; height:34px; flex-basis:34px; font-size:14px; }
.dsb-thread-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.dsb-row { display:flex; align-items:center; gap:6px; min-width:0; }
.dsb-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.dsb-time { margin-left:auto; flex:0 0 auto; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsb-tag { flex:0 0 auto; font-size:10px; line-height:15px; padding:0 6px; border-radius:999px; color:var(--dsw-alias-brand-primary); border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, var(--dsw-alias-border-l1)); }
.dsb-roles { display:flex; gap:4px; flex-wrap:wrap; }
.dsb-role { display:inline-flex; align-items:center; padding:0 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; color:var(--dsw-alias-label-secondary); font-size:10px; line-height:16px; }
.dsb-preview { color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsb-chat { flex:1; min-width:0; display:flex; flex-direction:column; background:var(--dsw-alias-bg-base); }
.dsb-chat-head { display:flex; align-items:center; gap:10px; padding:12px 18px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); }
.dsb-head-main { min-width:0; }
.dsb-head-main .dsb-name { font-size:14px; }
.dsb-messages { flex:1; min-height:0; overflow:auto; padding:16px 18px 22px; display:flex; flex-direction:column; gap:10px; }
.dsb-history { position:sticky; top:0; z-index:2; align-self:center; display:inline-flex; align-items:center; gap:6px; margin-bottom:4px; padding:5px 12px; border:1px dashed var(--dsw-alias-border-l2); border-radius:999px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:11px; cursor:pointer; }
.dsb-history:hover { color:var(--dsw-alias-label-primary); }
.dsb-day { align-self:center; margin:4px 0 2px; padding:2px 10px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsb-msg { display:flex; flex-direction:column; gap:4px; max-width:78%; }
.dsb-msg[data-side="right"] { align-self:flex-end; align-items:flex-end; }
.dsb-meta { display:flex; align-items:center; gap:6px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsb-who { color:var(--dsw-alias-label-primary); font-weight:600; }
.dsb-bubble { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:12px; padding:9px 12px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.5; }
.dsb-msg[data-side="right"] .dsb-bubble { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1)); border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, var(--dsw-alias-border-l1)); }
.dsb-link { appearance:none; border:0; background:none; padding:0 4px; color:var(--dsw-alias-brand-primary); font:inherit; font-size:11px; cursor:pointer; }
.dsb-msg-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; color:var(--dsw-alias-label-secondary); font-size:10px; }
.dsb-chip { padding:0 6px; line-height:16px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); }
.dsb-kind-request { color:var(--dsw-alias-brand-primary); border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l1)); }
.dsb-kind-reply { color:var(--dsw-alias-state-success-primary); }
.dsb-kind-notice { color:var(--dsw-alias-state-warn-primary); }
.dsb-kind-control { color:var(--dsw-alias-state-idle-primary); }
.dsb-status-pending, .dsb-status-delivering { color:var(--dsw-alias-state-warn-primary); }
.dsb-status-failed, .dsb-status-expired { color:var(--dsw-alias-state-error-primary); }
.dsb-thread-tag { font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
@media (max-width: 760px) {
  .dsb-body { flex-direction:column; }
  .dsb-list { width:auto; flex:0 0 auto; max-height:38%; border-right:0; border-bottom:1px solid var(--dsw-alias-border-l1); }
  .dsb-msg { max-width:92%; }
  .dsb-auto { display:none; }
}
`

    /** @param {string} value @param {number} max */
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

    /** @param {number} value */
    function dayKey(value) {
      const date = new Date(value)
      return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
    }

    /** @param {string} value @param {string} fallback */
    function firstCharacter(value, fallback) {
      const characters = [...String(value ?? '')]
      return characters.length === 0 ? fallback : characters[0].toUpperCase()
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

      const currentSessionId = typeof props.sessionId === 'string' ? props.sessionId : null
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [selectedId, setSelectedId] = useState(null)
      const [expandedHistory, setExpandedHistory] = useState(false)
      const [expandedMessages, setExpandedMessages] = useState(() => new Set())
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

      const conversations = Array.isArray(snapshot?.conversations) ? snapshot.conversations : []
      const sessions = snapshot?.sessions ?? {}
      const totalMessages = typeof snapshot?.totalMessages === 'number' ? snapshot.totalMessages : 0
      const ordered = [...conversations].sort((left, right) => {
        const leftCurrent = currentSessionId !== null
          && left.participants.some(participant => participant.sessionId === currentSessionId)
        const rightCurrent = currentSessionId !== null
          && right.participants.some(participant => participant.sessionId === currentSessionId)
        return Number(rightCurrent) - Number(leftCurrent) || right.updatedAt - left.updatedAt
      })
      const active = ordered.find(conversation => conversation.id === selectedId) ?? ordered[0]

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
      const peerOf = conversation => {
        if (currentSessionId === null) return null
        return conversation.participants.find(participant => participant.sessionId !== currentSessionId) ?? null
      }
      const conversationLabel = conversation => {
        const peer = peerOf(conversation)
        if (peer !== null) return nameOf(peer.sessionId) ?? roleLabel(peer.role)
        return conversation.participants.map(participantLabel).join(' ⇄ ')
      }
      const kindLabel = kind => translate(`kind.${kind}`, String(kind))
      const statusLabel = status => translate(`status.${status}`, String(status))

      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const olderMessages = active === undefined
        ? []
        : active.messages.filter(message => message.createdAt < todayStart.getTime())
      const todayMessages = active === undefined
        ? []
        : active.messages.filter(message => message.createdAt >= todayStart.getTime())
      const visibleMessages = expandedHistory ? (active?.messages ?? []) : todayMessages

      useEffect(() => {
        const node = messagesRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [active?.id, expandedHistory, active?.messages?.length])

      const selectConversation = id => {
        if (id === selectedId) return
        setSelectedId(id)
        setExpandedHistory(false)
        setExpandedMessages(new Set())
      }
      const toggleMessage = id => {
        setExpandedMessages(previous => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const dayLabel = value => {
        const date = new Date(value)
        const today = new Date()
        const yesterday = new Date()
        yesterday.setDate(today.getDate() - 1)
        if (date.toDateString() === today.toDateString()) return translate('day.today', 'Today')
        if (date.toDateString() === yesterday.toDateString()) return translate('day.yesterday', 'Yesterday')
        const pad = number => String(number).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      }

      const header = h('div', { className: 'dsb-header' },
        h('div', { className: 'dsb-heading' },
          h('div', { className: 'dsb-title' }, translate('title', 'Session bridge')),
          h('div', { className: 'dsb-sub' },
            `${translate('subtitle', 'Every session conversation carried by the bridge')} · `
            + `${ordered.length} ${translate('count.conversations', 'conversations')} · `
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

      if (ordered.length === 0) {
        return h('div', { className: 'dsb-root' }, h('style', null, CSS), header, errorStrip,
          center(
            translate('empty.title', 'No bridge messages yet'),
            translate('empty.hint', 'Mention another session with @ and send a message; the conversation appears here.'),
          ))
      }

      const list = h('div', { className: 'dsb-list', role: 'list' },
        ordered.map(conversation => {
          const peer = peerOf(conversation)
          const label = conversationLabel(conversation)
          const last = conversation.messages[conversation.messages.length - 1]
          return h('button', {
            key: conversation.id,
            type: 'button',
            role: 'listitem',
            className: 'dsb-thread',
            'data-active': String(conversation.id === active?.id),
            title: conversation.id,
            onClick: () => selectConversation(conversation.id),
          },
            h('span', { className: 'dsb-avatar' }, firstCharacter(label, '?')),
            h('span', { className: 'dsb-thread-main' },
              h('span', { className: 'dsb-row' },
                h('span', { className: 'dsb-name' }, label),
                peer === null ? null : h('span', { className: 'dsb-tag' }, translate('current.tag', 'current')),
                h('span', { className: 'dsb-time' }, formatClock(conversation.updatedAt)),
              ),
              h('span', { className: 'dsb-preview' },
                last === undefined ? '' : `${roleLabel(last.fromRole)}: ${summarize(last.content, 80)}`),
              h('span', { className: 'dsb-roles' },
                conversation.participants.map((participant, index) => h('span', {
                  key: `${participant.role}:${participant.sessionId ?? index}`,
                  className: 'dsb-role',
                }, roleLabel(participant.role))),
              ),
            ),
          )
        }),
      )

      let chat = null
      if (active !== undefined) {
        const peer = peerOf(active)
        const currentInConversation = peer !== null
        const initiator = active.messages[0]?.fromSessionId
        const sideOf = message => currentInConversation
          ? (message.fromSessionId === currentSessionId ? 'right' : 'left')
          : (message.fromSessionId === initiator ? 'right' : 'left')
        const chatLabel = conversationLabel(active)
        const chatSubtitle = [
          peer === null ? null : roleLabel(peer.role),
          `${active.threadIds.length} ${translate('count.threads', 'threads')}`,
          `${active.messages.length} ${translate('count.messages', 'messages')}`,
        ].filter(part => part !== null).join(' · ')

        const historyBar = olderMessages.length === 0
          ? null
          : h('button', {
            type: 'button',
            className: 'dsb-history',
            onClick: () => setExpandedHistory(value => !value),
          },
            h('span', null, `${expandedHistory
              ? translate('history.collapse', 'Hide earlier messages')
              : translate('history.older', 'Earlier messages')} · ${olderMessages.length}`),
            h('span', null, expandedHistory ? '▴' : '▾'),
          )

        const renderMessage = message => {
          const content = String(message.content ?? '')
          const truncated = content.length > MESSAGE_LIMIT && !expandedMessages.has(message.id)
          const shown = truncated ? `${content.slice(0, MESSAGE_LIMIT - 1)}…` : content
          const showStatus = ['pending', 'delivering', 'failed', 'expired'].includes(message.status)
          return h('div', {
            key: message.id,
            className: 'dsb-msg',
            'data-side': sideOf(message),
          },
            h('div', { className: 'dsb-meta' },
              h('span', { className: 'dsb-who' },
                nameOf(message.fromSessionId) ?? translate('unknown.session', 'Unknown session')),
              h('span', { className: 'dsb-role' }, roleLabel(message.fromRole)),
              h('span', { className: 'dsb-time' }, formatClock(message.createdAt)),
            ),
            h('div', { className: 'dsb-bubble' },
              h('span', null, shown),
              content.length > MESSAGE_LIMIT
                ? h('button', {
                  type: 'button',
                  className: 'dsb-link',
                  onClick: () => toggleMessage(message.id),
                }, truncated ? translate('message.expand', 'Expand') : translate('message.collapse', 'Collapse'))
                : null,
            ),
            h('div', { className: 'dsb-msg-foot' },
              h('span', { className: `dsb-chip dsb-kind-${message.kind}` }, kindLabel(message.kind)),
              message.priority === 'high'
                ? h('span', { className: 'dsb-chip' }, translate('priority.high', 'high priority'))
                : null,
              showStatus
                ? h('span', { className: `dsb-chip dsb-status-${message.status}` }, statusLabel(message.status))
                : null,
              active.threadIds.length > 1
                ? h('span', { className: 'dsb-chip dsb-thread-tag', title: message.threadId },
                  `#${shortId(message.threadId)}`)
                : null,
            ),
          )
        }

        const rendered = []
        let lastDay = null
        for (const message of visibleMessages) {
          const key = dayKey(message.createdAt)
          if (key !== lastDay) {
            rendered.push(h('div', { key: `day-${key}`, className: 'dsb-day' }, dayLabel(message.createdAt)))
            lastDay = key
          }
          rendered.push(renderMessage(message))
        }

        chat = h('div', { className: 'dsb-chat' },
          h('div', { className: 'dsb-chat-head' },
            h('span', { className: 'dsb-avatar dsb-avatar-lg' }, firstCharacter(chatLabel, '?')),
            h('div', { className: 'dsb-head-main' },
              h('div', { className: 'dsb-row' },
                h('span', { className: 'dsb-name' }, chatLabel),
                currentInConversation
                  ? h('span', { className: 'dsb-tag' }, translate('current.tag', 'current'))
                  : null,
              ),
              h('div', { className: 'dsb-sub' }, chatSubtitle),
            ),
          ),
          h('div', { className: 'dsb-messages', ref: messagesRef },
            historyBar,
            visibleMessages.length === 0
              ? h('div', { className: 'dsb-center dsb-center-inline' },
                h('div', { className: 'dsb-center-title' }, translate('history.emptyToday', 'No messages today yet')),
                h('div', null, translate('history.hint', 'Expand earlier messages to read the history.')),
              )
              : rendered,
          ),
        )
      }

      return h('div', { className: 'dsb-root' }, h('style', null, CSS), header, errorStrip,
        h('div', { className: 'dsb-body' }, list, chat ?? center(translate('empty.title', 'No bridge messages yet'), null)))
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

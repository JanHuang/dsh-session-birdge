/**
 * Bridge conversation view.
 *
 * One card is one pair of sessions: every thread and historical message between
 * that pair lives in the same chat. The view follows the host theme
 * (`body[data-ds-dark-theme]`), receives new messages over an authenticated
 * server-sent event stream, defaults to today's history, and can queue a new
 * request for the selected peer through the panel composer.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-bridge',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'session-bridge'
    const SNAPSHOT_URL = '/api/session-bridge/snapshot?limit=500'
    const EVENTS_URL = '/api/session-bridge/events'
    const SEND_URL = '/api/session-bridge/send'

    const zh = {
      'view.bridge': '会话桥',
      'title': '会话桥',
      'live': '实时更新',
      'reconnecting': '重连中…',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'loading': '正在读取桥接消息…',
      'error': '无法读取桥接消息',
      'retry': '重试',
      'empty.title': '还没有桥接消息',
      'empty.hint': '在一个会话里 @ 另一个会话发送消息后，这里会出现对话。',
      'list.title': '会话',
      'count.threads': '个线程',
      'count.messages': '条消息',
      'role.direct': 'Bridge',
      'role.lead': 'Lead',
      'kind.request': '请求',
      'kind.reply': '回复',
      'kind.notice': '通知',
      'kind.control': '控制',
      'day.today': '今天',
      'day.yesterday': '昨天',
      'history.older': '更早的消息',
      'history.collapse': '收起更早的消息',
      'history.emptyToday': '今天还没有新消息',
      'history.hint': '展开更早的消息查看历史沟通。',
      'copy': '复制代码',
      'send.placeholder': '输入消息，Enter 发送…',
      'send.blocked': '当前会话不在此对话中',
      'send.unbound': '对方会话尚未绑定，暂时无法发送',
      'send.button': '发送',
      'send.failed': '发送失败',
    }
    const en = {
      'view.bridge': 'Bridge',
      'title': 'Session bridge',
      'live': 'Live',
      'reconnecting': 'Reconnecting…',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'loading': 'Reading bridge messages…',
      'error': 'Could not read bridge messages',
      'retry': 'Retry',
      'empty.title': 'No bridge messages yet',
      'empty.hint': 'Mention another session with @ and send a message; the conversation appears here.',
      'list.title': 'Conversations',
      'count.threads': 'threads',
      'count.messages': 'messages',
      'role.direct': 'Bridge',
      'role.lead': 'Lead',
      'kind.request': 'request',
      'kind.reply': 'reply',
      'kind.notice': 'notice',
      'kind.control': 'control',
      'day.today': 'Today',
      'day.yesterday': 'Yesterday',
      'history.older': 'Earlier messages',
      'history.collapse': 'Hide earlier messages',
      'history.emptyToday': 'No messages today yet',
      'history.hint': 'Expand earlier messages to read the history.',
      'copy': 'Copy code',
      'send.placeholder': 'Type a message, Enter to send…',
      'send.blocked': 'Current session is not in this conversation',
      'send.unbound': 'The peer session is not bound yet',
      'send.button': 'Send',
      'send.failed': 'Could not send',
    }

    const CSS = `
.dsb-root {
  --dsb-bg:#F7F8FA; --dsb-panel:#FFFFFF; --dsb-item:#FFFFFF; --dsb-item-hover:#F2F3F5;
  --dsb-item-active:#E7EDFF; --dsb-chat:#FFFFFF; --dsb-lead:#F2F3F5; --dsb-bridge:#165DFF;
  --dsb-text:#1D2129; --dsb-muted:#86909C; --dsb-code-bg:#1D2129; --dsb-code-text:#F2F3F5;
  --dsb-input:#FFFFFF; --dsb-focus:#165DFF; --dsb-line:#E5E6EB; --dsb-tag-bg:#FFFFFF;
  --dsb-scroll:#C9CDD4; --dsb-scroll-hover:#A9AEB8;
  height:100%; min-height:320px; padding:0 12px 12px; background:var(--dsb-bg); color:var(--dsb-text);
  display:flex; flex-direction:column; min-height:0; box-sizing:border-box;
  font-family:Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
body[data-ds-dark-theme] .dsb-root {
  --dsb-bg:#17171A; --dsb-panel:#232324; --dsb-item:#232324; --dsb-item-hover:#2E2E30;
  --dsb-item-active:#253557; --dsb-chat:#1D1D1F; --dsb-lead:#2E2E30; --dsb-bridge:#165DFF;
  --dsb-text:#F2F3F5; --dsb-muted:#86909C; --dsb-code-bg:#141414; --dsb-code-text:#E5E6EB;
  --dsb-input:#232324; --dsb-focus:#165DFF; --dsb-line:#2E2E30; --dsb-tag-bg:#232324;
  --dsb-scroll:#4E4E52; --dsb-scroll-hover:#63636A;
}
.dsb-root *, .dsb-root *::before, .dsb-root *::after { box-sizing:border-box; }
.dsb-topbar { height:56px; flex:0 0 56px; display:flex; align-items:center; gap:12px; padding:0 4px; }
.dsb-brand { font-size:16px; font-weight:600; letter-spacing:.01em; }
.dsb-top-actions { margin-left:auto; display:flex; align-items:center; gap:12px; }
.dsb-live { display:inline-flex; align-items:center; gap:6px; color:var(--dsb-muted); font-size:12px; }
.dsb-live-dot { width:6px; height:6px; border-radius:50%; background:#00B42A; }
.dsb-icon-btn { width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:8px; background:transparent; color:var(--dsb-muted); cursor:pointer; transition:background-color .2s ease; }
.dsb-icon-btn:hover { background:var(--dsb-item-hover); color:var(--dsb-text); }
.dsb-icon-btn svg { width:16px; height:16px; display:block; }
.dsb-main { flex:1; min-height:0; display:flex; gap:8px; }
.dsb-sidebar { width:300px; flex:0 0 300px; min-height:0; display:flex; flex-direction:column; background:var(--dsb-panel); border-radius:12px; overflow:hidden; }
.dsb-sidebar-head { flex:0 0 auto; display:flex; align-items:baseline; gap:6px; padding:16px 16px 6px; color:var(--dsb-muted); font-size:12px; }
.dsb-sidebar-head strong { color:var(--dsb-text); font-size:12px; font-weight:600; }
.dsb-sidebar-head .dsb-count { margin-left:auto; font-variant-numeric:tabular-nums; }
.dsb-list { flex:1; min-height:0; overflow-y:auto; padding:2px 0 8px; }
.dsb-thread { display:block; width:calc(100% - 16px); margin:4px 8px; padding:12px 14px; border:0; border-radius:8px; background:var(--dsb-item); color:var(--dsb-text); text-align:left; font:inherit; cursor:pointer; transition:background-color .2s ease; }
.dsb-thread:hover { background:var(--dsb-item-hover); }
.dsb-thread[data-active="true"] { background:var(--dsb-item-active); }
.dsb-thread-row { display:flex; align-items:baseline; gap:8px; min-width:0; }
.dsb-thread-title { font-size:14px; font-weight:500; line-height:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsb-thread-time { margin-left:auto; flex:0 0 auto; color:var(--dsb-muted); font-size:12px; font-variant-numeric:tabular-nums; }
.dsb-thread-preview { margin-top:4px; color:var(--dsb-muted); font-size:12px; line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsb-chat { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; background:var(--dsb-chat); border-radius:12px; overflow:hidden; }
.dsb-chat-head { flex:0 0 auto; padding:18px 24px 4px; }
.dsb-chat-title { font-size:14px; font-weight:600; line-height:22px; }
.dsb-chat-sub { margin-top:2px; color:var(--dsb-muted); font-size:12px; line-height:18px; }
.dsb-messages { flex:1; min-height:0; overflow-y:auto; padding:6px 24px 20px; display:flex; flex-direction:column; gap:12px; }
.dsb-date { align-self:center; margin:2px 0 4px; padding:2px 10px; border-radius:999px; background:var(--dsb-lead); color:var(--dsb-muted); font-size:12px; line-height:18px; }
.dsb-history { position:sticky; top:0; z-index:2; align-self:center; display:inline-flex; align-items:center; gap:6px; margin:0 0 4px; padding:3px 12px; border:1px dashed var(--dsb-line); border-radius:999px; background:var(--dsb-chat); color:var(--dsb-muted); font-size:12px; line-height:18px; cursor:pointer; }
.dsb-history:hover { color:var(--dsb-text); }
.dsb-card { width:100%; max-width:860px; border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:10px; }
.dsb-card[data-variant="lead"] { background:var(--dsb-lead); color:var(--dsb-text); --dsb-card-muted:var(--dsb-muted); --dsb-card-tag-bg:var(--dsb-tag-bg); --dsb-card-tag-text:var(--dsb-muted); --dsb-card-dot:var(--dsb-muted); }
.dsb-card[data-variant="bridge"] { background:var(--dsb-bridge); color:#FFFFFF; --dsb-card-muted:rgba(255,255,255,.72); --dsb-card-tag-bg:rgba(255,255,255,.16); --dsb-card-tag-text:#FFFFFF; --dsb-card-dot:rgba(255,255,255,.72); }
.dsb-card-head { display:flex; align-items:center; gap:8px; min-width:0; }
.dsb-sender { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; line-height:18px; }
.dsb-sender-dot { width:6px; height:6px; border-radius:50%; background:var(--dsb-card-dot); }
.dsb-tag { margin-left:auto; flex:0 0 auto; padding:1px 8px; border-radius:999px; background:var(--dsb-card-tag-bg); color:var(--dsb-card-tag-text); font-size:12px; line-height:18px; }
.dsb-body { font-size:14px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.dsb-foot { display:flex; align-items:center; gap:8px; color:var(--dsb-card-muted); font-size:12px; line-height:18px; }
.dsb-foot .dsb-thread-id { margin-left:auto; font-family:"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace; font-size:12px; }
.dsb-code { border-radius:6px; background:var(--dsb-code-bg); overflow:hidden; }
.dsb-code-head { display:flex; align-items:center; gap:8px; padding:8px 12px 0; color:rgba(255,255,255,.5); font-size:11px; line-height:16px; }
.dsb-copy { margin-left:auto; width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:6px; background:transparent; color:rgba(255,255,255,.55); cursor:pointer; transition:background-color .2s ease, color .2s ease; }
.dsb-copy:hover { background:rgba(255,255,255,.08); color:#FFFFFF; }
.dsb-copy svg { width:14px; height:14px; display:block; }
.dsb-code pre { margin:0; padding:4px 12px 12px; overflow-x:auto; color:var(--dsb-code-text); font-family:"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace; font-size:13px; line-height:1.5; }
.dsb-code code { font:inherit; white-space:pre; }
.dsb-composer { flex:0 0 auto; padding:12px 20px 18px; border-top:1px solid var(--dsb-line); display:flex; flex-direction:column; gap:6px; }
.dsb-composer-row { display:flex; gap:10px; align-items:center; }
.dsb-input { flex:1; min-width:0; height:44px; padding:0 14px; border-radius:10px; border:1px solid var(--dsb-line); background:var(--dsb-input); color:var(--dsb-text); font:inherit; font-size:14px; outline:none; }
.dsb-input:focus { border-color:var(--dsb-focus); }
.dsb-input::placeholder { color:var(--dsb-muted); }
.dsb-send { width:40px; height:40px; flex:0 0 40px; border:0; border-radius:10px; background:var(--dsb-bridge); color:#FFFFFF; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; }
.dsb-send:disabled { opacity:.5; cursor:default; }
.dsb-send svg { width:18px; height:18px; display:block; }
.dsb-send-error { color:var(--dsb-error, #F53F3F); font-size:12px; line-height:18px; }
.dsb-center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:32px; text-align:center; color:var(--dsb-muted); }
.dsb-center-title { color:var(--dsb-text); font-weight:600; font-size:14px; }
.dsb-error-strip { padding:8px 24px; color:#F53F3F; font-size:12px; }
.dsb-list::-webkit-scrollbar, .dsb-messages::-webkit-scrollbar, .dsb-code pre::-webkit-scrollbar { width:5px; height:5px; }
.dsb-list::-webkit-scrollbar-track, .dsb-messages::-webkit-scrollbar-track, .dsb-code pre::-webkit-scrollbar-track { background:transparent; }
.dsb-list::-webkit-scrollbar-thumb, .dsb-messages::-webkit-scrollbar-thumb, .dsb-code pre::-webkit-scrollbar-thumb { background:var(--dsb-scroll); border-radius:999px; }
.dsb-list::-webkit-scrollbar-thumb:hover, .dsb-messages::-webkit-scrollbar-thumb:hover, .dsb-code pre::-webkit-scrollbar-thumb:hover { background:var(--dsb-scroll-hover); }
@media (max-width: 760px) {
  .dsb-main { flex-direction:column; }
  .dsb-sidebar { width:auto; flex:0 0 auto; max-height:38%; }
  .dsb-chat-head { padding:14px 16px 4px; }
  .dsb-messages { padding:6px 16px 16px; }
  .dsb-composer { padding:10px 12px 14px; }
}
`

    /** @param {string} value @param {number} max */
    function summarize(value, max) {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim()
      return text.length <= max ? text : `${text.slice(0, max - 1)}…`
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

    /** Split one message body into text and fenced code segments. */
    function splitCode(text) {
      const parts = []
      const regex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g
      let last = 0
      let match
      while ((match = regex.exec(text)) !== null) {
        if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
        parts.push({
          type: 'code',
          language: (match[1] || 'PHP').toUpperCase(),
          code: match[2].replace(/\n$/, ''),
        })
        last = regex.lastIndex
      }
      if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
      return parts
    }

    /** @param {ReadableStream<Uint8Array>} body @param {(data: string) => void} onData @param {AbortSignal} signal */
    async function readEventStream(body, onData, signal) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const data = block.split('\n')
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart())
              .join('\n')
            if (data !== '') onData(data)
          }
          if (signal.aborted) return
        }
      } finally {
        reader.releaseLock()
      }
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
      const [connection, setConnection] = useState('connecting')
      const [selectedId, setSelectedId] = useState(null)
      const [expandedHistory, setExpandedHistory] = useState(false)
      const [draft, setDraft] = useState('')
      const [sending, setSending] = useState(false)
      const [sendError, setSendError] = useState(null)
      const mounted = useRef(true)
      const hasData = useRef(false)
      const messagesRef = useRef(null)

      const load = useCallback(async () => {
        setRefreshing(true)
        try {
          const response = await fetch(SNAPSHOT_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (!mounted.current) return
          hasData.current = true
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
        let disposed = false
        let controller = null
        let retryTimer = null
        let attempt = 0

        const connect = async () => {
          if (disposed) return
          controller = new AbortController()
          setConnection(attempt === 0 ? 'connecting' : 'reconnecting')
          try {
            const response = await fetch(EVENTS_URL, {
              headers: { accept: 'text/event-stream' },
              cache: 'no-store',
              signal: controller.signal,
            })
            if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
            attempt = 0
            setConnection('live')
            await readEventStream(response.body, data => {
              let frame
              try {
                frame = JSON.parse(data)
              } catch {
                return
              }
              if (frame.type === 'snapshot') {
                hasData.current = true
                setSnapshot(frame)
                setError(null)
                setLoading(false)
              } else if (frame.type === 'error') {
                setError(typeof frame.message === 'string' ? frame.message : 'event stream error')
              }
            }, controller.signal)
            if (!disposed) throw new Error('event stream closed')
          } catch (failure) {
            if (disposed) return
            setConnection('reconnecting')
            if (!hasData.current) setError(failure instanceof Error ? failure.message : String(failure))
            const delay = Math.min(15_000, 800 * 2 ** Math.min(attempt, 4))
            attempt += 1
            retryTimer = setTimeout(() => {
              retryTimer = null
              void connect()
            }, delay)
          }
        }

        void connect()
        return () => {
          disposed = true
          mounted.current = false
          controller?.abort()
          if (retryTimer !== null) clearTimeout(retryTimer)
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
          : `${id.slice(0, 8)}…${id.slice(-6)}`
      }
      const displayRole = role => role === 'lead'
        ? translate('role.lead', 'Lead')
        : role === 'direct'
          ? translate('role.direct', 'Bridge')
          : String(role)
      const peerOf = conversation => {
        if (currentSessionId === null) return null
        return conversation.participants.find(participant => participant.sessionId !== currentSessionId) ?? null
      }
      const conversationLabel = conversation => {
        const peer = peerOf(conversation)
        if (peer !== null) return nameOf(peer.sessionId) ?? displayRole(peer.role)
        return conversation.participants.map(participant => nameOf(participant.sessionId) ?? displayRole(participant.role)).join(' ⇄ ')
      }
      const kindLabel = kind => translate(`kind.${kind}`, String(kind))

      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const olderMessages = active === undefined ? [] : active.messages.filter(message => message.createdAt < todayStart.getTime())
      const todayMessages = active === undefined ? [] : active.messages.filter(message => message.createdAt >= todayStart.getTime())
      const visibleMessages = expandedHistory ? (active?.messages ?? []) : todayMessages
      const peer = active === undefined ? null : peerOf(active)
      const canSend = active !== undefined
        && peer !== null
        && typeof peer.sessionId === 'string'
        && peer.sessionId !== ''
        && currentSessionId !== null

      useEffect(() => {
        const node = messagesRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [active?.id, expandedHistory, active?.messages?.length])

      const selectConversation = id => {
        if (id === selectedId) return
        setSelectedId(id)
        setExpandedHistory(false)
        setSendError(null)
      }
      const copyCode = async code => {
        try {
          await navigator.clipboard.writeText(code)
        } catch {
          // Clipboard permission may be denied; the icon remains a visual cue.
        }
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

      const submit = async event => {
        event.preventDefault()
        if (!canSend || sending) return
        const text = draft.trim()
        if (text === '') return
        setSending(true)
        setSendError(null)
        try {
          const response = await fetch(SEND_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ fromSessionId: currentSessionId, toSessionId: peer.sessionId, text }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
          setDraft('')
        } catch (failure) {
          setSendError(`${translate('send.failed', 'Could not send')}: ${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setSending(false)
        }
      }

      const header = h('div', { className: 'dsb-topbar' },
        h('div', { className: 'dsb-brand' }, translate('title', 'Session bridge')),
        h('div', { className: 'dsb-top-actions' },
          h('span', { className: 'dsb-live' },
            h('span', { className: 'dsb-live-dot' }),
            connection === 'live' ? translate('live', 'Live') : translate('reconnecting', 'Reconnecting…'),
          ),
          h('button', {
            type: 'button',
            className: 'dsb-icon-btn',
            title: translate('refresh', 'Refresh'),
            'aria-label': translate('refresh', 'Refresh'),
            onClick: () => { void load() },
            disabled: refreshing,
          },
            h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.75' }),
              h('path', { d: 'M13.2 2.8v3.2H10' }),
            ),
          ),
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
            h('button', { type: 'button', className: 'dsb-icon-btn', onClick: () => { void load() }, disabled: refreshing },
              translate('retry', 'Retry')),
          ))
      }
      if (ordered.length === 0) {
        return h('div', { className: 'dsb-root' }, h('style', null, CSS), header, errorStrip,
          center(translate('empty.title', 'No bridge messages yet'),
            translate('empty.hint', 'Mention another session with @ and send a message; the conversation appears here.')))
      }

      const list = h('aside', { className: 'dsb-sidebar' },
        h('div', { className: 'dsb-sidebar-head' },
          h('strong', null, translate('list.title', 'Conversations')),
          h('span', { className: 'dsb-count' }, String(ordered.length)),
        ),
        h('nav', { className: 'dsb-list', role: 'list' },
          ordered.map(conversation => {
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
              h('span', { className: 'dsb-thread-row' },
                h('span', { className: 'dsb-thread-title' }, conversationLabel(conversation)),
                h('span', { className: 'dsb-thread-time' }, formatClock(conversation.updatedAt)),
              ),
              h('span', { className: 'dsb-thread-preview' },
                last === undefined ? '' : `${displayRole(last.fromRole)}: ${summarize(last.content, 80)}`),
            )
          }),
        ),
      )

      let chat = center(translate('empty.title', 'No bridge messages yet'), null)
      if (active !== undefined) {
        const chatLabel = conversationLabel(active)
        const chatSubtitle = [
          peer === null ? null : displayRole(peer.role),
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

        const rendered = []
        let lastDay = null
        for (const message of visibleMessages) {
          const key = dayKey(message.createdAt)
          if (key !== lastDay) {
            rendered.push(h('div', { key: `day-${key}`, className: 'dsb-date' }, dayLabel(message.createdAt)))
            lastDay = key
          }
          const variant = message.kind === 'reply' ? 'bridge' : 'lead'
          const parts = splitCode(String(message.content ?? ''))
          const body = []
          parts.forEach((part, index) => {
            if (part.type === 'text') {
              const text = part.text.trim()
              if (text !== '') body.push(h('div', { key: `text-${index}`, className: 'dsb-body' }, text))
              return
            }
            body.push(h('div', { key: `code-${index}`, className: 'dsb-code' },
              h('div', { className: 'dsb-code-head' },
                h('span', null, part.language),
                h('button', {
                  type: 'button',
                  className: 'dsb-copy',
                  title: translate('copy', 'Copy code'),
                  'aria-label': translate('copy', 'Copy code'),
                  onClick: () => { void copyCode(part.code) },
                },
                  h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' },
                    h('rect', { x: 5.5, y: 5.5, width: 7, height: 7, rx: 1.2 }),
                    h('path', { d: 'M10.5 5.5V4.2A1.2 1.2 0 0 0 9.3 3H4.2A1.2 1.2 0 0 0 3 4.2v5.1a1.2 1.2 0 0 0 1.2 1.2h1.3' }),
                  ),
                ),
              ),
              h('pre', null, h('code', null, part.code)),
            ))
          })
          rendered.push(h('article', {
            key: message.id,
            className: 'dsb-card',
            'data-variant': variant,
          },
            h('header', { className: 'dsb-card-head' },
              h('span', { className: 'dsb-sender' },
                h('span', { className: 'dsb-sender-dot' }),
                displayRole(message.fromRole),
              ),
              h('span', { className: 'dsb-tag' }, kindLabel(message.kind)),
            ),
            body,
            h('footer', { className: 'dsb-foot' },
              h('span', null, formatClock(message.createdAt)),
              h('span', { className: 'dsb-thread-id' }, `#${message.threadId}`),
            ),
          ))
        }

        const placeholder = !canSend
          ? peer === null
            ? translate('send.blocked', 'Current session is not in this conversation')
            : translate('send.unbound', 'The peer session is not bound yet')
          : translate('send.placeholder', 'Type a message, Enter to send…')

        chat = h('section', { className: 'dsb-chat' },
          h('header', { className: 'dsb-chat-head' },
            h('div', { className: 'dsb-chat-title' }, chatLabel),
            h('div', { className: 'dsb-chat-sub' }, chatSubtitle),
          ),
          h('div', { className: 'dsb-messages', ref: messagesRef },
            historyBar,
            visibleMessages.length === 0
              ? h('div', { className: 'dsb-center' },
                h('div', { className: 'dsb-center-title' }, translate('history.emptyToday', 'No messages today yet')),
                h('div', null, translate('history.hint', 'Expand earlier messages to read the history.')),
              )
              : rendered,
          ),
          h('form', { className: 'dsb-composer', onSubmit: submit },
            h('div', { className: 'dsb-composer-row' },
              h('input', {
                className: 'dsb-input',
                type: 'text',
                value: draft,
                placeholder,
                disabled: !canSend || sending,
                'aria-label': translate('send.placeholder', 'Type a message'),
                onChange: event => setDraft(event.target.value),
              }),
              h('button', {
                type: 'submit',
                className: 'dsb-send',
                disabled: !canSend || sending || draft.trim() === '',
                title: translate('send.button', 'Send'),
                'aria-label': translate('send.button', 'Send'),
              },
                h('svg', { viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
                  h('path', { d: 'M3 9h11' }),
                  h('path', { d: 'M9.5 4.5 14 9l-4.5 4.5' }),
                ),
              ),
            ),
            sendError === null ? null : h('div', { className: 'dsb-send-error' }, sendError),
          ),
        )
      }

      return h('div', { className: 'dsb-root' }, h('style', null, CSS), header, errorStrip,
        h('div', { className: 'dsb-main' }, list, chat))
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

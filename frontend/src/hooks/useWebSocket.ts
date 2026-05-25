import { useRef, useState, useCallback, useEffect } from 'react'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface ServerMessage {
  type: string
  sessionId: string
  data: Record<string, unknown>
}

export interface UseWebSocketOptions {
  url?: string
  onMessage?: (msg: ServerMessage) => void
  onConnect?: (sessionId: string) => void
  onDisconnect?: () => void
  reconnectDelay?: number
  maxRetries?: number
}

const RESUME_SESSION_KEY = 'kshana.sessionId'

function readStoredSessionId(): string | null {
  try {
    return window.localStorage.getItem(RESUME_SESSION_KEY)
  } catch {
    return null
  }
}

function writeStoredSessionId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(RESUME_SESSION_KEY, id)
    else window.localStorage.removeItem(RESUME_SESSION_KEY)
  } catch {
    // localStorage may be disabled — fail silently. Resume won't work but
    // the chat itself still does.
  }
}

/** Module-level handle so non-React code (e.g. a top-bar "New chat" button) can
 *  drop the cached session id without going through the hook. */
export function clearStoredSessionId(): void {
  writeStoredSessionId(null)
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    url: baseUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/v1/ws/chat`,
    onMessage,
    onConnect,
    onDisconnect,
    reconnectDelay = 2000,
    maxRetries = 10,
  } = options

  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriesRef = useRef(0)
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Store callbacks in refs so they don't trigger reconnects
  const onMessageRef = useRef(onMessage)
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)
  onMessageRef.current = onMessage
  onConnectRef.current = onConnect
  onDisconnectRef.current = onDisconnect

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && sessionIdRef.current) {
      wsRef.current.send(JSON.stringify({
        ...msg,
        sessionId: sessionIdRef.current,
      }))
    }
  }, [])

  const connect = useCallback(() => {
    if (!mountedRef.current) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return

    setStatus('connecting')
    // Pull cached id from localStorage. Server treats it as a hint —
    // unknown ids fall back to a fresh session, so the cache going stale
    // is harmless.
    const stored = sessionIdRef.current ?? readStoredSessionId()
    const url = stored
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(stored)}`
      : baseUrl
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return }
      retriesRef.current = 0
      setStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data)

        // Capture session ID from first status message AND any subsequent
        // status that announces a NEW id (e.g. after history_cleared).
        // Persist to localStorage so the next mount can resume.
        if (msg.type === 'status' && msg.sessionId) {
          if (!sessionIdRef.current) {
            sessionIdRef.current = msg.sessionId
            setSessionId(msg.sessionId)
            writeStoredSessionId(msg.sessionId)
            onConnectRef.current?.(msg.sessionId)
          } else if (msg.sessionId !== sessionIdRef.current) {
            sessionIdRef.current = msg.sessionId
            setSessionId(msg.sessionId)
            writeStoredSessionId(msg.sessionId)
          }
        }

        // history_cleared carries the authoritative new sessionId; refresh
        // the cache eagerly so a reload picks it up even if the next
        // status hasn't arrived yet.
        if (msg.type === 'history_cleared' && msg.sessionId) {
          sessionIdRef.current = msg.sessionId
          setSessionId(msg.sessionId)
          writeStoredSessionId(msg.sessionId)
        }

        onMessageRef.current?.(msg)
      } catch {
        // Ignore malformed messages
      }
    }

    ws.onclose = (event) => {
      if (!mountedRef.current) return
      const isCurrentSocket = wsRef.current === ws
      if (isCurrentSocket) {
        setStatus('disconnected')
        wsRef.current = null
        onDisconnectRef.current?.()
      }

      // When another tab/window resumes the same session, the server
      // intentionally closes this older socket. Reconnecting here makes
      // duplicate tabs fight forever and spams "Replacing stale socket".
      if (event.code === 1000 && event.reason === 'session_resumed_elsewhere') {
        return
      }

      // If a newer socket already replaced this one inside this hook, this
      // close event is stale and must not schedule another reconnect.
      if (!isCurrentSocket) return

      // Exponential backoff reconnect
      if (retriesRef.current < maxRetries) {
        const delay = reconnectDelay * Math.pow(1.5, retriesRef.current)
        retriesRef.current++
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect()
        }, Math.min(delay, 30000)) // cap at 30s
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }
  }, [baseUrl, reconnectDelay, maxRetries]) // Only depends on config, not callbacks

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    wsRef.current?.close()
    wsRef.current = null
    sessionIdRef.current = null
    setSessionId(null)
    setStatus('disconnected')
  }, [])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      disconnect()
    }
  }, [connect, disconnect])

  return { status, sessionId, send, connect, disconnect }
}

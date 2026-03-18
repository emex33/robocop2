import { useState, useEffect, useRef, useCallback } from 'react';
import { getToken } from '../lib/api';

/**
 * React hook for connecting to the ROBOCOP WebSocket server.
 * Automatically reconnects on disconnect.
 * Filters events by campaignId if provided.
 */
export function useWebSocket(campaignId = null) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const listenersRef = useRef(new Map());
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}?token=${token}`);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // If filtering by campaignId, skip events for other campaigns
        if (campaignId && msg.data?.campaignId && msg.data.campaignId !== campaignId) return;

        const handlers = listenersRef.current.get(msg.type);
        if (handlers) {
          handlers.forEach(fn => fn(msg.data));
        }
      } catch (err) {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 2 seconds
      reconnectRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [campaignId]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, [connect]);

  const on = useCallback((type, handler) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type).add(handler);

    // Return unsubscribe function
    return () => {
      listenersRef.current.get(type)?.delete(handler);
    };
  }, []);

  return { connected, on };
}

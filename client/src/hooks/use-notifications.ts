import { useState, useEffect, useCallback, useRef } from "react";
import { api, resolveApiBase } from "@/lib/api";

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export function useNotifications(limit: number = 20) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ notifications: Notification[] }>(
        `/notifications/list?limit=${limit}`
      );
      setNotifications(data.notifications);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  return { notifications, loading, error, refetch: fetchNotifications };
}

export function useUnreadCount() {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    try {
      const data = await api<{ count: number }>("/notifications/unread-count");
      setCount(data.count);
    } catch (err) {
      console.error("Failed to load unread count:", err);
    }
  }, []);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  return { count, refetch: fetchCount };
}

/**
 * Subscribe to SSE notification stream.
 * Returns the unread count and auto-updates on new notifications.
 */
export function useNotificationStream() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [latestNotification, setLatestNotification] = useState<Notification | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch initial unread count
  useEffect(() => {
    api<{ count: number }>("/notifications/unread-count")
      .then((data) => setUnreadCount(data.count))
      .catch(console.error);
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    const apiBase = resolveApiBase(
      (import.meta as any).env ?? {},
      typeof window !== "undefined" ? window.location : undefined
    );
    const eventSourceUrl = `${apiBase.replace(/\/api$/, "")}/api/notifications/stream`;
    let isClosing = false;
    const es = new EventSource(eventSourceUrl, { withCredentials: true });
    eventSourceRef.current = es;

    es.addEventListener("notification", (event) => {
      try {
        const notification: Notification = JSON.parse(event.data);
        setLatestNotification(notification);
        setUnreadCount((prev) => prev + 1);
      } catch (err) {
        console.error("[SSE] Failed to parse notification:", err);
      }
    });

    es.addEventListener("connected", () => {
      console.log("[SSE] Connected to notification stream");
    });

    es.onerror = () => {
      // Ignore the expected browser-side disconnect during cleanup/navigation.
      if (isClosing || es.readyState === EventSource.CLOSED) {
        return;
      }

      // EventSource auto-reconnects -- just log
      console.warn("[SSE] Connection error -- will auto-reconnect");
    };

    return () => {
      isClosing = true;
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const markAsRead = useCallback(async (notificationId: string) => {
    await api(`/notifications/${notificationId}/read`, { method: "POST" });
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const markAllAsRead = useCallback(async () => {
    await api("/notifications/read-all", { method: "POST" });
    setUnreadCount(0);
  }, []);

  return { unreadCount, latestNotification, markAsRead, markAllAsRead };
}

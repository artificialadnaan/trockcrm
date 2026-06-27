import { useCallback, useRef, useState } from "react";
import { getCsrfToken } from "@/lib/api";
import {
  applyChatFrame,
  emptyTurn,
  parseSseBuffer,
  type ChatSegment,
  type ChatTurnState,
} from "./ai-chat-protocol";

export type ChatTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; state: ChatTurnState };

const CSRF_HEADER = "x-csrf-token";

function segmentsToText(segments: ChatSegment[]): string {
  return segments
    .filter((s): s is { type: "text"; text: string } => s.type === "text")
    .map((s) => s.text)
    .join("");
}

/** History payload for the API: user text + the assistant's prose from each completed turn. */
function toApiMessages(turns: ChatTurn[]): Array<{ role: "user" | "assistant"; content: string }> {
  return turns
    .map((t) => (t.role === "user" ? { role: "user" as const, content: t.text } : { role: "assistant" as const, content: segmentsToText(t.state.segments) }))
    .filter((m) => m.content.length > 0);
}

/**
 * React hook driving the T Rock AI chat. Uses RAW fetch (the shared api() helper JSON-parses the
 * body and can't stream); mirrors its credentials + CSRF conventions. Charts render only from the
 * validated `chart` segments the pure reducer produces — never by parsing assistant text.
 */
export function useAiChatStream() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const turnsRef = useRef<ChatTurn[]>([]);
  turnsRef.current = turns;

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    const history: ChatTurn[] = [...turnsRef.current, { role: "user", text: trimmed }];
    let assistant: ChatTurnState = emptyTurn();
    setTurns([...history, { role: "assistant", state: assistant }]);
    setStreaming(true);

    const pushAssistant = (next: ChatTurnState) => {
      assistant = next;
      setTurns([...history, { role: "assistant", state: next }]);
    };

    try {
      const csrf = getCsrfToken();
      const resp = await fetch("/api/ai-chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(csrf ? { [CSRF_HEADER]: csrf } : {}) },
        body: JSON.stringify({ messages: toApiMessages(history) }),
      });
      if (!resp.ok || !resp.body) {
        pushAssistant({ ...assistant, error: `Chat failed (${resp.status})`, done: true });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseBuffer(buffer);
        buffer = rest;
        for (const f of frames) pushAssistant(applyChatFrame(assistant, f));
      }
    } catch (err) {
      pushAssistant({ ...assistant, error: err instanceof Error ? err.message : "stream error", done: true });
    } finally {
      setStreaming(false);
    }
  }, [streaming]);

  return { turns, streaming, sendMessage };
}

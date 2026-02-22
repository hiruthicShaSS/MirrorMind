/**
 * Gemini Live API integration for real-time, interruptible voice/text agent.
 * See: https://ai.google.dev/gemini-api/docs/live
 * Uses @google/genai ai.live.connect() for server-to-server Live sessions.
 * Message handling follows the official sample: serverContent.modelTurn.parts
 * with inlineData (audio), fileData, and text; turnComplete for turn end.
 */

import { GoogleGenAI, LiveServerMessage, MediaResolution, Modality } from "@google/genai";
import { parseStructuredResponse } from "./geminiService";
import { SYSTEM_PROMPT_EXPORT } from "./geminiService";

const apiKey = process.env.GOOGLE_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

/** Live/bidi models to try in order (first success wins). Text-capable first, then native-audio. Override with GEMINI_LIVE_MODEL to try only one. */
const LIVE_MODELS = process.env.GEMINI_LIVE_MODEL
  ? [process.env.GEMINI_LIVE_MODEL]
  : [
      "gemini-2.5-flash-native-audio-preview-12-2025",
      "gemini-live-2.5-flash-preview-native-audio-09-2025",
      "gemini-live-2.5-flash-native-audio",
      "gemini-live-2.5-flash-preview-native-audio",
    ];

let lastTriedModelIndex = -1;

export interface LiveSessionCallbacks {
  onText?: (text: string) => void;
  onAudio?: (base64Data: string, mimeType?: string) => void;
  onInterrupted?: () => void;
  onTurnComplete?: (fullText: string, conceptMap: Record<string, string[]>, feasibilitySignal: number | null) => void;
  onError?: (message: string) => void;
  onClose?: (reason?: string) => void;
}

export type LiveSession = Awaited<ReturnType<typeof connectLiveSession>>;

/** Normalize SDK or raw WebSocket message to LiveServerMessage-like shape (camelCase, serverContent.modelTurn.parts). */
function normalizeLiveMessage(message: LiveServerMessage | unknown): LiveServerMessage | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.serverContent && typeof m.serverContent === "object") {
    return message as LiveServerMessage;
  }
  const raw = m.data !== undefined ? m.data : message;
  let parsed: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === "object" && raw !== null) {
    parsed = raw as Record<string, unknown>;
  } else {
    return null;
  }
  const serverContent = (parsed.serverContent ?? parsed.server_content) as Record<string, unknown> | undefined;
  if (!serverContent) return null;
  const modelTurn = (serverContent.modelTurn ?? serverContent.model_turn) as { parts?: Array<Record<string, unknown>> } | undefined;
  const parts = modelTurn?.parts?.map((p) => ({
    text: p.text as string | undefined,
    inlineData: (p.inlineData ?? p.inline_data) as { data?: string; mimeType?: string } | undefined,
    fileData: (p.fileData ?? p.file_data) as { fileUri?: string } | undefined,
  }));
  return {
    serverContent: {
      interrupted: serverContent.interrupted as boolean | undefined,
      turnComplete: (serverContent.turnComplete ?? serverContent.turn_complete) as boolean | undefined,
      modelTurn: parts ? { parts } : undefined,
      outputTranscription: (serverContent.outputTranscription ?? serverContent.output_transcription) as { text?: string } | undefined,
    },
  } as LiveServerMessage;
}

/**
 * Connect to Gemini Live API and return a session that can send client content
 * and receive server content (text/audio). Callbacks are invoked for streaming and turn completion.
 */
function isModelNotFoundOrUnsupported(reason?: string): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return (
    r.includes("not found") ||
    r.includes("not supported") ||
    r.includes("bidiGenerateContent") ||
    r.includes("extract voices") ||
    r.includes("non-audio request") ||
    r.includes("invalid argument")
  );
}

export async function connectLiveSession(callbacks: LiveSessionCallbacks): Promise<{
  sendText: (text: string, turnComplete?: boolean) => void;
  sendAudio: (base64Data: string, mimeType?: string) => void;
  close: () => void;
}> {
  if (!ai) throw new Error("GOOGLE_API_KEY not set");

  let fullTextBuffer = "";
  let lastError: Error | null = null;
  const startIndex =
    LIVE_MODELS.length > 1 && lastTriedModelIndex >= 0
      ? (lastTriedModelIndex + 1) % LIVE_MODELS.length
      : 0;

  for (let i = 0; i < LIVE_MODELS.length; i++) {
    const idx = (startIndex + i) % LIVE_MODELS.length;
    lastTriedModelIndex = idx;
    const modelId = LIVE_MODELS[idx];
    let connectionReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      connectionReady = resolve;
    });
    let openedResolve: () => void;
    let openedReject: (err: Error) => void;
    let didOpen = false;
    const openedPromise = new Promise<void>((resolve, reject) => {
      openedResolve = () => { didOpen = true; resolve(); };
      openedReject = reject;
    });

    if (process.env.NODE_ENV !== "production") console.log("[Live] Trying model:", modelId);

    const isNativeAudio = /native-audio|-\d{4}$/.test(modelId) || modelId.endsWith("-audio");
    // Native audio models (e.g. gemini-2.5-flash-native-audio-preview-12-2025) require AUDIO-only
    // response; [TEXT, AUDIO] can cause "Request contains an invalid argument".
    const responseModalities = isNativeAudio ? [Modality.AUDIO] : [Modality.TEXT];
    const config: Record<string, unknown> = {
      systemInstruction: SYSTEM_PROMPT_EXPORT,
      responseModalities,
    };
    if (isNativeAudio) {
      config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } } };
      config.mediaResolution = MediaResolution.MEDIA_RESOLUTION_MEDIUM;
      config.contextWindowCompression = {
        triggerTokens: "25600",
        slidingWindow: { targetTokens: "12800" },
      };
      // Request output transcription so we can still parse concept map from the model's reply.
      config.outputAudioTranscription = {};
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("[Live] Connect request:", JSON.stringify({
        model: modelId,
        config: {
          responseModalities,
          systemInstruction: "(string, length " + SYSTEM_PROMPT_EXPORT.length + ")",
          ...(config.speechConfig ? { speechConfig: config.speechConfig } : {}),
        },
      }));
    }

    let sessionClosed = false;
    const setClosed = () => { sessionClosed = true; };

    // Default mimeType when Gemini doesn't send one (native audio is typically 24kHz PCM).
    const NATIVE_AUDIO_MIME = "audio/pcm;rate=24000";

    const session = await ai.live.connect({
      model: modelId,
      config: config as Parameters<typeof ai.live.connect>[0]["config"],
      callbacks: {
        onopen: () => {
          if (process.env.NODE_ENV !== "production") console.log("[Live] WebSocket open, connection ready, model:", modelId);
          connectionReady!();
          openedResolve!();
        },
        onmessage: (message: LiveServerMessage | unknown) => {
        // SDK may pass LiveServerMessage directly or a raw event with message.data (string or object)
        const msg = normalizeLiveMessage(message);
        const serverContent = msg?.serverContent;
        if (!serverContent) {
          if (process.env.NODE_ENV !== "production" && message != null && typeof message === "object") {
            const raw = (message as { data?: unknown }).data ?? message;
            const keys = typeof raw === "object" && raw !== null ? Object.keys(raw as object) : typeof raw === "string" ? "(string)" : "(other)";
            console.log("[Live] onmessage (no serverContent) keys:", keys);
          }
          return;
        }

        if (serverContent.interrupted) {
          fullTextBuffer = "";
          callbacks.onInterrupted?.();
          return;
        }

        // Handle model turn exactly like Google sample: serverContent.modelTurn.parts — inlineData (audio), fileData, text
        const parts = serverContent.modelTurn?.parts;
        if (parts?.length) {
          for (const part of parts) {
            if (part.fileData?.fileUri && process.env.NODE_ENV !== "production") {
              console.log("[Live] File:", part.fileData.fileUri);
            }
            if (part.inlineData?.data) {
              callbacks.onAudio?.(part.inlineData.data, part.inlineData.mimeType ?? NATIVE_AUDIO_MIME);
            }
            if (part.text) {
              fullTextBuffer += part.text;
              callbacks.onText?.(part.text);
            }
          }
        }

        // Output transcription (AUDIO-only mode): text of what the model said — show in UI alongside audio
        const outTrans = serverContent.outputTranscription ?? (serverContent as { output_transcription?: { text?: string } }).output_transcription;
        const transText = outTrans?.text;
        if (transText) {
          fullTextBuffer += transText;
          callbacks.onText?.(transText);
        }

        const { conceptMap, feasibilitySignal } = parseStructuredResponse(fullTextBuffer);
        const hasStructured = Object.keys(conceptMap).length > 0 || feasibilitySignal != null;
        if (serverContent.turnComplete || hasStructured) {
          callbacks.onTurnComplete?.(fullTextBuffer, conceptMap, feasibilitySignal);
          fullTextBuffer = "";
        }
      },
      onerror: (e: { message?: string }) => {
        const errMsg = e?.message ?? "Unknown error";
        console.error("[Live] Error:", errMsg);
        callbacks.onError?.(errMsg);
      },
      onclose: (e: { reason?: string }) => {
        setClosed();
        if (process.env.NODE_ENV !== "production") console.log("[Live] WebSocket closed, reason:", e?.reason ?? "(none)");
        if (!didOpen && isModelNotFoundOrUnsupported(e?.reason)) {
          openedReject!(new Error(e?.reason ?? "Model not available"));
        }
        if (fullTextBuffer.trim()) {
          const { conceptMap, feasibilitySignal } = parseStructuredResponse(fullTextBuffer);
          callbacks.onTurnComplete?.(fullTextBuffer, conceptMap, feasibilitySignal);
        }
        callbacks.onClose?.(e?.reason ?? undefined);
      },
    },
  });

    try {
      await openedPromise;
      return {
    sendText: async (text: string, turnComplete = true) => {
      if (sessionClosed) throw new Error("Live connection closed. Reconnect to try another model.");
      await readyPromise;
      (session as { sendClientContent?: (opts: unknown) => void }).sendClientContent?.({
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete,
      });
    },
    sendAudio: async (base64Data: string, mimeType = "audio/pcm;rate=16000") => {
      if (sessionClosed) throw new Error("Live connection closed. Reconnect to try another model.");
      await readyPromise;
      (session as { sendRealtimeInput?: (opts: unknown) => void }).sendRealtimeInput?.({
        audio: { data: base64Data, mimeType },
      });
    },
    close: () => {
      setClosed();
      (session as { close?: () => void }).close?.();
    },
  };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      (session as { close?: () => void }).close?.();
      if (process.env.NODE_ENV !== "production") console.warn("[Live] Model failed:", modelId, (lastError as Error).message.slice(0, 80));
    }
  }

  throw lastError ?? new Error("No Live model available for bidiGenerateContent. Set GEMINI_LIVE_MODEL to a valid model ID.");
}

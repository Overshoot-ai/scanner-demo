import React, {
  useImperativeHandle,
  forwardRef,
  useRef,
  useState,
  useEffect,
} from "react";

interface VisionReport {
  id: string;
  content: string;
  timestamp: number;
  priority: "high" | "medium" | "low";
  latency: number;
}

interface NarratorEngineProps {
  openaiKey: string;
  isMuted: boolean;
  isActive: boolean;
}

export interface NarratorEngineRef {
  addReport: (report: VisionReport) => void;
  start: () => void;
  stop: () => void;
  setMuted: (muted: boolean) => void;
}

const NarratorEngine = forwardRef<NarratorEngineRef, NarratorEngineProps>(
  ({ openaiKey, isMuted, isActive }, ref) => {
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [currentText, setCurrentText] = useState("");

    const reportsQueueRef = useRef<VisionReport[]>([]);
    const spokenContentRef = useRef<Set<string>>(new Set());
    const conversationHistoryRef = useRef<string[]>([]);
    const isRunningRef = useRef(false);
    const audioContextRef = useRef<AudioContext | null>(null);
    const isMutedRef = useRef(isMuted);
    const lastNarrationTimeRef = useRef<number>(0);
    const isGeneratingRef = useRef(false);
    const isSpeakingRef = useRef(false);
    const wsRef = useRef<WebSocket | null>(null);
    const currentResponseIdRef = useRef<string | null>(null);
    const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);

    useEffect(() => {
      isMutedRef.current = isMuted;
    }, [isMuted]);

    const initAudioContext = () => {
      if (!audioContextRef.current) {
        audioContextRef.current = new (
          window.AudioContext || (window as any).webkitAudioContext
        )({
          sampleRate: 24000,
        });
      }
    };

    const addReport = (report: VisionReport) => {
      reportsQueueRef.current.push(report);
      if (reportsQueueRef.current.length > 15) {
        reportsQueueRef.current.shift();
      }
    };

    const getRecentReports = (maxAge: number = 10000): VisionReport[] => {
      const now = Date.now();
      return reportsQueueRef.current
        .filter((r) => now - r.timestamp < maxAge)
        .sort((a, b) => {
          const priorityWeight = { high: 3, medium: 2, low: 1 };
          const priorityDiff =
            priorityWeight[b.priority] - priorityWeight[a.priority];
          if (priorityDiff !== 0) return priorityDiff;
          return b.timestamp - a.timestamp;
        });
    };

    const stopAllAudio = () => {
      audioSourcesRef.current.forEach((source) => {
        try {
          source.stop();
        } catch (e) {
          // Already stopped
        }
      });
      audioSourcesRef.current = [];
      setIsSpeaking(false);
      isSpeakingRef.current = false;
    };

    const playAudioChunk = (pcmData: Int16Array, responseId: string) => {
      if (isMutedRef.current || !audioContextRef.current) return;

      if (responseId !== currentResponseIdRef.current) {
        return;
      }

      const audioBuffer = audioContextRef.current.createBuffer(
        1,
        pcmData.length,
        audioContextRef.current.sampleRate,
      );

      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcmData.length; i++) {
        channelData[i] = pcmData[i] / 32768.0;
      }

      const source = audioContextRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current.destination);

      audioSourcesRef.current.push(source);
      setIsSpeaking(true);
      isSpeakingRef.current = true;

      source.onended = () => {
        const index = audioSourcesRef.current.indexOf(source);
        if (index > -1) {
          audioSourcesRef.current.splice(index, 1);
        }

        if (audioSourcesRef.current.length === 0) {
          setTimeout(() => {
            if (audioSourcesRef.current.length === 0) {
              setIsSpeaking(false);
              isSpeakingRef.current = false;
            }
          }, 100);
        }
      };

      source.start();
    };

    const connectRealtimeAPI = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      initAudioContext();

      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`,
        [
          "realtime",
          `openai-insecure-api-key.${openaiKey}`,
          "openai-beta.realtime-v1",
        ],
      );

      ws.onopen = () => {
        console.log("OpenAI Realtime connected");

        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions: `You are a real-time narrator describing what a camera sees. Generate SHORT, natural phrases (3-8 words) that continue the narration. Be conversational and casual. Focus on what's most interesting or important. Don't repeat yourself.`,
              voice: "alloy",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              turn_detection: null,
            },
          }),
        );
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "response.created":
            currentResponseIdRef.current = message.response.id;
            break;

          case "response.audio.delta":
            if (message.delta && currentResponseIdRef.current) {
              const audioData = Uint8Array.from(atob(message.delta), (c) =>
                c.charCodeAt(0),
              );
              const pcmData = new Int16Array(audioData.buffer);
              playAudioChunk(pcmData, currentResponseIdRef.current);
            }
            break;

          case "response.text.delta":
            if (message.delta) {
              setCurrentText((prev) => prev + message.delta);
            }
            break;

          case "response.text.done":
            const text = message.text;
            if (text) {
              conversationHistoryRef.current.push(text);
              if (conversationHistoryRef.current.length > 20) {
                conversationHistoryRef.current.shift();
              }
            }
            break;

          case "response.done":
            isGeneratingRef.current = false;
            currentResponseIdRef.current = null;
            break;

          case "error":
            console.error("OpenAI Realtime error:", message);
            isGeneratingRef.current = false;
            currentResponseIdRef.current = null;
            stopAllAudio();
            break;
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        isGeneratingRef.current = false;
        stopAllAudio();
      };

      ws.onclose = () => {
        console.log("OpenAI Realtime disconnected");
        wsRef.current = null;
      };

      wsRef.current = ws;
    };

    const generateNarration = () => {
      if (isGeneratingRef.current || isSpeakingRef.current) {
        return;
      }

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connectRealtimeAPI();
        return;
      }

      const recentReports = getRecentReports();
      if (recentReports.length === 0) return;

      const unspokenReports = recentReports.filter(
        (r) => !spokenContentRef.current.has(r.content),
      );

      if (
        unspokenReports.length === 0 &&
        Date.now() - lastNarrationTimeRef.current < 3000
      ) {
        return;
      }

      const reportsToMention =
        unspokenReports.length > 0
          ? unspokenReports.slice(0, 3)
          : recentReports.slice(0, 2);

      const reportsContext = reportsToMention
        .map((r) => `[${r.priority.toUpperCase()}] ${r.content}`)
        .join("\n");

      const recentHistory = conversationHistoryRef.current.slice(-5).join(" ");

      const prompt = `Recent observations:
${reportsContext}

${recentHistory ? `You've been saying: "${recentHistory}"` : ""}

Generate a short conversational phrase (3-8 words) continuing your narration.`;

      setCurrentText("");
      isGeneratingRef.current = true;

      wsRef.current.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt,
              },
            ],
          },
        }),
      );

      wsRef.current.send(
        JSON.stringify({
          type: "response.create",
        }),
      );

      reportsToMention.forEach((r) => spokenContentRef.current.add(r.content));
      lastNarrationTimeRef.current = Date.now();
    };

    const narratorLoop = async () => {
      while (isRunningRef.current) {
        if (isGeneratingRef.current || isSpeakingRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        try {
          generateNarration();

          while (
            (isGeneratingRef.current || isSpeakingRef.current) &&
            isRunningRef.current
          ) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }

          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          console.error("Narrator loop error:", error);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };

    const start = () => {
      if (isRunningRef.current) return;

      isRunningRef.current = true;
      spokenContentRef.current.clear();
      conversationHistoryRef.current = [];
      lastNarrationTimeRef.current = 0;
      isGeneratingRef.current = false;
      isSpeakingRef.current = false;

      connectRealtimeAPI();
      narratorLoop();
    };

    const stop = () => {
      isRunningRef.current = false;
      isGeneratingRef.current = false;

      stopAllAudio();

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      setCurrentText("");
      reportsQueueRef.current = [];
      currentResponseIdRef.current = null;
    };

    const setMuted = (muted: boolean) => {
      if (muted) {
        stopAllAudio();
      }
    };

    useImperativeHandle(ref, () => ({
      addReport,
      start,
      stop,
      setMuted,
    }));

    return (
      <>
        {isSpeaking && currentText && (
          <div className="absolute bottom-32 left-4 right-4 z-10">
            <div className="bg-black/80 backdrop-blur-sm text-white p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span className="text-xs font-medium text-green-400">
                  Speaking
                </span>
              </div>
              <p className="text-sm leading-relaxed">{currentText}</p>
            </div>
          </div>
        )}
      </>
    );
  },
);

NarratorEngine.displayName = "NarratorEngine";

export default NarratorEngine;

import React, { useState, useRef } from "react";
import { RealtimeVision } from "@overshoot/sdk";
import type { StreamInferenceResult } from "@overshoot/sdk";
import { Camera, Mic, MicOff, Settings, X } from "lucide-react";
import NarratorEngine from "./components/NarratorEngine";
import ReportsList from "./components/ReportsList";
import SettingsModal from "./components/SettingsModal";

interface VisionReport {
  id: string;
  content: string;
  timestamp: number;
  priority: "high" | "medium" | "low";
  latency: number;
}

function App() {
  const [isActive, setIsActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [reports, setReports] = useState<VisionReport[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");

  // API Keys - try localStorage first, then fall back to environment variables
  const [overshootKey, setOvershootKey] = useState(
    localStorage.getItem("overshoot_key") ||
      import.meta.env.VITE_OVERSHOOT_API_KEY ||
      "",
  );
  const [openaiKey, setOpenaiKey] = useState(
    localStorage.getItem("openai_key") ||
      import.meta.env.VITE_OPENAI_API_KEY ||
      "",
  );

  const visionRef = useRef<RealtimeVision | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const narratorRef = useRef<any>(null);

  const hasAllKeys = overshootKey && openaiKey;

  const classifyPriority = (content: string): "high" | "medium" | "low" => {
    const lowerContent = content.toLowerCase();

    // High priority: people, animals, movement, danger
    if (
      lowerContent.includes("person") ||
      lowerContent.includes("people") ||
      lowerContent.includes("man") ||
      lowerContent.includes("woman") ||
      lowerContent.includes("child") ||
      lowerContent.includes("dog") ||
      lowerContent.includes("cat") ||
      lowerContent.includes("animal") ||
      lowerContent.includes("moving") ||
      lowerContent.includes("walking") ||
      lowerContent.includes("running") ||
      lowerContent.includes("danger") ||
      lowerContent.includes("warning")
    ) {
      return "high";
    }

    // Medium priority: objects of interest, actions
    if (
      lowerContent.includes("vehicle") ||
      lowerContent.includes("car") ||
      lowerContent.includes("bike") ||
      lowerContent.includes("door") ||
      lowerContent.includes("window") ||
      lowerContent.includes("sign") ||
      lowerContent.includes("text")
    ) {
      return "medium";
    }

    return "low";
  };

  const handleVisionResult = (result: StreamInferenceResult) => {
    if (!result.ok || !result.result) return;

    const report: VisionReport = {
      id: result.id,
      content: result.result,
      timestamp: Date.now(),
      priority: classifyPriority(result.result),
      latency: result.total_latency_ms,
    };

    setReports((prev) => {
      const updated = [report, ...prev].slice(0, 20);

      if (narratorRef.current) {
        narratorRef.current.addReport(report);
      }

      return updated;
    });
  };

  const startVision = async () => {
    if (!hasAllKeys) {
      setShowSettings(true);
      return;
    }

    try {
      setConnectionStatus("connecting");
      setError(null);

      const vision = new RealtimeVision({
        apiUrl: "https://cluster1.overshoot.ai/api/v0.2",
        apiKey: overshootKey,
        prompt:
          "Describe what you see in 5 words or less. Be very brief and focus on the most notable thing visible.",
        source: {
          type: "camera",
          cameraFacing: "environment",
        },
        backend: "overshoot",
        processing: {
          sampling_ratio: 0.3,
          clip_length_seconds: 1.0,
          delay_seconds: 2,
        },
        onResult: handleVisionResult,
        onError: (err) => {
          console.error("Vision error:", err);
          setError(err.message);
          setConnectionStatus("disconnected");
        },
        debug: false,
      });

      await vision.start();
      visionRef.current = vision;

      const stream = vision.getMediaStream();
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      setConnectionStatus("connected");
      setIsActive(true);

      if (narratorRef.current) {
        narratorRef.current.start();
      }
    } catch (err) {
      console.error("Failed to start:", err);
      setError(err instanceof Error ? err.message : "Failed to start vision");
      setConnectionStatus("disconnected");
    }
  };

  const stopVision = async () => {
    if (visionRef.current) {
      await visionRef.current.stop();
      visionRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (narratorRef.current) {
      narratorRef.current.stop();
    }

    setIsActive(false);
    setConnectionStatus("disconnected");
    setReports([]);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
    if (narratorRef.current) {
      narratorRef.current.setMuted(!isMuted);
    }
  };

  const saveSettings = (keys: { overshoot: string; openai: string }) => {
    setOvershootKey(keys.overshoot);
    setOpenaiKey(keys.openai);

    localStorage.setItem("overshoot_key", keys.overshoot);
    localStorage.setItem("openai_key", keys.openai);

    setShowSettings(false);
  };

  return (
    <div className="relative h-screen w-screen bg-black overflow-hidden">
      {/* Video Preview */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70 pointer-events-none" />

      {/* Top Bar */}
      <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-2">
          <Camera className="w-5 h-5 text-white" />
          <span className="text-white font-medium text-sm">
            Real-time Narrator
          </span>
        </div>

        <button
          onClick={() => setShowSettings(true)}
          className="p-2 bg-white/10 backdrop-blur-sm rounded-lg text-white hover:bg-white/20 transition-colors"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Connection Status */}
      {connectionStatus === "connecting" && (
        <div className="absolute top-16 left-1/2 transform -translate-x-1/2 bg-yellow-500/90 backdrop-blur-sm text-white px-4 py-2 rounded-full text-sm z-10">
          Connecting...
        </div>
      )}

      {connectionStatus === "connected" && (
        <div className="absolute top-16 left-1/2 transform -translate-x-1/2 bg-green-500/90 backdrop-blur-sm text-white px-4 py-2 rounded-full text-sm z-10 flex items-center gap-2">
          <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
          Live
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="absolute top-16 left-4 right-4 bg-red-500/90 backdrop-blur-sm text-white p-3 rounded-lg text-sm z-10">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <button onClick={() => setError(null)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Reports List */}
      {isActive && <ReportsList reports={reports} />}

      {/* Narrator Engine */}
      <NarratorEngine
        ref={narratorRef}
        openaiKey={openaiKey}
        isMuted={isMuted}
        isActive={isActive}
      />

      {/* Bottom Controls */}
      <div className="absolute bottom-0 left-0 right-0 p-6 z-10">
        <div className="flex items-center justify-center gap-4">
          {/* Mute Button */}
          {isActive && (
            <button
              onClick={toggleMute}
              className={`p-4 rounded-full backdrop-blur-sm transition-all ${
                isMuted
                  ? "bg-red-500/90 text-white"
                  : "bg-white/20 text-white hover:bg-white/30"
              }`}
            >
              {isMuted ? (
                <MicOff className="w-6 h-6" />
              ) : (
                <Mic className="w-6 h-6" />
              )}
            </button>
          )}

          {/* Start/Stop Button */}
          <button
            onClick={isActive ? stopVision : startVision}
            disabled={!hasAllKeys && !isActive}
            className={`px-8 py-4 rounded-full font-semibold text-lg transition-all transform active:scale-95 ${
              isActive
                ? "bg-red-500 text-white hover:bg-red-600"
                : hasAllKeys
                  ? "bg-white text-black hover:bg-gray-100"
                  : "bg-gray-500 text-gray-300 cursor-not-allowed"
            }`}
          >
            {isActive ? "Stop" : "Start Narrating"}
          </button>
        </div>

        {!hasAllKeys && !isActive && (
          <p className="text-center text-white/70 text-sm mt-3">
            Configure API keys to get started
          </p>
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          initialKeys={{
            overshoot: overshootKey,
            openai: openaiKey,
          }}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;

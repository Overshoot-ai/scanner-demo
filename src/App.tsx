import React, { useState, useEffect, useRef } from "react";
import { RealtimeVision } from "@overshoot/sdk";

interface ScanResult {
  visible: boolean;
  confidence: number;
  distance?: "very close" | "close" | "medium" | "far";
  description?: string;
}

export default function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string>("");
  const [hasPermission, setHasPermission] = useState(false);

  const visionRef = useRef<RealtimeVision | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Deduplication refs for voice announcements
  const lastAnnouncementRef = useRef<{
    wasVisible: boolean;
    distance: string | null;
    timestamp: number;
  }>({ wasVisible: false, distance: null, timestamp: 0 });
  const ANNOUNCEMENT_COOLDOWN_MS = 5000; // Only announce every 5 seconds max
  const DISTANCE_CHANGE_THRESHOLD = true; // Announce when distance category changes

  // Initialize audio context
  useEffect(() => {
    audioContextRef.current = new (
      window.AudioContext || (window as any).webkitAudioContext
    )();
    return () => {
      if (audioContextRef.current?.state !== "closed") {
        audioContextRef.current?.close();
      }
    };
  }, []);

  // Update beeper based on result
  useEffect(() => {
    if (!isScanning || !result || !audioContextRef.current) return;

    const audioContext = audioContextRef.current;

    // Stop previous oscillator
    if (oscillatorRef.current) {
      oscillatorRef.current.stop();
      oscillatorRef.current = null;
    }

    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect();
      gainNodeRef.current = null;
    }

    if (!result.visible || result.confidence < 0.3) {
      // Silent or very slow beep for not visible
      return;
    }

    // Create audio nodes
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillatorRef.current = oscillator;
    gainNodeRef.current = gainNode;

    // Map confidence to frequency and beep rate
    // Higher confidence = higher frequency and faster beeps
    const baseFrequency = 200 + result.confidence * 800; // 200Hz to 1000Hz
    const beepRate = 0.2 + result.confidence * 1.8; // 0.2s to 2s (faster = closer)

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      baseFrequency,
      audioContext.currentTime,
    );

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Create beeping pattern
    const beep = () => {
      if (!gainNodeRef.current || !isScanning) return;

      const now = audioContext.currentTime;
      const beepDuration = 0.1;

      // Fade in
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.3, now + 0.02);

      // Hold
      gainNode.gain.setValueAtTime(0.3, now + beepDuration - 0.02);

      // Fade out
      gainNode.gain.linearRampToValueAtTime(0, now + beepDuration);
    };

    oscillator.start();

    // Initial beep
    beep();

    // Set up interval for continuous beeping
    const interval = setInterval(beep, beepRate * 1000);

    return () => {
      clearInterval(interval);
      if (oscillatorRef.current) {
        oscillatorRef.current.stop();
        oscillatorRef.current = null;
      }
      if (gainNodeRef.current) {
        gainNodeRef.current.disconnect();
        gainNodeRef.current = null;
      }
    };
  }, [result, isScanning]);

  const startScanning = async () => {
    if (!searchQuery.trim()) {
      setError("Please describe what you're looking for");
      return;
    }

    setError("");
    setIsScanning(true);
    setResult(null);

    try {
      // Resume audio context (required for user interaction)
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume();
      }

      const apiUrl = "https://cluster1.overshoot.ai/api/v0.2";
      const apiKey = import.meta.env.VITE_API_KEY || "";

      console.log("Initializing with API URL:", apiUrl);
      console.log("API Key present:", !!apiKey);

      const vision = new RealtimeVision({
        apiUrl,
        apiKey,
        prompt: `You are helping a visually impaired person find: "${searchQuery}". 
Analyze the video and determine if the object is visible. Return JSON with:
- visible (boolean): is the object visible in frame?
- confidence (number 0-1): how confident are you it's visible?
- distance (string): if visible, estimate "very close", "close", "medium", or "far"
- description (string): brief description of what you see and where the object is located

Be very accurate and helpful. If you see something similar but not exactly matching, set visible to false but describe what you see.`,
        source: {
          type: "camera",
          cameraFacing: "environment",
        },
        backend: "overshoot",
        processing: {
          fps: 30,
          sampling_ratio: 0.3,
          clip_length_seconds: 1,
          delay_seconds: 0.5,
        },
        outputSchema: {
          type: "object",
          properties: {
            visible: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            distance: {
              type: "string",
              enum: ["very close", "close", "medium", "far"],
            },
            description: { type: "string" },
          },
          required: ["visible", "confidence"],
        },
        onResult: (inferenceResult) => {
          if (inferenceResult.ok) {
            try {
              const parsed = JSON.parse(inferenceResult.result) as ScanResult;
              setResult(parsed);

              // Smart deduplication for voice announcements
              if ("speechSynthesis" in window) {
                const now = Date.now();
                const lastAnnouncement = lastAnnouncementRef.current;
                const timeSinceLastAnnouncement =
                  now - lastAnnouncement.timestamp;

                let shouldAnnounce = false;
                let announcementText = "";

                // Case 1: Object just became visible (transition from not found to found)
                if (parsed.visible && !lastAnnouncement.wasVisible) {
                  shouldAnnounce = true;
                  announcementText = `Found ${searchQuery}! ${
                    parsed.distance ? `Distance: ${parsed.distance}.` : ""
                  } ${parsed.description || ""}`;
                }
                // Case 2: Object was visible and distance changed significantly
                else if (
                  parsed.visible &&
                  lastAnnouncement.wasVisible &&
                  parsed.distance &&
                  parsed.distance !== lastAnnouncement.distance &&
                  timeSinceLastAnnouncement > ANNOUNCEMENT_COOLDOWN_MS
                ) {
                  shouldAnnounce = true;
                  announcementText = `Distance changed to ${parsed.distance}`;
                }
                // Case 3: Object disappeared (was visible, now not visible)
                else if (!parsed.visible && lastAnnouncement.wasVisible) {
                  shouldAnnounce = true;
                  announcementText = "Object lost. Keep searching.";
                }

                if (shouldAnnounce) {
                  // Cancel any ongoing speech
                  window.speechSynthesis.cancel();

                  const utterance = new SpeechSynthesisUtterance(
                    announcementText,
                  );
                  utterance.rate = 1.2;
                  window.speechSynthesis.speak(utterance);

                  // Update last announcement tracking
                  lastAnnouncementRef.current = {
                    wasVisible: parsed.visible,
                    distance: parsed.distance || null,
                    timestamp: now,
                  };
                }
              }
            } catch (e) {
              console.error("Failed to parse result:", e);
            }
          }
        },
        onError: (err) => {
          console.error("Vision error:", err);
          console.error("Error details:", {
            name: err.name,
            message: err.message,
            stack: err.stack,
          });
          setError(err.message);
        },
        debug: true,
      });

      await vision.start();
      visionRef.current = vision;
      setHasPermission(true);

      // Attach video stream to video element
      const stream = vision.getMediaStream();
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Announce start
      if ("speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(
          `Scanning for ${searchQuery}. Point your camera around to search.`,
        );
        utterance.rate = 1.2;
        window.speechSynthesis.speak(utterance);
      }
    } catch (err) {
      console.error("Failed to start scanning:", err);
      setError(err instanceof Error ? err.message : "Failed to start camera");
      setIsScanning(false);
    }
  };

  const stopScanning = async () => {
    if (visionRef.current) {
      await visionRef.current.stop();
      visionRef.current = null;
    }

    // Stop audio
    if (oscillatorRef.current) {
      oscillatorRef.current.stop();
      oscillatorRef.current = null;
    }

    // Reset announcement tracking
    lastAnnouncementRef.current = {
      wasVisible: false,
      distance: null,
      timestamp: 0,
    };

    setIsScanning(false);
    setResult(null);

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance("Scanning stopped");
      window.speechSynthesis.speak(utterance);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* Accessibility announcements */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {result?.visible &&
          `Object found with ${Math.round(result.confidence * 100)}% confidence`}
        {error && `Error: ${error}`}
      </div>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <header className="text-center mb-12">
          <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 bg-clip-text text-transparent">
            Vision Scanner
          </h1>
          <p className="text-xl text-slate-400 font-light">
            Audio-guided object detection for visually impaired users
          </p>
        </header>

        {/* Main content */}
        <div className="space-y-8">
          {/* Search input */}
          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-8 border border-slate-700/50 shadow-2xl">
            <label
              htmlFor="search-input"
              className="block text-lg font-medium mb-3 text-slate-200"
            >
              What are you looking for?
            </label>
            <p className="text-sm text-slate-400 mb-4">
              Describe the object you want to find (e.g., "door", "my keys",
              "water bottle")
            </p>
            <input
              id="search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && !isScanning && startScanning()
              }
              disabled={isScanning}
              placeholder="e.g., door, keys, phone..."
              className="w-full px-6 py-4 bg-slate-900/70 border-2 border-slate-600 rounded-xl text-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              aria-describedby="search-help"
            />
            <p id="search-help" className="text-xs text-slate-500 mt-2">
              Press Enter to start scanning
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div
              className="bg-red-900/30 border-2 border-red-600 rounded-xl p-4 text-red-200"
              role="alert"
            >
              <strong className="font-semibold">Error:</strong> {error}
            </div>
          )}

          {/* Control buttons */}
          <div className="flex gap-4">
            {!isScanning ? (
              <button
                onClick={startScanning}
                disabled={!searchQuery.trim()}
                className="flex-1 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-slate-700 disabled:to-slate-700 text-white font-semibold py-4 px-8 rounded-xl shadow-lg hover:shadow-cyan-500/25 transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 text-lg"
                aria-label="Start scanning for object"
              >
                🔍 Start Scanning
              </button>
            ) : (
              <button
                onClick={stopScanning}
                className="flex-1 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-500 hover:to-pink-500 text-white font-semibold py-4 px-8 rounded-xl shadow-lg hover:shadow-red-500/25 transition-all duration-200 text-lg"
                aria-label="Stop scanning"
              >
                ⏹️ Stop Scanning
              </button>
            )}
          </div>

          {/* Camera preview */}
          {isScanning && (
            <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-slate-700/50 shadow-2xl">
              <h2 className="text-xl font-semibold mb-4 text-slate-200">
                Camera View
              </h2>
              <div className="relative aspect-video bg-slate-900 rounded-xl overflow-hidden">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                  aria-label="Live camera feed"
                />
                {result?.visible && (
                  <div className="absolute inset-0 border-4 border-green-500 animate-pulse pointer-events-none" />
                )}
              </div>
            </div>
          )}

          {/* Results display */}
          {isScanning && result && (
            <div
              className={`rounded-2xl p-8 border-2 shadow-2xl transition-all duration-500 ${
                result.visible
                  ? "bg-green-900/30 border-green-500"
                  : "bg-slate-800/50 border-slate-700/50"
              }`}
              role="status"
              aria-live="polite"
            >
              <div className="space-y-4">
                {/* Status */}
                <div className="flex items-center gap-3">
                  <div
                    className={`w-4 h-4 rounded-full ${
                      result.visible
                        ? "bg-green-500 animate-pulse"
                        : "bg-slate-600"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="text-2xl font-bold">
                    {result.visible ? "✓ Found!" : "⏳ Searching..."}
                  </span>
                </div>

                {/* Confidence meter */}
                <div>
                  <div className="flex justify-between text-sm text-slate-400 mb-2">
                    <span>Confidence</span>
                    <span
                      aria-label={`Confidence level: ${Math.round(result.confidence * 100)} percent`}
                    >
                      {Math.round(result.confidence * 100)}%
                    </span>
                  </div>
                  <div className="w-full h-3 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        result.confidence > 0.7
                          ? "bg-green-500"
                          : result.confidence > 0.4
                            ? "bg-yellow-500"
                            : "bg-red-500"
                      }`}
                      style={{ width: `${result.confidence * 100}%` }}
                      role="progressbar"
                      aria-valuenow={result.confidence * 100}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    />
                  </div>
                </div>

                {/* Distance */}
                {result.distance && (
                  <div className="flex items-center gap-2 text-slate-300">
                    <span className="text-2xl" aria-hidden="true">
                      📏
                    </span>
                    <span>
                      <strong>Distance:</strong> {result.distance}
                    </span>
                  </div>
                )}

                {/* Description */}
                {result.description && (
                  <div className="bg-slate-900/50 rounded-xl p-4 text-slate-200">
                    <p className="text-sm font-semibold text-slate-400 mb-1">
                      Description:
                    </p>
                    <p>{result.description}</p>
                  </div>
                )}

                {/* Audio indicator */}
                <div className="text-sm text-slate-400 italic flex items-center gap-2">
                  <span className="text-xl" aria-hidden="true">
                    🔊
                  </span>
                  <span>
                    {result.visible
                      ? "Listen to the beeping frequency - faster beeps mean you're getting closer!"
                      : "Move your camera around to search for the object"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Instructions */}
          {!isScanning && (
            <div className="bg-slate-800/30 backdrop-blur-sm rounded-2xl p-8 border border-slate-700/30">
              <h2 className="text-2xl font-semibold mb-4 text-slate-200">
                How it works
              </h2>
              <ol className="space-y-3 text-slate-300 list-decimal list-inside">
                <li className="pl-2">
                  <strong className="text-slate-100">Describe</strong> what
                  you're looking for in the search box
                </li>
                <li className="pl-2">
                  <strong className="text-slate-100">Start scanning</strong> to
                  activate the camera
                </li>
                <li className="pl-2">
                  <strong className="text-slate-100">Point</strong> your camera
                  around the area
                </li>
                <li className="pl-2">
                  <strong className="text-slate-100">Listen</strong> to the
                  beeping:
                  <ul className="ml-8 mt-2 space-y-1 text-sm text-slate-400 list-disc">
                    <li>Faster beeps = object is closer or more visible</li>
                    <li>Higher pitch = higher confidence in detection</li>
                    <li>No beeps = object not found yet</li>
                  </ul>
                </li>
                <li className="pl-2">
                  <strong className="text-slate-100">Voice feedback</strong>{" "}
                  will announce when object is found
                </li>
              </ol>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="mt-12 text-center text-slate-500 text-sm">
          <p>Powered by Overshoot Vision AI</p>
          <p className="mt-2">
            This tool uses your device camera and audio. All processing is
            secure.
          </p>
        </footer>
      </div>
    </div>
  );
}

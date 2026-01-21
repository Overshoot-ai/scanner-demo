import { useState, useEffect, useRef } from "react";
import { RealtimeVision } from "@overshoot/sdk";

interface ScanResult {
  visible: boolean;
  confidence: number;
  distance?: "very close" | "close" | "medium" | "far";
  description?: string;
}

interface ItemLocation {
  heading: number; // alpha value when item was detected
  beta: number; // x-axis tilt
  gamma: number; // y-axis tilt
  timestamp: number;
  searchQuery: string;
}

export default function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string>("");
  const [hasPermission, setHasPermission] = useState(false);
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  // Device orientation states
  const [currentHeading, setCurrentHeading] = useState<number | null>(null);
  const [currentBeta, setCurrentBeta] = useState<number | null>(null);
  const [currentGamma, setCurrentGamma] = useState<number | null>(null);
  const [itemLocation, setItemLocation] = useState<ItemLocation | null>(null);
  const [guidance, setGuidance] = useState<string>("");
  const [needsOrientationPermission, setNeedsOrientationPermission] =
    useState(false);

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
  const ANNOUNCEMENT_COOLDOWN_MS = 5000;

  // Track consecutive negatives to avoid false "object lost" announcements
  const consecutiveNegativesRef = useRef<number>(0);
  const REQUIRED_NEGATIVES_FOR_LOST = 3;

  // Track if speech is currently playing to avoid interruptions
  const isSpeakingRef = useRef<boolean>(false);

  // Track last guidance announcement to avoid spam
  const lastGuidanceAnnouncementRef = useRef<string>("");
  const lastGuidanceTimeRef = useRef<number>(0);
  const GUIDANCE_ANNOUNCEMENT_COOLDOWN = 3000; // 3 seconds between guidance announcements

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

  // Request device orientation permission (iOS 13+)
  const requestOrientationPermission = async () => {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as any).requestPermission === "function"
    ) {
      try {
        const permission = await (
          DeviceOrientationEvent as any
        ).requestPermission();
        if (permission === "granted") {
          setNeedsOrientationPermission(false);
          return true;
        } else {
          setError(
            "Device orientation permission denied. Find again feature won't work.",
          );
          return false;
        }
      } catch (err) {
        console.error("Error requesting orientation permission:", err);
        setError("Failed to request orientation permission");
        return false;
      }
    }
    // Android and other platforms don't need permission
    return true;
  };

  // Device orientation listener
  useEffect(() => {
    // Check if permission is needed (iOS 13+)
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as any).requestPermission === "function"
    ) {
      setNeedsOrientationPermission(true);
    }

    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha !== null) {
        setCurrentHeading(event.alpha);
      }
      if (event.beta !== null) {
        setCurrentBeta(event.beta);
      }
      if (event.gamma !== null) {
        setCurrentGamma(event.gamma);
      }
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () =>
      window.removeEventListener("deviceorientation", handleOrientation);
  }, []);

  // Calculate guidance when orientation changes
  useEffect(() => {
    if (currentHeading === null || !itemLocation || !isScanning) {
      setGuidance("");
      return;
    }

    const targetHeading = itemLocation.heading;
    let diff = targetHeading - currentHeading;

    // Normalize to -180 to 180
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;

    const threshold = 15; // degrees tolerance

    let newGuidance = "";

    if (Math.abs(diff) < threshold) {
      // Check if vertical angle is also close
      const betaDiff =
        currentBeta !== null && itemLocation.beta !== null
          ? Math.abs(currentBeta - itemLocation.beta)
          : 0;

      if (betaDiff < 20) {
        newGuidance = "🎯 You're pointing at the right spot!";
      } else {
        newGuidance = `🎯 Right direction! ${betaDiff > 0 ? (currentBeta! > itemLocation.beta! ? "Tilt down" : "Tilt up") : ""}`;
      }
    } else {
      const degrees = Math.round(Math.abs(diff));
      if (diff > 0) {
        newGuidance = `↻ Turn right ${degrees}°`;
      } else {
        newGuidance = `↺ Turn left ${degrees}°`;
      }
    }

    setGuidance(newGuidance);

    // Voice announcement for guidance (with cooldown and deduplication)
    if ("speechSynthesis" in window && !isSpeakingRef.current) {
      const now = Date.now();
      const timeSinceLastGuidance = now - lastGuidanceTimeRef.current;

      // Only announce if guidance changed significantly and cooldown passed
      if (
        newGuidance !== lastGuidanceAnnouncementRef.current &&
        timeSinceLastGuidance > GUIDANCE_ANNOUNCEMENT_COOLDOWN
      ) {
        // Only announce important guidance changes
        if (
          newGuidance.includes("right spot") ||
          (timeSinceLastGuidance > GUIDANCE_ANNOUNCEMENT_COOLDOWN * 2 &&
            Math.abs(diff) > 30)
        ) {
          isSpeakingRef.current = true;
          lastGuidanceAnnouncementRef.current = newGuidance;
          lastGuidanceTimeRef.current = now;

          const utterance = new SpeechSynthesisUtterance(
            newGuidance.replace(/[↻↺🎯]/g, ""),
          );
          utterance.rate = 1.3;

          utterance.onend = () => {
            isSpeakingRef.current = false;
          };

          utterance.onerror = () => {
            isSpeakingRef.current = false;
          };

          window.speechSynthesis.speak(utterance);
        }
      }
    }
  }, [currentHeading, currentBeta, itemLocation, isScanning]);

  // Mark item location when detected
  useEffect(() => {
    if (
      result?.visible &&
      result.confidence > 0.6 &&
      currentHeading !== null &&
      currentBeta !== null &&
      currentGamma !== null &&
      !itemLocation
    ) {
      const newLocation: ItemLocation = {
        heading: currentHeading,
        beta: currentBeta,
        gamma: currentGamma,
        timestamp: Date.now(),
        searchQuery: searchQuery,
      };

      setItemLocation(newLocation);

      // Announce that location has been marked
      if ("speechSynthesis" in window && !isSpeakingRef.current) {
        isSpeakingRef.current = true;
        const utterance = new SpeechSynthesisUtterance(
          "Location saved. I can guide you back if you lose it.",
        );
        utterance.rate = 1.3;
        utterance.onend = () => {
          isSpeakingRef.current = false;
        };
        utterance.onerror = () => {
          isSpeakingRef.current = false;
        };
        window.speechSynthesis.speak(utterance);
      }
    }
  }, [
    result,
    currentHeading,
    currentBeta,
    currentGamma,
    searchQuery,
    itemLocation,
  ]);

  // Enumerate available video devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput",
        );
        setAvailableDevices(videoDevices);

        const metaDevice = videoDevices.find(
          (d) =>
            d.label.toLowerCase().includes("meta") ||
            d.label.toLowerCase().includes("ray-ban"),
        );
        if (metaDevice) {
          setSelectedDeviceId(metaDevice.deviceId);
        } else if (videoDevices.length > 0) {
          setSelectedDeviceId(videoDevices[0].deviceId);
        }
      } catch (err) {
        console.error("Failed to enumerate devices:", err);
      }
    };
    getDevices();
  }, []);

  // Update beeper based on result
  useEffect(() => {
    if (!isScanning || !result || !audioContextRef.current) return;

    const audioContext = audioContextRef.current;

    if (oscillatorRef.current) {
      oscillatorRef.current.stop();
      oscillatorRef.current = null;
    }

    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect();
      gainNodeRef.current = null;
    }

    if (!result.visible || result.confidence < 0.3) {
      return;
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillatorRef.current = oscillator;
    gainNodeRef.current = gainNode;

    const baseFrequency = 200 + result.confidence * 800;
    const beepRate = 0.2 + result.confidence * 1.8;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      baseFrequency,
      audioContext.currentTime,
    );

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    const beep = () => {
      if (!gainNodeRef.current || !isScanning) return;

      const now = audioContext.currentTime;
      const beepDuration = 0.1;

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.3, now + 0.02);
      gainNode.gain.setValueAtTime(0.3, now + beepDuration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, now + beepDuration);
    };

    oscillator.start();
    beep();

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

    // Request orientation permission if needed
    if (needsOrientationPermission) {
      const granted = await requestOrientationPermission();
      if (!granted) {
        // Continue anyway, but find again won't work
        console.warn(
          "Orientation permission not granted, find again feature disabled",
        );
      }
    }

    setError("");
    setIsScanning(true);
    setResult(null);

    try {
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume();
      }

      const apiUrl = "https://cluster1.overshoot.ai/api/v0.2";
      const apiKey = import.meta.env.VITE_API_KEY || "";

      const vision = new RealtimeVision({
        apiUrl,
        apiKey,
        prompt: `You are helping a visually impaired person find: "${searchQuery}". 
Analyze the video and determine if the object is visible. Return ONLY JSON with these fields:
- visible (boolean): is the object clearly visible in frame?
- confidence (number 0-1): how confident are you it's the correct object?
- distance (string): ONLY if visible=true, estimate distance. For household items: "very close" = within arm's reach (< 1 meter), "close" = 1-2 meters, "medium" = 2-4 meters, "far" = > 4 meters. For large objects like doors/cars, scale proportionally.
- description (string): ONLY if visible=true, give location in 5 words max using spatial references the user can feel or know (e.g., "on the table", "by the wall", "near the window", "on the floor"). NEVER use "left/right side" or camera-relative directions - the user is moving the camera and these are confusing.

CRITICAL: If visible=false, do NOT include distance or description fields at all. Return only {"visible": false, "confidence": 0}.

Be precise - only set visible=true if you're confident it's the correct object.`,
        source: {
          type: "camera",
          cameraFacing: "environment",
        },
        backend: "overshoot",
        model: "Qwen/Qwen3-VL-8B-Instruct",
        processing: {
          fps: 30,
          sampling_ratio: 0.6,
          clip_length_seconds: 0.3,
          delay_seconds: 0.2,
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

              if (!parsed.visible) {
                consecutiveNegativesRef.current++;
              } else {
                consecutiveNegativesRef.current = 0;
              }

              if ("speechSynthesis" in window) {
                const now = Date.now();
                const lastAnnouncement = lastAnnouncementRef.current;
                const timeSinceLastAnnouncement =
                  now - lastAnnouncement.timestamp;

                let shouldAnnounce = false;
                let announcementText = "";

                if (parsed.visible && !lastAnnouncement.wasVisible) {
                  shouldAnnounce = true;
                  announcementText = `Found! ${parsed.distance || ""}.${parsed.description ? " " + parsed.description : ""}`;
                } else if (
                  parsed.visible &&
                  lastAnnouncement.wasVisible &&
                  parsed.distance &&
                  parsed.distance !== lastAnnouncement.distance &&
                  timeSinceLastAnnouncement > ANNOUNCEMENT_COOLDOWN_MS &&
                  !isSpeakingRef.current
                ) {
                  shouldAnnounce = true;
                  announcementText = `${parsed.distance}`;
                } else if (
                  !parsed.visible &&
                  lastAnnouncement.wasVisible &&
                  consecutiveNegativesRef.current >=
                    REQUIRED_NEGATIVES_FOR_LOST &&
                  !isSpeakingRef.current
                ) {
                  shouldAnnounce = true;
                  announcementText = "Lost. Keep searching.";
                }

                if (shouldAnnounce) {
                  if (!isSpeakingRef.current) {
                    isSpeakingRef.current = true;

                    const utterance = new SpeechSynthesisUtterance(
                      announcementText,
                    );
                    utterance.rate = 1.4;

                    utterance.onend = () => {
                      isSpeakingRef.current = false;
                    };

                    utterance.onerror = () => {
                      isSpeakingRef.current = false;
                    };

                    window.speechSynthesis.speak(utterance);

                    lastAnnouncementRef.current = {
                      wasVisible: parsed.visible,
                      distance: parsed.distance || null,
                      timestamp: now,
                    };
                  }
                }
              }
            } catch (e) {
              console.error("Failed to parse result:", e);
            }
          }
        },
        onError: (err) => {
          console.error("Vision error:", err);
          setError(err.message);
        },
        debug: true,
      });

      await vision.start();
      visionRef.current = vision;
      setHasPermission(true);

      const stream = vision.getMediaStream();
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
      }

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

    if (oscillatorRef.current) {
      oscillatorRef.current.stop();
      oscillatorRef.current = null;
    }

    lastAnnouncementRef.current = {
      wasVisible: false,
      distance: null,
      timestamp: 0,
    };
    consecutiveNegativesRef.current = 0;
    isSpeakingRef.current = false;

    setIsScanning(false);
    setResult(null);

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance("Scanning stopped");
      window.speechSynthesis.speak(utterance);
    }
  };

  const clearItemLocation = () => {
    setItemLocation(null);
    setGuidance("");
    lastGuidanceAnnouncementRef.current = "";
    lastGuidanceTimeRef.current = 0;

    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance("Location marker cleared");
      utterance.rate = 1.3;
      window.speechSynthesis.speak(utterance);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {result?.visible &&
          `Object found with ${Math.round(result.confidence * 100)}% confidence`}
        {error && `Error: ${error}`}
        {guidance && guidance}
      </div>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <header className="text-center mb-12">
          <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 bg-clip-text text-transparent">
            Vision Scanner
          </h1>
          <p className="text-xl text-slate-400 font-light">
            Audio-guided object detection with navigation
          </p>
        </header>

        <div className="space-y-8">
          {/* Orientation Permission Notice */}
          {needsOrientationPermission && !isScanning && (
            <div className="bg-blue-900/30 border-2 border-blue-600 rounded-xl p-4 text-blue-200">
              <p className="text-sm">
                📱 <strong>iOS Device Detected:</strong> The "Find Again"
                feature requires device orientation permission. You'll be asked
                when you start scanning.
              </p>
            </div>
          )}

          {/* Find Again Guidance Display */}
          {isScanning && itemLocation && guidance && !result?.visible && (
            <div className="bg-gradient-to-r from-purple-900/50 to-blue-900/50 border-2 border-purple-500 rounded-2xl p-6 shadow-2xl animate-pulse">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-4xl">🧭</span>
                  <div>
                    <h3 className="text-xl font-bold text-purple-200">
                      Navigate Back
                    </h3>
                    <p className="text-sm text-purple-300">
                      Guiding you to: {itemLocation.searchQuery}
                    </p>
                  </div>
                </div>
                <button
                  onClick={clearItemLocation}
                  className="px-4 py-2 bg-red-600/80 hover:bg-red-600 rounded-lg text-sm font-semibold transition-all"
                  aria-label="Clear saved location"
                >
                  Clear
                </button>
              </div>
              <div className="text-center py-8">
                <p className="text-4xl font-bold text-white mb-2">{guidance}</p>
                <p className="text-sm text-purple-200">
                  Follow the voice guidance
                </p>
              </div>
            </div>
          )}

          {/* Camera selector */}
          {availableDevices.length > 1 && (
            <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-slate-700/50 shadow-2xl">
              <label
                htmlFor="camera-select"
                className="block text-lg font-medium mb-3 text-slate-200"
              >
                Camera Source
              </label>
              <select
                id="camera-select"
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                disabled={isScanning}
                className="w-full px-4 py-3 bg-slate-900/70 border-2 border-slate-600 rounded-xl text-slate-100 focus:outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Select camera device"
              >
                {availableDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label ||
                      `Camera ${availableDevices.indexOf(device) + 1}`}
                    {(device.label.toLowerCase().includes("meta") ||
                      device.label.toLowerCase().includes("ray-ban")) &&
                      " 🥽"}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-2">
                {selectedDeviceId &&
                availableDevices
                  .find((d) => d.deviceId === selectedDeviceId)
                  ?.label.toLowerCase()
                  .includes("meta")
                  ? "🥽 Meta AI glasses detected!"
                  : "Select your camera or Meta AI glasses"}
              </p>
            </div>
          )}

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
              <>
                <button
                  onClick={stopScanning}
                  className="flex-1 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-500 hover:to-pink-500 text-white font-semibold py-4 px-8 rounded-xl shadow-lg hover:shadow-red-500/25 transition-all duration-200 text-lg"
                  aria-label="Stop scanning"
                >
                  ⏹️ Stop Scanning
                </button>
                {itemLocation && (
                  <button
                    onClick={clearItemLocation}
                    className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold py-4 px-6 rounded-xl shadow-lg hover:shadow-purple-500/25 transition-all duration-200"
                    aria-label="Clear saved location"
                    title="Clear saved item location"
                  >
                    🧭 Clear Marker
                  </button>
                )}
              </>
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
                {/* Compass indicator */}
                {currentHeading !== null && (
                  <div className="absolute top-4 left-4 bg-black/70 backdrop-blur-sm rounded-lg px-3 py-2 text-sm font-mono">
                    <span className="text-cyan-400">🧭</span>{" "}
                    {Math.round(currentHeading)}°
                  </div>
                )}
                {/* Location saved indicator */}
                {itemLocation && (
                  <div className="absolute top-4 right-4 bg-purple-900/80 backdrop-blur-sm rounded-lg px-3 py-2 text-xs font-semibold text-purple-200 flex items-center gap-2">
                    <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse"></span>
                    Location Saved
                  </div>
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

                {result.description && (
                  <div className="bg-slate-900/50 rounded-xl p-4 text-slate-200">
                    <p className="text-sm font-semibold text-slate-400 mb-1">
                      Description:
                    </p>
                    <p>{result.description}</p>
                  </div>
                )}

                <div className="text-sm text-slate-400 italic flex items-center gap-2">
                  <span className="text-xl" aria-hidden="true">
                    🔊
                  </span>
                  <span>
                    {result.visible
                      ? "Listen to the beeping frequency - faster beeps mean you're getting closer!"
                      : itemLocation
                        ? "Follow the navigation guidance to find the item again"
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
                <li className="pl-2">
                  <strong className="text-slate-100 text-purple-300">
                    🆕 Find Again:
                  </strong>{" "}
                  When an item is detected, its location is automatically saved.
                  If you look away, follow the directional guidance to find it
                  again!
                </li>
              </ol>
            </div>
          )}
        </div>

        <footer className="mt-12 text-center text-slate-500 text-sm">
          <p>Powered by Overshoot Vision AI</p>
          <p className="mt-2">
            This tool uses your device camera, audio, and orientation sensors.
            All processing is secure.
          </p>
        </footer>
      </div>
    </div>
  );
}

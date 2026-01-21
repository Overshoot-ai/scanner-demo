import { useState, useEffect, useRef } from "react";
import { RealtimeVision } from "@overshoot/sdk";

interface ScanResult {
  visible: boolean;
  confidence: number;
  distance?: "very close" | "close" | "medium" | "far";
  description?: string;
}

interface ItemLocation {
  heading: number;
  beta: number;
  gamma: number;
  timestamp: number;
  searchQuery: string;
}

export default function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string>("");
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
  const [glowDirection, setGlowDirection] = useState<
    "left" | "right" | "center" | null
  >(null);
  const [needsOrientationPermission, setNeedsOrientationPermission] =
    useState(false);

  const visionRef = useRef<RealtimeVision | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const lastAnnouncementRef = useRef<{
    wasVisible: boolean;
    distance: string | null;
    timestamp: number;
  }>({ wasVisible: false, distance: null, timestamp: 0 });
  const ANNOUNCEMENT_COOLDOWN_MS = 5000;

  const consecutiveNegativesRef = useRef<number>(0);
  const REQUIRED_NEGATIVES_FOR_LOST = 3;

  const isSpeakingRef = useRef<boolean>(false);

  const lastGuidanceAnnouncementRef = useRef<string>("");
  const lastGuidanceTimeRef = useRef<number>(0);
  const GUIDANCE_ANNOUNCEMENT_COOLDOWN = 3000;

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

  // Play wooden "found" sound
  const playFoundSound = () => {
    if (!audioContextRef.current) return;

    const audioContext = audioContextRef.current;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(220, audioContext.currentTime); // A3 - warm, woody tone

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(800, audioContext.currentTime); // Mellow the sound
    filter.Q.setValueAtTime(1, audioContext.currentTime);

    oscillator.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioContext.destination);

    const now = audioContext.currentTime;
    const duration = 0.4;

    // Soft attack and decay for wooden feel
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.15, now + 0.05); // Soft peak
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

    oscillator.start(now);
    oscillator.stop(now + duration);
  };

  // Request device orientation permission
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
        }
        return false;
      } catch (err) {
        console.error("Error requesting orientation permission:", err);
        return false;
      }
    }
    return true;
  };

  // Device orientation listener
  useEffect(() => {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as any).requestPermission === "function"
    ) {
      setNeedsOrientationPermission(true);
    }

    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha !== null) setCurrentHeading(event.alpha);
      if (event.beta !== null) setCurrentBeta(event.beta);
      if (event.gamma !== null) setCurrentGamma(event.gamma);
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () =>
      window.removeEventListener("deviceorientation", handleOrientation);
  }, []);

  // Calculate guidance and glow direction
  useEffect(() => {
    if (currentHeading === null || !itemLocation || !isScanning) {
      setGuidance("");
      setGlowDirection(null);
      return;
    }

    const targetHeading = itemLocation.heading;
    let diff = targetHeading - currentHeading;

    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;

    const threshold = 15;
    let newGuidance = "";
    let newGlowDirection: "left" | "right" | "center" | null = null;

    if (Math.abs(diff) < threshold) {
      const betaDiff =
        currentBeta !== null && itemLocation.beta !== null
          ? Math.abs(currentBeta - itemLocation.beta)
          : 0;

      if (betaDiff < 20) {
        newGuidance = "Right here";
        newGlowDirection = "center";
      } else {
        newGuidance =
          betaDiff > 0
            ? currentBeta! > itemLocation.beta!
              ? "Tilt down"
              : "Tilt up"
            : "Right here";
        newGlowDirection = "center";
      }
    } else {
      const degrees = Math.abs(diff);
      // Camera faces opposite direction, so invert the turn direction
      if (diff > 0) {
        // Need to turn left
        if (degrees > 45) {
          newGuidance = "Left";
        } else {
          newGuidance = "Slight left";
        }
        newGlowDirection = "left";
      } else {
        // Need to turn right
        if (degrees > 45) {
          newGuidance = "Right";
        } else {
          newGuidance = "Slight right";
        }
        newGlowDirection = "right";
      }
    }

    setGuidance(newGuidance);
    setGlowDirection(newGlowDirection);

    // Voice guidance
    if ("speechSynthesis" in window && !isSpeakingRef.current) {
      const now = Date.now();
      const timeSinceLastGuidance = now - lastGuidanceTimeRef.current;

      if (
        newGuidance !== lastGuidanceAnnouncementRef.current &&
        timeSinceLastGuidance > GUIDANCE_ANNOUNCEMENT_COOLDOWN
      ) {
        if (
          newGuidance.includes("Right here") ||
          (timeSinceLastGuidance > GUIDANCE_ANNOUNCEMENT_COOLDOWN * 2 &&
            Math.abs(diff) > 30)
        ) {
          isSpeakingRef.current = true;
          lastGuidanceAnnouncementRef.current = newGuidance;
          lastGuidanceTimeRef.current = now;

          const utterance = new SpeechSynthesisUtterance(newGuidance);
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

      if ("speechSynthesis" in window && !isSpeakingRef.current) {
        isSpeakingRef.current = true;
        const utterance = new SpeechSynthesisUtterance("Location saved");
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

  // Enumerate devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError("Camera requires HTTPS");
          return;
        }

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

  // Audio beeping
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

    if (!result.visible || result.confidence < 0.3) return;

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
      setError("Describe what you're looking for");
      return;
    }

    if (needsOrientationPermission) {
      await requestOrientationPermission();
    }

    setError("");
    setIsScanning(true);
    setResult(null);

    try {
      // Ensure audio context is resumed (required on mobile)
      if (audioContextRef.current) {
        if (audioContextRef.current.state === "suspended") {
          await audioContextRef.current.resume();
          console.log("Audio context resumed");
        }
        console.log("Audio context state:", audioContextRef.current.state);
      } else {
        console.error("Audio context not initialized");
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
- description (string): ONLY if visible=true, give location in 5 words max using spatial references the user can feel or know (e.g., "on the table", "by the wall", "near the window", "on the floor"). NEVER use "left/right side" or camera-relative directions.

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

                console.log("📊 State:", {
                  visible: parsed.visible,
                  wasVisible: lastAnnouncement.wasVisible,
                  distance: parsed.distance,
                  lastDistance: lastAnnouncement.distance,
                  timeSince: timeSinceLastAnnouncement,
                  isSpeaking: isSpeakingRef.current,
                });

                let shouldAnnounce = false;
                let announcementText = "";

                if (parsed.visible && !lastAnnouncement.wasVisible) {
                  console.log("✨ Object just became visible!");
                  shouldAnnounce = true;
                  announcementText = `Found! ${parsed.distance || ""}.`;
                  // Play wooden sound
                  playFoundSound();
                } else if (
                  parsed.visible &&
                  lastAnnouncement.wasVisible &&
                  parsed.distance &&
                  parsed.distance !== lastAnnouncement.distance &&
                  timeSinceLastAnnouncement > ANNOUNCEMENT_COOLDOWN_MS &&
                  !isSpeakingRef.current
                ) {
                  console.log("📏 Distance changed!");
                  shouldAnnounce = true;
                  announcementText = `${parsed.distance}`;
                }
                // Removed "Lost. Keep searching" announcement

                if (shouldAnnounce && !isSpeakingRef.current) {
                  console.log("🔊 About to announce:", announcementText);
                  isSpeakingRef.current = true;
                  const utterance = new SpeechSynthesisUtterance(
                    announcementText,
                  );
                  utterance.rate = 1.4;
                  utterance.onend = () => {
                    console.log("✅ Speech ended:", announcementText);
                    isSpeakingRef.current = false;
                  };
                  utterance.onerror = (e) => {
                    console.error("❌ Speech error:", e, announcementText);
                    isSpeakingRef.current = false;
                  };
                  utterance.onstart = () => {
                    console.log("▶️ Speech started:", announcementText);
                  };
                  window.speechSynthesis.speak(utterance);

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
          setError(err.message);
        },
        debug: true,
      });

      await vision.start();
      visionRef.current = vision;

      const stream = vision.getMediaStream();
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      if ("speechSynthesis" in window) {
        console.log("🎤 Starting announcement for:", searchQuery);
        const utterance = new SpeechSynthesisUtterance(
          `Scanning for ${searchQuery}`,
        );
        utterance.rate = 1.2;
        utterance.onstart = () => console.log("▶️ Start speech began");
        utterance.onend = () => console.log("✅ Start speech ended");
        utterance.onerror = (e) => console.error("❌ Start speech error:", e);
        window.speechSynthesis.speak(utterance);
      } else {
        console.error("❌ speechSynthesis not available");
      }

      // Test beep to verify audio is working
      if (audioContextRef.current) {
        const testOsc = audioContextRef.current.createOscillator();
        const testGain = audioContextRef.current.createGain();
        testOsc.connect(testGain);
        testGain.connect(audioContextRef.current.destination);
        testOsc.frequency.value = 440;
        testGain.gain.value = 0.2;
        testOsc.start();
        testOsc.stop(audioContextRef.current.currentTime + 0.1);
        console.log("Test beep played");
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
    setGlowDirection(null);

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance("Scanning stopped");
      window.speechSynthesis.speak(utterance);
    }
  };

  const clearItemLocation = () => {
    setItemLocation(null);
    setGuidance("");
    setGlowDirection(null);
    lastGuidanceAnnouncementRef.current = "";
    lastGuidanceTimeRef.current = 0;

    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance("Location cleared");
      utterance.rate = 1.3;
      window.speechSynthesis.speak(utterance);
    }
  };

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {/* Screen reader announcements */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {result?.visible && `Object found`}
        {guidance && guidance}
      </div>

      {!isScanning ? (
        // Setup screen
        <div className="h-full flex flex-col p-6 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
          <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
            <div className="text-center mb-12">
              <h1 className="text-4xl font-bold mb-3 bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                Vision Scanner
              </h1>
              <p className="text-slate-400">Audio-guided object finding</p>
            </div>

            {availableDevices.length > 1 && (
              <div className="mb-6">
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-800 border-2 border-slate-600 rounded-xl text-slate-100 focus:border-cyan-500 focus:outline-none"
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
              </div>
            )}

            <div className="mb-6">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && !isScanning && startScanning()
                }
                placeholder="What are you looking for?"
                className="w-full px-6 py-4 bg-slate-800 border-2 border-slate-600 rounded-xl text-lg text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
              />
              <p className="text-xs text-slate-500 mt-2 text-center">
                e.g., door, keys, water bottle
              </p>
            </div>

            {error && (
              <div className="mb-6 bg-red-900/30 border-2 border-red-600 rounded-xl p-4 text-red-200 text-sm">
                {error}
              </div>
            )}

            <button
              onClick={startScanning}
              disabled={!searchQuery.trim()}
              className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-slate-700 disabled:to-slate-700 text-white font-semibold py-5 px-8 rounded-xl shadow-lg text-lg disabled:opacity-50"
            >
              🔍 Start Scanning
            </button>

            {needsOrientationPermission && (
              <p className="text-xs text-slate-500 mt-4 text-center">
                📱 You'll be asked for orientation permission on iOS
              </p>
            )}
          </div>
        </div>
      ) : (
        // Scanning screen - audio-first, minimal UI
        <div className="relative h-full w-full">
          {/* Camera view */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />

          {/* Directional glow overlay - left */}
          {glowDirection === "left" && itemLocation && !result?.visible && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute left-0 top-0 bottom-0 w-1/2 bg-gradient-to-r from-purple-500/40 to-transparent animate-pulse" />
            </div>
          )}

          {/* Directional glow overlay - right */}
          {glowDirection === "right" && itemLocation && !result?.visible && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute right-0 top-0 bottom-0 w-1/2 bg-gradient-to-l from-purple-500/40 to-transparent animate-pulse" />
            </div>
          )}

          {/* Center glow - on target */}
          {glowDirection === "center" && itemLocation && !result?.visible && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-0 bg-purple-500/30 animate-pulse" />
            </div>
          )}

          {/* Found state - green border glow */}
          {result?.visible && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-0 border-8 border-green-500 animate-pulse shadow-[inset_0_0_60px_rgba(34,197,94,0.4)]" />
            </div>
          )}

          {/* Minimal status indicator - top center */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2">
            <div
              className={`px-4 py-2 rounded-full backdrop-blur-sm ${
                result?.visible
                  ? "bg-green-900/70 border border-green-500"
                  : itemLocation
                    ? "bg-purple-900/70 border border-purple-500"
                    : "bg-slate-900/70 border border-slate-600"
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    result?.visible
                      ? "bg-green-400"
                      : itemLocation
                        ? "bg-purple-400"
                        : "bg-slate-400"
                  } animate-pulse`}
                />
                <span className="text-white text-sm font-medium">
                  {result?.visible
                    ? "Found"
                    : itemLocation
                      ? "Navigate"
                      : "Searching"}
                </span>
              </div>
            </div>
          </div>

          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 p-6">
            <div className="flex gap-3 justify-center">
              <button
                onClick={stopScanning}
                className="bg-red-600/90 hover:bg-red-500 backdrop-blur-sm text-white font-semibold py-4 px-8 rounded-full shadow-lg"
              >
                Stop
              </button>
              {itemLocation && (
                <button
                  onClick={clearItemLocation}
                  className="bg-slate-700/90 hover:bg-slate-600 backdrop-blur-sm text-white font-semibold py-4 px-4 rounded-full shadow-lg"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

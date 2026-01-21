import { useState, useEffect, useRef, useCallback } from "react";
import { useFinder } from "./hooks/useFinder";
import { useNavigation } from "./hooks/useNavigation";
import { getAudioService } from "./services/AudioService";

export default function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const audioService = useRef(getAudioService());
  const beepStopRef = useRef<(() => void) | null>(null);
  const searchQueryRef = useRef(searchQuery);

  // Keep ref in sync
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  // Initialize speech synthesis on mount (iOS fix)
  useEffect(() => {
    // Prime the engine silently
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  }, []);

  // --- Callbacks ---

  const handleFound = useCallback((result: any) => {
    console.log("✨ Item found callback");
    audioService.current.speak({
      text: "Found it",
      rate: 1.3,
      priority: "high",
    });
    audioService.current.playSound({ type: "found" });

    if (result.confidence > 0.6 && searchQueryRef.current) {
      navigation.markLocation(searchQueryRef.current, result.confidence);
    }
  }, []);

  const handleDistanceChanged = useCallback((distance: string) => {
    // Distance handled by beeps, no speech needed to avoid clutter
    console.log("📏 Distance:", distance);
  }, []);

  const handleLost = useCallback(() => {
    console.log("👋 Item lost callback");
    audioService.current.speak({
      text: "Lost visual. Rotate to find it.",
      rate: 1.2,
      priority: "high", // Interrupt existing speech
    });
  }, []);

  // ✅ ENABLED: Navigation Guidance Audio
  const handleGuidanceChange = useCallback((guidance: any) => {
    console.log("🧭 Guidance changed:", guidance.text);
    if (guidance.text) {
      // Directions: "Left", "Slight Right", "Tilt Up"
      audioService.current.speak({
        text: guidance.text,
        rate: 1.2, // Slightly faster for directions
        priority: "high", // Directions should be immediate
      });
    }
  }, []);

  // ✅ ENABLED: Location Locked Sound
  const handleLocationMarked = useCallback(() => {
    console.log("📍 Location marked");
    // Play a distinct "Lock on" sound
    audioService.current.playSound({
      type: "found",
      frequency: 660, // E5
      duration: 0.1,
    });
    // Double beep
    setTimeout(() => {
      audioService.current.playSound({
        type: "found",
        frequency: 880, // A5
        duration: 0.2,
      });
    }, 150);
  }, []);

  // Finder hook - manages vision detection
  const finder = useFinder({
    onFound: handleFound,
    onDistanceChanged: handleDistanceChanged,
    onLost: handleLost,
  });

  // Navigation hook - manages return to item
  const navigation = useNavigation({
    onGuidanceChange: handleGuidanceChange,
    onLocationMarked: handleLocationMarked,
  });

  // Enumerate video devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) return;
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((d) => d.kind === "videoinput");
        setAvailableDevices(videoDevices);

        // Auto-select Meta/Ray-Ban or back camera
        const meta = videoDevices.find((d) =>
          /meta|ray-ban|back|environment/i.test(d.label),
        );
        if (meta) setSelectedDeviceId(meta.deviceId);
        else if (videoDevices.length > 0)
          setSelectedDeviceId(videoDevices[0].deviceId);
      } catch (err) {
        console.error("Device Enum Error", err);
      }
    };
    getDevices();
  }, []);

  // Handle beeping logic
  useEffect(() => {
    const cleanup = () => {
      if (beepStopRef.current) {
        beepStopRef.current();
        beepStopRef.current = null;
      }
    };

    if (!finder.state.isScanning || !finder.state.result) {
      cleanup();
      return;
    }

    const result = finder.state.result;

    // Restart beep if parameters changed significantly
    if (result.visible && result.confidence >= 0.3) {
      cleanup(); // Stop old beep

      const baseFreq = 200 + result.confidence * 600; // 200Hz - 800Hz
      const rate = Math.max(0.1, 1.2 - result.confidence); // Faster as confidence grows

      beepStopRef.current = audioService.current.startContinuousBeep(
        baseFreq,
        rate,
      );
    } else {
      cleanup();
    }

    return cleanup;
  }, [
    finder.state.isScanning,
    finder.state.result?.confidence,
    finder.state.result?.visible,
  ]);

  // Actions
  const handleStartScanning = async () => {
    if (!searchQuery.trim()) return;

    // 1. Resume Audio (Required for mobile)
    await audioService.current.resume();

    // 2. Speak immediately
    audioService.current.speak({
      text: `Looking for ${searchQuery}`,
      rate: 1.1,
      priority: "high",
    });

    if (navigation.needsPermission) {
      await navigation.requestPermission();
    }

    await finder.startScanning({ searchQuery });
  };

  const handleStopScanning = async () => {
    await finder.stopScanning();
    if (beepStopRef.current) {
      beepStopRef.current();
      beepStopRef.current = null;
    }
    audioService.current.stopAll(); // Stop any pending speech
    audioService.current.speak({ text: "Stopped" });
  };

  const handleClearLocation = () => {
    navigation.clearLocation();
    audioService.current.speak({ text: "Location cleared" });
  };

  const handleTestAudio = async () => {
    await audioService.current.resume();
    audioService.current.speak({
      text: "Voice check. Left. Right. Center.",
      priority: "high",
    });
    audioService.current.playSound({ type: "found" });
  };

  const videoRef = finder.getVideoRef();

  // Visual helper for rotation
  const getArrowRotation = () => {
    const dir = navigation.guidance.direction;
    if (!dir) return 0;
    if (dir.includes("left")) return dir.includes("slight") ? -45 : -90;
    if (dir.includes("right")) return dir.includes("slight") ? 45 : 90;
    return 0;
  };

  return (
    <div className="fixed inset-0 bg-neutral-950 overflow-hidden text-neutral-100">
      {/* Hidden ARIA region for screen readers */}
      <div className="sr-only" role="status" aria-live="polite">
        {finder.state.result?.visible
          ? `Found ${searchQuery}`
          : navigation.guidance.text}
      </div>

      {!finder.state.isScanning ? (
        // --- Setup Screen ---
        <div className="h-full flex flex-col p-6 max-w-md mx-auto justify-center">
          <h1 className="text-4xl font-light mb-2 text-center">
            Vision Scanner
          </h1>

          <div className="bg-neutral-900/50 p-3 rounded mb-8 border border-neutral-800 text-center">
            <p className="text-xs text-yellow-500">
              ⚠️ Turn off Silent Mode (Ringer) for audio cues
            </p>
          </div>

          <div className="space-y-4 mb-8">
            {availableDevices.length > 0 && (
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                className="w-full bg-neutral-900 border border-neutral-700 rounded p-3"
              >
                {availableDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Camera"}
                  </option>
                ))}
              </select>
            )}

            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find (e.g. keys, door)..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded p-4 text-lg"
            />
          </div>

          <div className="space-y-3">
            <button
              onClick={handleTestAudio}
              className="w-full py-3 bg-neutral-800 rounded font-medium"
            >
              Test Audio
            </button>
            <button
              onClick={handleStartScanning}
              disabled={!searchQuery.trim()}
              className="w-full py-4 bg-white text-black rounded font-bold text-lg disabled:opacity-50"
            >
              Start Scanning
            </button>
          </div>

          {finder.state.error && (
            <p className="text-red-400 text-center mt-4 text-sm">
              {finder.state.error}
            </p>
          )}
        </div>
      ) : (
        // --- Scanner Screen ---
        <div className="relative h-full w-full bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover opacity-60"
          />

          {/* Navigation Overlay */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            {/* If Navigating back to item */}
            {navigation.isNavigating && !finder.state.result?.visible && (
              <div className="text-center">
                <div
                  style={{ transform: `rotate(${getArrowRotation()}deg)` }}
                  className="transition-transform duration-300 inline-block mb-4"
                >
                  <span className="text-6xl">⬆️</span>
                </div>
                <div className="text-3xl font-bold drop-shadow-md">
                  {navigation.guidance.text || "Scanning..."}
                </div>
              </div>
            )}

            {/* If Item Visible */}
            {finder.state.result?.visible && (
              <div className="border-4 border-green-500 rounded-lg w-64 h-64 flex items-center justify-center animate-pulse">
                <span className="bg-green-500 text-black px-2 py-1 rounded font-bold">
                  FOUND
                </span>
              </div>
            )}
          </div>

          <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-4">
            <button
              onClick={handleStopScanning}
              className="bg-red-600 px-8 py-4 rounded-full font-bold shadow-lg"
            >
              STOP
            </button>
            {navigation.isNavigating && (
              <button
                onClick={handleClearLocation}
                className="bg-neutral-800 px-6 py-4 rounded-full font-medium"
              >
                Clear Loc
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

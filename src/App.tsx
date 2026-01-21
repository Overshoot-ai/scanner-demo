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
    if ("speechSynthesis" in window) {
      // Wake up iOS speech synthesis
      const utterance = new SpeechSynthesisUtterance("");
      utterance.volume = 0;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Memoized callbacks to prevent infinite loops
  const handleFound = useCallback((result: any) => {
    console.log("✨ Item found callback");

    // Announce finding
    audioService.current.speak({
      text: "Found",
      rate: 1.3,
    });

    // Mark location for navigation (using ref to avoid dependency)
    if (result.confidence > 0.6 && searchQueryRef.current) {
      navigation.markLocation(searchQueryRef.current, result.confidence);
    }
  }, []); // Empty deps - uses refs internally

  const handleDistanceChanged = useCallback((distance: string) => {
    console.log("📏 Distance changed callback:", distance);
    // No announcement for distance changes
  }, []);

  const handleLost = useCallback(() => {
    console.log("👋 Item lost callback");
    audioService.current.speak({
      text: "Lost",
      rate: 1.3,
    });
  }, []);

  const handleGuidanceChange = useCallback((guidance: any) => {
    console.log("🧭 Guidance changed:", guidance.text);
    // No voice guidance during navigation
  }, []);

  const handleLocationMarked = useCallback(() => {
    console.log("📍 Location marked");
    // No announcement for location marked
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
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          finder.state.error = "Camera requires HTTPS";
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

  // Handle beeping based on detection confidence
  useEffect(() => {
    if (!finder.state.isScanning || !finder.state.result) {
      // Stop beeping if not scanning or no result
      if (beepStopRef.current) {
        beepStopRef.current();
        beepStopRef.current = null;
      }
      return;
    }

    const result = finder.state.result;

    // Stop previous beep
    if (beepStopRef.current) {
      beepStopRef.current();
      beepStopRef.current = null;
    }

    // Start new beep if visible
    if (result.visible && result.confidence >= 0.3) {
      const baseFrequency = 200 + result.confidence * 800;
      const beepRate = 0.2 + result.confidence * 1.8;

      beepStopRef.current = audioService.current.startContinuousBeep(
        baseFrequency,
        beepRate,
      );
    }

    return () => {
      if (beepStopRef.current) {
        beepStopRef.current();
        beepStopRef.current = null;
      }
    };
  }, [finder.state.isScanning, finder.state.result]);

  const handleStartScanning = async () => {
    if (!searchQuery.trim()) {
      return;
    }

    // ✅ iOS FIX: Speak FIRST - directly in user gesture handler
    // This must happen before any async operations for iOS
    audioService.current.speak({
      text: `Searching for ${searchQuery}`,
      rate: 1.2,
    });

    // Resume audio context (required on mobile)
    await audioService.current.resume();

    // Request navigation permission if needed
    if (navigation.needsPermission) {
      await navigation.requestPermission();
    }

    // Start finder
    await finder.startScanning({
      searchQuery,
    });
  };

  const handleStopScanning = async () => {
    await finder.stopScanning();

    // Stop audio
    if (beepStopRef.current) {
      beepStopRef.current();
      beepStopRef.current = null;
    }

    audioService.current.speak({
      text: "Searching stopped",
      rate: 1.2,
    });
  };

  const handleClearLocation = () => {
    navigation.clearLocation();
    audioService.current.speak({
      text: "Location cleared",
      rate: 1.3,
    });
  };

  const handleTestAudio = async () => {
    await audioService.current.resume();
    audioService.current.speak({
      text: "Audio is working",
      rate: 1.2,
    });
  };

  const videoRef = finder.getVideoRef();

  // Calculate arrow rotation based on navigation guidance
  const getArrowRotation = () => {
    if (!navigation.guidance.direction) return 0;

    switch (navigation.guidance.direction) {
      case "left":
        return -90;
      case "slight left":
        return -45;
      case "right":
        return 90;
      case "slight right":
        return 45;
      case "center":
        return 0;
      default:
        return 0;
    }
  };

  return (
    <div className="fixed inset-0 bg-neutral-950 overflow-hidden">
      {/* Screen reader announcements */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {finder.state.result?.visible && `Object found`}
        {navigation.guidance.text && navigation.guidance.text}
      </div>

      {!finder.state.isScanning ? (
        // Setup screen
        <div className="h-full flex flex-col p-6">
          <div className="flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
            <div className="text-center mb-16">
              <h1 className="text-5xl font-light mb-2 text-neutral-100 tracking-tight">
                Vision Scanner
              </h1>
              <p className="text-neutral-500 text-sm">
                Audio-guided object finding
              </p>
            </div>

            {availableDevices.length > 1 && (
              <div className="mb-4">
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="w-full px-4 py-3 bg-neutral-900 border border-neutral-800 rounded text-neutral-100 focus:border-neutral-600 focus:outline-none"
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
                  e.key === "Enter" &&
                  !finder.state.isScanning &&
                  handleStartScanning()
                }
                placeholder="What are you looking for?"
                className="w-full px-4 py-4 bg-neutral-900 border border-neutral-800 rounded text-lg text-neutral-100 placeholder-neutral-600 focus:border-neutral-600 focus:outline-none"
              />
              <p className="text-xs text-neutral-600 mt-2 text-center">
                e.g., door, keys, water bottle
              </p>
            </div>

            {finder.state.error && (
              <div className="mb-6 bg-red-950 border border-red-900 rounded p-4 text-red-400 text-sm">
                {finder.state.error}
              </div>
            )}

            {/* Test Audio Button (iOS) */}
            <button
              onClick={handleTestAudio}
              className="w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-100 font-medium py-3 px-8 rounded text-base transition-colors mb-3"
            >
              Test Audio
            </button>

            <button
              onClick={handleStartScanning}
              disabled={!searchQuery.trim()}
              className="w-full bg-neutral-100 hover:bg-neutral-200 disabled:bg-neutral-800 text-neutral-950 disabled:text-neutral-600 font-medium py-4 px-8 rounded text-lg transition-colors"
            >
              Start Scanning
            </button>

            {navigation.needsPermission && (
              <p className="text-xs text-neutral-600 mt-4 text-center">
                You'll be asked for orientation permission on iOS
              </p>
            )}
          </div>
        </div>
      ) : (
        // Scanning screen
        <div className="relative h-full w-full">
          {/* Camera view */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />

          {/* Navigation arrow */}
          {navigation.isNavigating && !finder.state.result?.visible && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div
                className="transition-transform duration-300"
                style={{
                  transform: `rotate(${getArrowRotation()}deg)`,
                }}
              >
                <svg
                  width="80"
                  height="80"
                  viewBox="0 0 80 80"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="drop-shadow-lg"
                >
                  <path
                    d="M40 10 L40 55 M40 55 L25 40 M40 55 L55 40"
                    stroke="white"
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          )}

          {/* Found state - simple border */}
          {finder.state.result?.visible && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-0 border-4 border-green-500" />
            </div>
          )}

          {/* Status indicator */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2">
            <div
              className={`px-4 py-2 rounded backdrop-blur-sm ${
                finder.state.result?.visible
                  ? "bg-green-950/80 border border-green-900"
                  : navigation.isNavigating
                    ? "bg-neutral-950/80 border border-neutral-800"
                    : "bg-neutral-950/80 border border-neutral-800"
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    finder.state.result?.visible
                      ? "bg-green-500"
                      : "bg-neutral-500"
                  }`}
                />
                <span className="text-white text-sm font-medium">
                  {finder.state.result?.visible
                    ? "Found"
                    : navigation.isNavigating
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
                onClick={handleStopScanning}
                className="bg-red-600/90 hover:bg-red-500 backdrop-blur-sm text-white font-medium py-3 px-8 rounded transition-colors"
              >
                Stop
              </button>
              {navigation.isNavigating && (
                <button
                  onClick={handleClearLocation}
                  className="bg-neutral-800/90 hover:bg-neutral-700 backdrop-blur-sm text-white font-medium py-3 px-6 rounded transition-colors"
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

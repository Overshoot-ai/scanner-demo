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

  // Memoized callbacks to prevent infinite loops
  const handleFound = useCallback((result: any) => {
    console.log("✨ Item found callback");

    // Play wooden found sound
    audioService.current.playSound({
      type: "found",
      frequency: 220,
      duration: 0.4,
      volume: 0.15,
      filter: {
        type: "lowpass",
        frequency: 800,
        Q: 1,
      },
    });

    // Announce finding
    const announcement = `Found! ${result.distance || ""}`;
    audioService.current.speak({
      text: announcement,
      rate: 1.4,
    });

    // Mark location for navigation (using ref to avoid dependency)
    if (result.confidence > 0.6 && searchQueryRef.current) {
      navigation.markLocation(searchQueryRef.current, result.confidence);
    }
  }, []); // Empty deps - uses refs internally

  const handleDistanceChanged = useCallback((distance: string) => {
    console.log("📏 Distance changed callback:", distance);
    audioService.current.speak({
      text: distance,
      rate: 1.4,
    });
  }, []);

  const handleLost = useCallback(() => {
    console.log("👋 Item lost callback");
    // Silently lost - no announcement per requirements
  }, []);

  const handleGuidanceChange = useCallback((guidance: any) => {
    console.log("🧭 Guidance changed:", guidance.text);
    audioService.current.speak({
      text: guidance.text,
      rate: 1.3,
    });
  }, []);

  const handleLocationMarked = useCallback(() => {
    console.log("📍 Location marked");
    audioService.current.speak({
      text: "Location saved",
      rate: 1.3,
    });
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

    // Announce start
    audioService.current.speak({
      text: `Scanning for ${searchQuery}`,
      rate: 1.2,
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
      text: "Scanning stopped",
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

  const videoRef = finder.getVideoRef();

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
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
                  e.key === "Enter" &&
                  !finder.state.isScanning &&
                  handleStartScanning()
                }
                placeholder="What are you looking for?"
                className="w-full px-6 py-4 bg-slate-800 border-2 border-slate-600 rounded-xl text-lg text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
              />
              <p className="text-xs text-slate-500 mt-2 text-center">
                e.g., door, keys, water bottle
              </p>
            </div>

            {finder.state.error && (
              <div className="mb-6 bg-red-900/30 border-2 border-red-600 rounded-xl p-4 text-red-200 text-sm">
                {finder.state.error}
              </div>
            )}

            <button
              onClick={handleStartScanning}
              disabled={!searchQuery.trim()}
              className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-slate-700 disabled:to-slate-700 text-white font-semibold py-5 px-8 rounded-xl shadow-lg text-lg disabled:opacity-50"
            >
              🔍 Start Scanning
            </button>

            {navigation.needsPermission && (
              <p className="text-xs text-slate-500 mt-4 text-center">
                📱 You'll be asked for orientation permission on iOS
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

          {/* Directional glow - left */}
          {navigation.guidance.glowSide === "left" &&
            !finder.state.result?.visible && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute left-0 top-0 bottom-0 w-1/2 bg-gradient-to-r from-purple-500/40 to-transparent animate-pulse" />
              </div>
            )}

          {/* Directional glow - right */}
          {navigation.guidance.glowSide === "right" &&
            !finder.state.result?.visible && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute right-0 top-0 bottom-0 w-1/2 bg-gradient-to-l from-purple-500/40 to-transparent animate-pulse" />
              </div>
            )}

          {/* Center glow - on target */}
          {navigation.guidance.glowSide === "center" &&
            !finder.state.result?.visible && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-0 bg-purple-500/30 animate-pulse" />
              </div>
            )}

          {/* Found state - green border glow */}
          {finder.state.result?.visible && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-0 border-8 border-green-500 animate-pulse shadow-[inset_0_0_60px_rgba(34,197,94,0.4)]" />
            </div>
          )}

          {/* Status indicator */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2">
            <div
              className={`px-4 py-2 rounded-full backdrop-blur-sm ${
                finder.state.result?.visible
                  ? "bg-green-900/70 border border-green-500"
                  : navigation.isNavigating
                    ? "bg-purple-900/70 border border-purple-500"
                    : "bg-slate-900/70 border border-slate-600"
              }`}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    finder.state.result?.visible
                      ? "bg-green-400"
                      : navigation.isNavigating
                        ? "bg-purple-400"
                        : "bg-slate-400"
                  } animate-pulse`}
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
                className="bg-red-600/90 hover:bg-red-500 backdrop-blur-sm text-white font-semibold py-4 px-8 rounded-full shadow-lg"
              >
                Stop
              </button>
              {navigation.isNavigating && (
                <button
                  onClick={handleClearLocation}
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

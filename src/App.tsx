import { useState, useEffect, useRef, useCallback } from "react";
import { useFinder } from "./hooks/useFinder";
import { useNavigation } from "./hooks/useNavigation";
import { getAudioService } from "./services/AudioService";

const NAV_PHRASES = [
  "Left",
  "Right",
  "Slight Left",
  "Slight Right",
  "Right here",
  "Tilt up",
  "Tilt down",
  "Found it",
  "Lost",
  "Stopped",
  "Location cleared",
  "Voice check. Left. Right. Center.",
];

export default function App() {
  const [searchQuery, setSearchQuery] = useState("");
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [confirmedFound, setConfirmedFound] = useState(false);
  const [debugMode, setDebugMode] = useState(false);

  const audioService = useRef(getAudioService());
  const beepStopRef = useRef<(() => void) | null>(null);
  const searchQueryRef = useRef(searchQuery);
  const navigationRef = useRef<any>(null);
  const finderRef = useRef<any>(null);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  // Initialize and Pre-synthesize
  useEffect(() => {
    const initAudio = async () => {
      // iOS priming
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
      // Pre-fetch navigation voices from ElevenLabs
      await audioService.current.preSynthesizePhrases(NAV_PHRASES);
    };
    initAudio();
  }, []);

  // First detection - sound only
  const handleFoundSound = useCallback((_result: any) => {
    audioService.current.playSound({ type: "found" });
  }, []);

  // Confirmed detection (2+ consecutive) - speech + UI
  const handleFoundConfirmed = useCallback((result: any) => {
    setConfirmedFound(true);
    audioService.current.speak({
      text: "Found it",
      rate: 1.2,
      priority: "high",
    });

    if (
      result.confidence > 0.6 &&
      searchQueryRef.current &&
      navigationRef.current
    ) {
      navigationRef.current.markLocation(
        searchQueryRef.current,
        result.confidence,
      );
    }
  }, []);

  const handleLost = useCallback(() => {
    setConfirmedFound(false);
    if (
      navigationRef.current?.isNavigating &&
      navigationRef.current?.guidance.direction === "center"
    ) {
      navigationRef.current.clearLocation();
      audioService.current.speak({
        text: "Lost",
        rate: 1.2,
        priority: "high",
      });
    }
  }, []);

  const handleGuidanceChange = useCallback((guidance: any) => {
    if (guidance.text) {
      audioService.current.speak({
        text: guidance.text,
        rate: 1.2,
        priority: "high",
      });
    }
  }, []);

  const handleLocationMarked = useCallback(() => {
    audioService.current.playSound({
      type: "found",
      frequency: 660,
      duration: 0.1,
    });
    setTimeout(() => {
      audioService.current.playSound({
        type: "found",
        frequency: 880,
        duration: 0.2,
      });
    }, 150);
  }, []);

  const finder = useFinder({
    onFoundSound: handleFoundSound,
    onFoundConfirmed: handleFoundConfirmed,
    onDistanceChanged: () => {},
    onLost: handleLost,
  });

  useEffect(() => {
    finderRef.current = finder;
  }, [finder]);

  const navigation = useNavigation({
    onGuidanceChange: handleGuidanceChange,
    onLocationMarked: handleLocationMarked,
    isObjectVisible: () => finderRef.current?.state.result?.visible ?? false,
  });

  useEffect(() => {
    navigationRef.current = navigation;
  }, [navigation]);

  // Device Enumeration
  useEffect(() => {
    const getDevices = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) return;
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter((d) => d.kind === "videoinput");
        console.log("Available cameras:", videoDevices.map(d => ({ label: d.label, id: d.deviceId })));
        setAvailableDevices(videoDevices);
        // Prioritize iPhone camera, then Meta/Ray-Ban, then any back camera
        const iphone = videoDevices.find((d) =>
          /iphone|ios/i.test(d.label),
        );
        const meta = videoDevices.find((d) =>
          /meta|ray-ban|back|environment/i.test(d.label),
        );
        if (iphone) {
          console.log("Selected iPhone camera:", iphone.label);
          setSelectedDeviceId(iphone.deviceId);
        } else if (meta) {
          console.log("Selected Meta/back camera:", meta.label);
          setSelectedDeviceId(meta.deviceId);
        } else if (videoDevices.length > 0) {
          console.log("Selected first available camera:", videoDevices[0].label);
          setSelectedDeviceId(videoDevices[0].deviceId);
        }
      } catch (err) {
        console.error(err);
      }
    };
    getDevices();
  }, []);

  // Beeping Logic
  useEffect(() => {
    const cleanup = () => {
      if (beepStopRef.current) {
        beepStopRef.current();
        beepStopRef.current = null;
      }
    };

    if (
      finder.state.isScanning &&
      finder.state.result?.visible &&
      finder.state.result.confidence >= 0.3
    ) {
      cleanup();
      const baseFreq = 200 + finder.state.result.confidence * 600;
      const rate = Math.max(0.1, 1.2 - finder.state.result.confidence);
      beepStopRef.current = audioService.current.startContinuousBeep(
        baseFreq,
        rate,
      );
    } else {
      cleanup();
    }
    return cleanup;
  }, [finder.state.isScanning, finder.state.result]);

  const handleStartScanning = async () => {
    if (!searchQuery.trim()) return;
    await audioService.current.resume();
    audioService.current.speak({
      text: `Looking for ${searchQuery}`,
      rate: 1.1,
      priority: "high",
    });
    if (navigation.needsPermission) await navigation.requestPermission();
    await finder.startScanning({ searchQuery, deviceId: selectedDeviceId });
  };

  const handleStopScanning = async () => {
    await finder.stopScanning();
    setConfirmedFound(false);
    if (beepStopRef.current) beepStopRef.current();
    navigation.clearLocation();
    audioService.current.stopAll();
    audioService.current.speak({ text: "Stopped" });
  };

  const handleTestAudio = async () => {
    await audioService.current.resume();
    // This text is included in NAV_PHRASES for zero-latency testing
    audioService.current.speak({
      text: "Voice check. Left. Right. Center.",
      priority: "high",
    });
    audioService.current.playSound({ type: "found" });
  };

  const handleEnablePermissions = async () => {
    // Resume audio context (required for iOS)
    await audioService.current.resume();
    console.log("✅ Audio context resumed");

    // Request device orientation permission (iOS 13+)
    if (navigation.needsPermission) {
      const granted = await navigation.requestPermission();
      console.log("📱 Device orientation permission:", granted ? "granted" : "denied");
    }

    // Play a test beep to confirm audio works
    audioService.current.playSound({ type: "found" });
  };

  return (
    <div className="fixed inset-0 bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="sr-only" role="status" aria-live="polite">
        {confirmedFound ? `Found ${searchQuery}` : navigation.guidance.text}
      </div>

      {!finder.state.isScanning ? (
        <div className="h-full flex flex-col p-6 max-w-md mx-auto justify-center">
          <h1 className="text-4xl font-light mb-8 text-center">
            Vision Scanner
          </h1>
          <div className="space-y-4 mb-8">
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
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Find something..."
              className="w-full bg-neutral-900 border border-neutral-700 rounded p-4 text-lg"
            />
          </div>
          <div className="space-y-3">
            <button
              onClick={handleEnablePermissions}
              className="w-full py-3 bg-blue-600 rounded font-medium"
            >
              Enable Audio & Sensors
            </button>
            <button
              onClick={handleTestAudio}
              className="w-full py-3 bg-neutral-800 rounded"
            >
              Test Audio
            </button>
            <button
              onClick={handleStartScanning}
              className="w-full py-4 bg-white text-black rounded font-bold"
            >
              Start Scanning
            </button>
          </div>
        </div>
      ) : (
        <div className="relative h-full w-full bg-black">
          <video
            ref={finder.getVideoRef()}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover opacity-60"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {navigation.isNavigating && !confirmedFound && (
              <div className="text-3xl font-bold">
                {navigation.guidance.text}
              </div>
            )}
            {confirmedFound && (
              <div className="border-4 border-green-500 w-64 h-64 flex items-center justify-center animate-pulse">
                <span className="bg-green-500 text-black px-2 py-1 font-bold">
                  FOUND
                </span>
              </div>
            )}
          </div>
          <button
            onClick={handleStopScanning}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-red-600 px-12 py-4 rounded-full font-bold"
          >
            STOP
          </button>
        </div>
      )}
    </div>
  );
}

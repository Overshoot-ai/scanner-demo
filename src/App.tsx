import { useState, useEffect, useRef, useCallback } from "react";
import { Settings } from "lucide-react";
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
  const [confirmedFound, setConfirmedFound] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);


  const audioService = useRef(getAudioService());
  const beepRef = useRef<{ update(f: number, r: number): void; stop(): void } | null>(null);
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

  // Beeping Logic — single oscillator, update frequency/rate in place
  useEffect(() => {
    if (
      finder.state.isScanning &&
      finder.state.result?.visible &&
      finder.state.result.confidence >= 0.3
    ) {
      const baseFreq = 200 + finder.state.result.confidence * 600;
      const rate = Math.max(0.1, 1.2 - finder.state.result.confidence);
      if (beepRef.current) {
        beepRef.current.update(baseFreq, rate);
      } else {
        beepRef.current = audioService.current.startContinuousBeep(
          baseFreq,
          rate,
        );
      }
    } else if (beepRef.current) {
      beepRef.current.stop();
      beepRef.current = null;
    }
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
    await finder.startScanning({
      searchQuery,
    });
  };

  const handleStopScanning = async () => {
    await finder.stopScanning();
    setConfirmedFound(false);
    if (beepRef.current) { beepRef.current.stop(); beepRef.current = null; }
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
      console.log(
        "📱 Device orientation permission:",
        granted ? "granted" : "denied",
      );
    }

    // Play a test beep to confirm audio works
    audioService.current.playSound({ type: "found" });
  };

  const confidence = finder.state.result?.confidence ?? 0;
  const isVisible = finder.state.result?.visible ?? false;
  const canStart = searchQuery.trim().length > 0;

  return (
    <div className="fixed inset-0 bg-dark-bg text-neutral-100 overflow-hidden scanlines grid-bg">
      <div className="sr-only" role="status" aria-live="polite">
        {confirmedFound ? `Found ${searchQuery}` : navigation.guidance.text}
      </div>

      {!finder.state.isScanning ? (
        /* ========== SETUP SCREEN ========== */
        <div className="h-full flex flex-col p-6 max-w-md mx-auto justify-center relative">
          {/* Title */}
          <h1 className="text-3xl font-bold mb-1 text-center uppercase tracking-widest neon-text animate-flicker">
            Overshoot Scanner
          </h1>
          <p className="text-center text-sm mb-10 opacity-50 tracking-wide"></p>

          {/* Inputs */}
          <div className="space-y-4 mb-8">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Enter target..."
              className="w-full bg-neon-cyan/5 neon-border rounded p-4 text-lg text-neutral-100 placeholder-neutral-600 outline-none focus:shadow-[0_0_12px_rgba(0,255,247,0.3)]"
            />
          </div>

          {/* Initialize button */}
          <button
            onClick={handleStartScanning}
            disabled={!canStart}
            className={`w-full py-4 rounded font-bold text-lg uppercase tracking-wider transition-all duration-300 ${
              canStart
                ? "bg-neon-cyan text-black shadow-[0_0_20px_rgba(0,255,247,0.4),0_0_40px_rgba(0,255,247,0.2)] hover:shadow-[0_0_30px_rgba(0,255,247,0.6),0_0_60px_rgba(0,255,247,0.3)]"
                : "bg-neutral-800 text-neutral-600 cursor-not-allowed"
            }`}
          >
            Initialize Scan
          </button>

          {/* Settings gear — bottom right */}
          <div className="absolute bottom-6 right-6">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="p-2 rounded-full opacity-50 hover:opacity-100 transition-opacity neon-text"
            >
              <Settings size={22} />
            </button>

            {settingsOpen && (
              <div className="absolute bottom-12 right-0 rounded-lg p-4 space-y-3 w-56 bg-dark-bg/85 backdrop-blur-[12px] border border-neon-cyan/20 shadow-[0_0_20px_rgba(0,255,247,0.1)]">
                <button
                  onClick={handleEnablePermissions}
                  className="w-full py-2 px-3 rounded text-sm neon-border bg-transparent text-neon-cyan hover:bg-neon-cyan/10 transition-colors"
                >
                  Enable Audio & Sensors
                </button>
                <button
                  onClick={handleTestAudio}
                  className="w-full py-2 px-3 rounded text-sm neon-border bg-transparent text-neon-cyan hover:bg-neon-cyan/10 transition-colors"
                >
                  Test Audio
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ========== SCANNING SCREEN ========== */
        <div className="relative h-full w-full bg-black">
          {/* Video — object-contain to show full frame */}
          <video
            ref={finder.getVideoRef()}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-contain opacity-60"
          />

          {/* CRT vignette */}
          <div className="crt-vignette" />

          {/* Top HUD bar */}
          <div className="absolute top-0 left-0 right-0 z-50 flex items-start justify-between px-4 pt-4">
            <div>
              <div className="text-sm uppercase tracking-widest opacity-60">
                Target
              </div>
              <div className="text-lg neon-text font-bold">{searchQuery}</div>
            </div>
            <div className="text-right">
              <div
                className={`text-sm uppercase tracking-widest font-bold ${
                  confirmedFound ? "neon-text-green" : "neon-text"
                }`}
              >
                {confirmedFound ? "LOCKED" : "SCANNING"}
              </div>
              {isVisible && (
                <div className="text-xs opacity-60 mt-0.5">
                  {Math.round(confidence * 100)}%
                </div>
              )}
            </div>
          </div>

          {/* Reticle — always visible */}
          <div className="absolute inset-0 flex items-center justify-center z-30">
            <div
              className={`reticle ${
                confirmedFound ? "reticle--locked" : "reticle--scanning"
              }`}
            >
              <div className="corner-bl" />
              <div className="corner-br" />
              <div className="cross-h" />
              <div className="cross-v" />
              {confirmedFound && (
                <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-sm font-bold uppercase tracking-widest neon-text-green">
                  Locked
                </div>
              )}
            </div>
          </div>

          {/* Navigation guidance */}
          {navigation.isNavigating && !confirmedFound && (
            <div className="absolute inset-0 flex items-end justify-center z-30 pb-28">
              <div className="text-2xl font-bold neon-text uppercase tracking-wider">
                {navigation.guidance.text}
              </div>
            </div>
          )}

          {/* Terminate button */}
          <button
            onClick={handleStopScanning}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 px-12 py-4 rounded-full font-bold uppercase tracking-wider bg-transparent border-2 border-neon-red neon-text-red hover:bg-neon-red/15 transition-colors shadow-[0_0_15px_rgba(255,0,60,0.3),inset_0_0_15px_rgba(255,0,60,0.1)]"
          >
            Terminate
          </button>
        </div>
      )}
    </div>
  );
}

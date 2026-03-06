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
  const [confirmedFound, setConfirmedFound] = useState(false);



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

  // Accumulate orientation readings across consecutive detections
  const orientationReadingsRef = useRef<{ heading: number; beta: number; gamma: number }[]>([]);

  // First detection - sound only + record orientation
  const handleFoundSound = useCallback((_result: any) => {
    audioService.current.playSound({ type: "found" });
    const o = navigationRef.current?.getOrientation();
    if (o?.heading != null && o?.beta != null && o?.gamma != null) {
      orientationReadingsRef.current = [{ heading: o.heading, beta: o.beta, gamma: o.gamma }];
    }
  }, []);

  // Confirmed detection (2+ consecutive) - speech + UI, use averaged coords
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
      // Record this frame's orientation too
      const o = navigationRef.current.getOrientation();
      if (o?.heading != null && o?.beta != null && o?.gamma != null) {
        orientationReadingsRef.current.push({ heading: o.heading, beta: o.beta, gamma: o.gamma });
      }

      // Average all accumulated readings
      const readings = orientationReadingsRef.current;
      if (readings.length > 0) {
        const avg = {
          heading: readings.reduce((s, r) => s + r.heading, 0) / readings.length,
          beta: readings.reduce((s, r) => s + r.beta, 0) / readings.length,
          gamma: readings.reduce((s, r) => s + r.gamma, 0) / readings.length,
        };
        navigationRef.current.markLocation(searchQueryRef.current, result.confidence, avg);
      } else {
        navigationRef.current.markLocation(searchQueryRef.current, result.confidence);
      }
      orientationReadingsRef.current = [];
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

  const handleItemMissing = useCallback(() => {
    audioService.current.speak({
      text: "Uh oh, item may have moved or was incorrectly identified. Sorry.",
      rate: 1.0,
      priority: "high",
    });
    navigationRef.current?.clearLocation();
    setConfirmedFound(false);
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
    onItemMissing: handleItemMissing,
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

    audioService.current.speak({
      text: `Looking for ${searchQuery}`,
      rate: 1.1,
      priority: "high",
    });
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

  const [audioReady, setAudioReady] = useState(false);

  const handleEnablePermissions = async () => {
    // Resume audio context (required for iOS)
    await audioService.current.resume();
    console.log("✅ Audio context resumed");

    // Prime speechSynthesis on user gesture
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0;
    window.speechSynthesis.speak(primer);

    // Request device orientation permission (iOS 13+)
    if (navigation.needsPermission) {
      const granted = await navigation.requestPermission();
      console.log(
        "📱 Device orientation permission:",
        granted ? "granted" : "denied",
      );
    }

    setAudioReady(true);

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
          {/* Guide */}
          <div className="mb-8 space-y-2 text-sm opacity-70 leading-relaxed">
            <h1 className="text-lg font-bold neon-text mb-3">How it works</h1>
            <p>Type what you're looking for — anything around you like "red mug" or "my keys".</p>
            <p>Point your camera and slowly sweep around. Beeping means the item is in view — faster and higher beeping means a stronger match.</p>
            <p>You'll hear voice directions to guide you back if you look away.</p>
          </div>

          {/* Inputs */}
          <div className="space-y-4 mb-8">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Enter target..."
              aria-label="Enter item to search for"
              className="w-full bg-neon-cyan/5 neon-border rounded p-4 text-lg text-neutral-100 placeholder-neutral-600 outline-none focus:shadow-[0_0_12px_rgba(0,255,247,0.3)]"
            />
          </div>

          {/* Enable Audio button — must be tapped first */}
          {!audioReady && (
            <button
              onClick={handleEnablePermissions}
              className="w-full py-4 mb-3 rounded font-bold text-lg uppercase tracking-wider border-2 border-neon-cyan bg-transparent text-neon-cyan hover:bg-neon-cyan/10 transition-colors"
            >
              Enable Audio & Sensors
            </button>
          )}

          {/* Initialize button — only available after audio is ready */}
          <button
            onClick={handleStartScanning}
            disabled={!canStart || !audioReady}
            className={`w-full py-4 rounded font-bold text-lg uppercase tracking-wider transition-all duration-300 ${
              canStart && audioReady
                ? "bg-neon-cyan text-black shadow-[0_0_20px_rgba(0,255,247,0.4),0_0_40px_rgba(0,255,247,0.2)] hover:shadow-[0_0_30px_rgba(0,255,247,0.6),0_0_60px_rgba(0,255,247,0.3)]"
                : "bg-neutral-800 text-neutral-600 cursor-not-allowed"
            }`}
          >
            Initialize Scan
          </button>

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

          {/* Debug overlay */}
          {import.meta.env.DEV && navigation.isNavigating && (
            <div className="absolute top-16 left-4 z-50 text-xs font-mono opacity-70 space-y-1">
              <div>Target: {navigation.itemLocation?.heading.toFixed(1)}° heading, {navigation.itemLocation?.beta.toFixed(1)}° tilt</div>
              <div>Current: {navigation.getOrientation().heading?.toFixed(1)}° heading, {navigation.getOrientation().beta?.toFixed(1)}° tilt</div>
              <div>Diff: {navigation.itemLocation && navigation.getOrientation().heading != null
                ? (() => {
                    let d = navigation.itemLocation.heading - navigation.getOrientation().heading!;
                    if (d > 180) d -= 360;
                    if (d < -180) d += 360;
                    return d.toFixed(1);
                  })()
                : "—"}°</div>
              <div>Direction: {navigation.guidance.direction || "—"}</div>
            </div>
          )}

          {/* CRT vignette */}
          <div className="crt-vignette" aria-hidden="true" />

          {/* Top HUD bar */}
          <div aria-hidden="true" className="absolute top-0 left-0 right-0 z-50 flex items-start justify-between px-4 pt-4">
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
          <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center z-30">
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
            <div aria-hidden="true" className="absolute inset-0 flex items-end justify-center z-30 pb-28">
              <div className="text-2xl font-bold neon-text uppercase tracking-wider">
                {navigation.guidance.text}
              </div>
            </div>
          )}

          {/* Terminate button */}
          <button
            onClick={handleStopScanning}
            aria-label="Stop scanning"
            className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 px-12 py-4 rounded-full font-bold uppercase tracking-wider bg-transparent border-2 border-neon-red neon-text-red hover:bg-neon-red/15 transition-colors shadow-[0_0_15px_rgba(255,0,60,0.3),inset_0_0_15px_rgba(255,0,60,0.1)]"
          >
            Terminate
          </button>
        </div>
      )}
    </div>
  );
}

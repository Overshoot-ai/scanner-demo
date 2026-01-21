/**
 * useFinder Hook
 *
 * Manages object detection using Overshoot Vision AI
 * Handles:
 * - Vision API integration
 * - Result deduplication
 * - State transitions (not found -> found -> lost)
 * - Triggers for audio announcements
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { RealtimeVision } from "@overshoot/sdk";

export interface FinderResult {
  visible: boolean;
  confidence: number;
  distance?: "very close" | "close" | "medium" | "far";
  description?: string;
}

export interface FinderState {
  isScanning: boolean;
  result: FinderResult | null;
  error: string;
}

export interface FinderCallbacks {
  onFound: (result: FinderResult) => void;
  onDistanceChanged: (distance: string) => void;
  onLost: () => void;
}

export interface FinderConfig {
  searchQuery: string;
  apiUrl?: string;
  apiKey?: string;
  onResult?: (result: FinderResult) => void;
}

export function useFinder(callbacks: FinderCallbacks) {
  const [state, setState] = useState<FinderState>({
    isScanning: false,
    result: null,
    error: "",
  });

  const visionRef = useRef<RealtimeVision | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Deduplication state
  const lastAnnouncementRef = useRef<{
    wasVisible: boolean;
    distance: string | null;
    timestamp: number;
  }>({ wasVisible: false, distance: null, timestamp: 0 });

  const consecutiveNegativesRef = useRef<number>(0);
  const REQUIRED_NEGATIVES_FOR_LOST = 3;
  const ANNOUNCEMENT_COOLDOWN_MS = 5000;

  /**
   * Start scanning for an object
   */
  const startScanning = async (config: FinderConfig) => {
    if (!config.searchQuery.trim()) {
      setState((prev) => ({
        ...prev,
        error: "Please describe what you are looking for",
      }));
      return;
    }

    setState({
      isScanning: true,
      result: null,
      error: "",
    });

    // Reset deduplication state
    lastAnnouncementRef.current = {
      wasVisible: false,
      distance: null,
      timestamp: 0,
    };
    consecutiveNegativesRef.current = 0;

    try {
      const apiUrl = config.apiUrl || "https://cluster1.overshoot.ai/api/v0.2";
      const apiKey = config.apiKey || import.meta.env.VITE_API_KEY || "";

      console.log("🔍 Starting vision scanning for:", config.searchQuery);

      const vision = new RealtimeVision({
        apiUrl,
        apiKey,
        prompt: `You are helping a visually impaired person find: "${config.searchQuery}". 
Analyze the video and determine if the object is visible. Return ONLY JSON with these fields:
- visible (boolean): is the object clearly visible in frame?
- confidence (number 0-1): how confident are you it's the correct object?
- distance (string): ONLY if visible=true, estimate distance. For household items: "very close" = within arm's reach (< 1 meter), "close" = 1-2 meters, "medium" = 2-4 meters, "far" = > 4 meters. For large objects like doors/cars, scale proportionally.

CRITICAL: If visible=false, do NOT include distance or description fields at all. Return only {"visible": false, "confidence": 0}.

Be precise - only set visible=true if you're confident it's the correct object.`,
        source: {
          type: "camera",
          cameraFacing: "environment",
        },
        backend: "overshoot",
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
        processing: {
          fps: 30,
          sampling_ratio: 1.0,
          clip_length_seconds: 0.1,
          delay_seconds: 0.1,
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
          },
          required: ["visible", "confidence"],
        },
        onResult: (inferenceResult) => {
          if (inferenceResult.ok) {
            try {
              const parsed = JSON.parse(inferenceResult.result) as FinderResult;
              console.log("📊 Vision result:", parsed);

              // Update state
              setState((prev) => ({ ...prev, result: parsed }));

              // Call config callback if provided
              if (config.onResult) {
                config.onResult(parsed);
              }

              // Handle deduplication and callbacks
              handleResultCallbacks(parsed, callbacks);
            } catch (e) {
              console.error("❌ Failed to parse result:", e);
            }
          }
        },
        onError: (err) => {
          console.error("❌ Vision error:", err);
          setState((prev) => ({ ...prev, error: err.message }));
        },
        debug: true,
      });

      await vision.start();
      visionRef.current = vision;

      // Attach video stream
      const stream = vision.getMediaStream();
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      console.log("✅ Vision scanning started");
    } catch (err) {
      console.error("❌ Failed to start scanning:", err);
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : "Failed to start camera",
        isScanning: false,
      }));
    }
  };

  /**
   * Stop scanning
   */
  const stopScanning = async () => {
    console.log("⏹️ Stopping vision scanning");

    if (visionRef.current) {
      await visionRef.current.stop();
      visionRef.current = null;
    }

    setState({
      isScanning: false,
      result: null,
      error: "",
    });

    // Reset deduplication state
    lastAnnouncementRef.current = {
      wasVisible: false,
      distance: null,
      timestamp: 0,
    };
    consecutiveNegativesRef.current = 0;
  };

  /**
   * Handle result callbacks with deduplication
   */
  const handleResultCallbacks = useCallback(
    (result: FinderResult, cbs: FinderCallbacks) => {
      const now = Date.now();
      const lastAnnouncement = lastAnnouncementRef.current;
      const timeSinceLastAnnouncement = now - lastAnnouncement.timestamp;

      // Track consecutive negatives
      if (!result.visible) {
        consecutiveNegativesRef.current++;
      } else {
        consecutiveNegativesRef.current = 0;
      }

      // Case 1: Object just became visible (not found -> found)
      if (result.visible && !lastAnnouncement.wasVisible) {
        console.log("✨ Object found!");
        cbs.onFound(result);
        lastAnnouncementRef.current = {
          wasVisible: true,
          distance: result.distance || null,
          timestamp: now,
        };
        return;
      }

      // Case 2: Distance changed while visible
      if (
        result.visible &&
        lastAnnouncement.wasVisible &&
        result.distance &&
        result.distance !== lastAnnouncement.distance &&
        timeSinceLastAnnouncement > ANNOUNCEMENT_COOLDOWN_MS
      ) {
        console.log("📏 Distance changed:", result.distance);
        cbs.onDistanceChanged(result.distance);
        lastAnnouncementRef.current = {
          wasVisible: true,
          distance: result.distance,
          timestamp: now,
        };
        return;
      }

      // Case 3: Object lost (found -> not found)
      if (
        !result.visible &&
        lastAnnouncement.wasVisible &&
        consecutiveNegativesRef.current >= REQUIRED_NEGATIVES_FOR_LOST
      ) {
        console.log("👋 Object lost");
        cbs.onLost();
        lastAnnouncementRef.current = {
          wasVisible: false,
          distance: null,
          timestamp: now,
        };
        return;
      }
    },
    [],
  );

  /**
   * Get video element ref (for attaching to UI)
   */
  const getVideoRef = () => videoRef;

  /**
   * Get current media stream
   */
  const getMediaStream = () => {
    return visionRef.current?.getMediaStream() || null;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (visionRef.current) {
        visionRef.current.stop();
      }
    };
  }, []);

  return {
    state,
    startScanning,
    stopScanning,
    getVideoRef,
    getMediaStream,
  };
}

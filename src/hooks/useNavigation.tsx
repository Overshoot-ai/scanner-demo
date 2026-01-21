/**
 * useNavigation Hook
 *
 * Manages navigation back to a previously found item using device orientation
 * Handles:
 * - Device orientation tracking
 * - Location marking when item is found
 * - Direction calculation (left, right, center)
 * - iOS permission requests
 */

import { useState, useEffect, useRef } from "react";

export interface ItemLocation {
  heading: number;
  beta: number;
  gamma: number;
  timestamp: number;
  searchQuery: string;
}

export interface NavigationGuidance {
  direction:
    | "left"
    | "slight left"
    | "right"
    | "slight right"
    | "center"
    | null;
  text: string;
  glowSide: "left" | "right" | "center" | null;
}

export interface NavigationCallbacks {
  onGuidanceChange: (guidance: NavigationGuidance) => void;
  onLocationMarked: () => void;
}

export function useNavigation(callbacks?: NavigationCallbacks) {
  const [currentHeading, setCurrentHeading] = useState<number | null>(null);
  const [currentBeta, setCurrentBeta] = useState<number | null>(null);
  const [currentGamma, setCurrentGamma] = useState<number | null>(null);
  const [itemLocation, setItemLocation] = useState<ItemLocation | null>(null);
  const [guidance, setGuidance] = useState<NavigationGuidance>({
    direction: null,
    text: "",
    glowSide: null,
  });
  const [needsPermission, setNeedsPermission] = useState(false);

  const lastGuidanceRef = useRef<string>("");
  const lastGuidanceTimeRef = useRef<number>(0);
  const callbacksRef = useRef(callbacks);
  const GUIDANCE_COOLDOWN_MS = 3000;

  // Keep callbacks ref in sync but don't trigger re-renders
  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  /**
   * Initialize device orientation listeners
   */
  useEffect(() => {
    // Check if permission is needed (iOS 13+)
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as any).requestPermission === "function"
    ) {
      setNeedsPermission(true);
    }

    const handleOrientation = (event: DeviceOrientationEvent) => {
      if (event.alpha !== null) setCurrentHeading(event.alpha);
      if (event.beta !== null) setCurrentBeta(event.beta);
      if (event.gamma !== null) setCurrentGamma(event.gamma);
    };

    window.addEventListener("deviceorientation", handleOrientation);

    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, []);

  /**
   * Request device orientation permission (iOS)
   */
  const requestPermission = async (): Promise<boolean> => {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as any).requestPermission === "function"
    ) {
      try {
        const permission = await (
          DeviceOrientationEvent as any
        ).requestPermission();
        if (permission === "granted") {
          setNeedsPermission(false);
          console.log("✅ Device orientation permission granted");
          return true;
        }
        console.warn("⚠️ Device orientation permission denied");
        return false;
      } catch (err) {
        console.error("❌ Error requesting orientation permission:", err);
        return false;
      }
    }
    // Android doesn't need permission
    return true;
  };

  /**
   * Mark current location (when item is found)
   */
  const markLocation = (searchQuery: string, confidence: number = 1.0) => {
    if (
      currentHeading === null ||
      currentBeta === null ||
      currentGamma === null
    ) {
      console.warn("⚠️ Cannot mark location - orientation data not available");
      return false;
    }

    if (confidence < 0.6) {
      console.log("⏸️ Confidence too low to mark location");
      return false;
    }

    const location: ItemLocation = {
      heading: currentHeading,
      beta: currentBeta,
      gamma: currentGamma,
      timestamp: Date.now(),
      searchQuery,
    };

    console.log("📍 Location marked:", location);
    setItemLocation(location);

    if (callbacksRef.current?.onLocationMarked) {
      callbacksRef.current.onLocationMarked();
    }

    return true;
  };

  /**
   * Clear marked location
   */
  const clearLocation = () => {
    console.log("🧹 Location cleared");
    setItemLocation(null);
    setGuidance({
      direction: null,
      text: "",
      glowSide: null,
    });
    lastGuidanceRef.current = "";
    lastGuidanceTimeRef.current = 0;
  };

  /**
   * Calculate guidance based on current orientation
   */
  useEffect(() => {
    if (currentHeading === null || !itemLocation) {
      setGuidance({
        direction: null,
        text: "",
        glowSide: null,
      });
      return;
    }

    const targetHeading = itemLocation.heading;
    let diff = targetHeading - currentHeading;

    // Normalize to -180 to 180
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;

    const threshold = 15; // degrees tolerance for "center"
    let newGuidance: NavigationGuidance;

    if (Math.abs(diff) < threshold) {
      // Close to target heading - check vertical angle
      const betaDiff =
        currentBeta !== null && itemLocation.beta !== null
          ? Math.abs(currentBeta - itemLocation.beta)
          : 0;

      if (betaDiff < 20) {
        newGuidance = {
          direction: "center",
          text: "Right here",
          glowSide: "center",
        };
      } else {
        // Need to adjust vertical angle
        const tiltDirection = currentBeta! > itemLocation.beta! ? "down" : "up";
        newGuidance = {
          direction: "center",
          text: `Tilt ${tiltDirection}`,
          glowSide: "center",
        };
      }
    } else {
      const degrees = Math.abs(diff);
      // Camera faces opposite direction, so invert
      const isLeft = diff > 0;
      const isSlight = degrees <= 45;

      newGuidance = {
        direction: isLeft
          ? isSlight
            ? "slight left"
            : "left"
          : isSlight
            ? "slight right"
            : "right",
        text: isLeft
          ? isSlight
            ? "Slight left"
            : "Left"
          : isSlight
            ? "Slight right"
            : "Right",
        glowSide: isLeft ? "left" : "right",
      };
    }

    setGuidance(newGuidance);

    // Notify callback if guidance changed (with cooldown)
    if (callbacksRef.current?.onGuidanceChange) {
      const now = Date.now();
      const timeSinceLastGuidance = now - lastGuidanceTimeRef.current;

      if (
        newGuidance.text !== lastGuidanceRef.current &&
        timeSinceLastGuidance > GUIDANCE_COOLDOWN_MS
      ) {
        // Only announce important changes
        if (
          newGuidance.direction === "center" ||
          (timeSinceLastGuidance > GUIDANCE_COOLDOWN_MS * 2 &&
            Math.abs(diff) > 30)
        ) {
          callbacksRef.current.onGuidanceChange(newGuidance);
          lastGuidanceRef.current = newGuidance.text;
          lastGuidanceTimeRef.current = now;
        }
      }
    }
  }, [currentHeading, currentBeta, itemLocation]);

  /**
   * Check if navigation is active
   */
  const isNavigating = itemLocation !== null;

  /**
   * Get current orientation data
   */
  const getOrientation = () => ({
    heading: currentHeading,
    beta: currentBeta,
    gamma: currentGamma,
  });

  return {
    guidance,
    itemLocation,
    isNavigating,
    needsPermission,
    requestPermission,
    markLocation,
    clearLocation,
    getOrientation,
  };
}

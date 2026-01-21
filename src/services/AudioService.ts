/**
 * AudioService
 *
 * Manages all audio output including:
 * - Speech synthesis (voice announcements)
 * - Sound effects (beeps, clicks, tones)
 *
 * Rules:
 * - Two speech announcements cannot play concurrently (queued or cancelled)
 * - Sound effects can play concurrently with speech
 * - Multiple sound effects can overlap
 */

type SpeechRequest = {
  text: string;
  rate?: number;
  priority?: "normal" | "high"; // high priority cancels current speech
};

type SoundEffect = {
  type: "beep" | "click" | "found" | "custom";
  frequency?: number;
  duration?: number;
  volume?: number;
  filter?: {
    type: BiquadFilterType;
    frequency: number;
    Q?: number;
  };
};

export class AudioService {
  private audioContext: AudioContext;
  private isSpeaking: boolean = false;
  private activeOscillators: OscillatorNode[] = [];

  constructor() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();

    // iOS: Initialize speech synthesis
    if ("speechSynthesis" in window) {
      // Load voices (required on iOS)
      window.speechSynthesis.getVoices();

      // Listen for voices changed event (iOS specific)
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }
    }
  }

  /**
   * Resume audio context (required after user interaction on mobile)
   */
  async resume() {
    // 1. Check strict suspension state
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // 2. iOS Safari Trick: Play a silent buffer to physically unlock the audio thread
    // This is often required even if state says 'running'
    try {
      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start(0);
      console.log("🔊 Audio context resumed & unlocked");
    } catch (e) {
      console.error("Audio unlock failed", e);
    }
  }

  /**
   * Get current audio context state
   */
  getState() {
    return {
      contextState: this.audioContext.state,
      isSpeaking: this.isSpeaking,
    };
  }

  /**
   * Speak text using speech synthesis
   * Returns a promise that resolves when speech completes
   */
  speak(request: SpeechRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        console.error("❌ Speech synthesis not available");
        reject(new Error("Speech synthesis not supported"));
        return;
      }

      // Handle priority
      if (request.priority === "high" && this.isSpeaking) {
        console.log("⚠️ High priority speech, cancelling current");
        window.speechSynthesis.cancel();
        this.isSpeaking = false;
      }

      // Wait if already speaking (normal priority)
      if (this.isSpeaking && request.priority !== "high") {
        console.log("⏸️ Speech queued:", request.text);
        // Could implement a queue here, for now just skip
        resolve();
        return;
      }

      console.log("🎤 Speaking:", request.text);
      this.isSpeaking = true;

      const utterance = new SpeechSynthesisUtterance(request.text);
      utterance.rate = request.rate || 1.3;

      // iOS: Set voice explicitly (helps with reliability)
      const voices = window.speechSynthesis.getVoices();
      const englishVoice = voices.find((v) => v.lang.startsWith("en"));
      if (englishVoice) {
        utterance.voice = englishVoice;
      }

      utterance.onstart = () => {
        console.log("▶️ Speech started:", request.text);
      };

      utterance.onend = () => {
        console.log("✅ Speech ended:", request.text);
        this.isSpeaking = false;
        resolve();
      };

      utterance.onerror = (e) => {
        console.error("❌ Speech error:", e, request.text);
        this.isSpeaking = false;

        // iOS specific: retry once on error
        if (e.error === "canceled" || e.error === "interrupted") {
          console.log("🔄 Retrying speech...");
          setTimeout(() => {
            try {
              window.speechSynthesis.speak(utterance);
            } catch (retryErr) {
              console.error("❌ Retry failed:", retryErr);
              reject(retryErr);
            }
          }, 100);
        } else {
          reject(e);
        }
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  /**
   * Play a sound effect (can play concurrently with speech and other sounds)
   */
  playSound(effect: SoundEffect): void {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    // Apply filter if specified
    if (effect.filter) {
      const filter = this.audioContext.createBiquadFilter();
      filter.type = effect.filter.type;
      filter.frequency.setValueAtTime(
        effect.filter.frequency,
        this.audioContext.currentTime,
      );
      if (effect.filter.Q) {
        filter.Q.setValueAtTime(effect.filter.Q, this.audioContext.currentTime);
      }
      oscillator.connect(filter);
      filter.connect(gainNode);
    } else {
      oscillator.connect(gainNode);
    }

    gainNode.connect(this.audioContext.destination);

    // Configure oscillator
    oscillator.type = "sine";
    const frequency = effect.frequency || this.getDefaultFrequency(effect.type);
    oscillator.frequency.setValueAtTime(
      frequency,
      this.audioContext.currentTime,
    );

    // Configure envelope
    const now = this.audioContext.currentTime;
    const duration = effect.duration || this.getDefaultDuration(effect.type);
    const volume = effect.volume || this.getDefaultVolume(effect.type);

    this.applyEnvelope(gainNode, now, duration, volume, effect.type);

    // Start and schedule stop
    oscillator.start(now);
    oscillator.stop(now + duration);

    // Track active oscillators
    this.activeOscillators.push(oscillator);
    oscillator.onended = () => {
      const index = this.activeOscillators.indexOf(oscillator);
      if (index > -1) {
        this.activeOscillators.splice(index, 1);
      }
    };
  }

  /**
   * Play a continuous beep (for proximity detection)
   * Returns a function to stop the beep
   *
   * OPTIMIZED FOR MOBILE: Uses a single oscillator and modulates gain
   * instead of creating new nodes repeatedly.
   */
  startContinuousBeep(baseFrequency: number, beepRate: number): () => void {
    // 1. Create nodes once
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      baseFrequency,
      this.audioContext.currentTime,
    );

    // Start silent
    gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    // Start immediately
    oscillator.start();
    this.activeOscillators.push(oscillator);

    // 2. Schedule rhythm using the same node
    const scheduleBeep = () => {
      if (this.audioContext.state === "closed") return;

      const now = this.audioContext.currentTime;
      const beepDuration = 0.1;

      // Cancel any future scheduled values to prevent conflict
      gainNode.gain.cancelScheduledValues(now);

      // Instant attack, hold, release
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.3, now + 0.02);
      gainNode.gain.setValueAtTime(0.3, now + beepDuration - 0.02);
      gainNode.gain.linearRampToValueAtTime(0, now + beepDuration);
    };

    // Initial beep
    scheduleBeep();

    // Loop
    const interval = setInterval(scheduleBeep, beepRate * 1000);

    // Return stop function
    return () => {
      clearInterval(interval);
      try {
        const now = this.audioContext.currentTime;
        // Smooth fade out
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(gainNode.gain.value, now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.05);

        setTimeout(() => {
          oscillator.stop();
          oscillator.disconnect();
          gainNode.disconnect();
          const index = this.activeOscillators.indexOf(oscillator);
          if (index > -1) {
            this.activeOscillators.splice(index, 1);
          }
        }, 100);
      } catch (e) {
        console.error("Error stopping beep", e);
      }
    };
  }

  /**
   * Stop all sounds (but not speech)
   */
  stopAllSounds() {
    this.activeOscillators.forEach((osc) => {
      try {
        osc.stop();
      } catch (e) {
        // Already stopped
      }
    });
    this.activeOscillators = [];
  }

  /**
   * Stop speech
   */
  stopSpeech() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      this.isSpeaking = false;
    }
  }

  /**
   * Stop everything
   */
  stopAll() {
    this.stopAllSounds();
    this.stopSpeech();
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.stopAll();
    if (this.audioContext.state !== "closed") {
      this.audioContext.close();
    }
  }

  // Private helper methods

  private getDefaultFrequency(type: string): number {
    switch (type) {
      case "found":
        return 220; // A3 - warm woody tone
      case "click":
        return 800;
      case "beep":
        return 440;
      default:
        return 440;
    }
  }

  private getDefaultDuration(type: string): number {
    switch (type) {
      case "found":
        return 0.4;
      case "click":
        return 0.05;
      case "beep":
        return 0.1;
      default:
        return 0.1;
    }
  }

  private getDefaultVolume(type: string): number {
    switch (type) {
      case "found":
        return 0.15;
      case "click":
        return 0.2;
      case "beep":
        return 0.3;
      default:
        return 0.2;
    }
  }

  private applyEnvelope(
    gainNode: GainNode,
    startTime: number,
    duration: number,
    volume: number,
    type: string,
  ) {
    const attackTime = type === "found" ? 0.05 : 0.02;
    const releaseTime = type === "found" ? duration * 0.7 : 0.02;

    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(volume, startTime + attackTime);
    gainNode.gain.setValueAtTime(volume, startTime + duration - releaseTime);

    if (type === "found") {
      // Exponential decay for wooden feel
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
    } else {
      gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
    }
  }
}

// Singleton instance
let audioServiceInstance: AudioService | null = null;

export function getAudioService(): AudioService {
  if (!audioServiceInstance) {
    audioServiceInstance = new AudioService();
  }
  return audioServiceInstance;
}

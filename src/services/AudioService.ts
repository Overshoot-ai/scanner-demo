/**
 * AudioService
 *
 * Manages all audio output including:
 * - Speech synthesis (voice announcements)
 * - Sound effects (beeps, clicks, tones)
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
  private voicesLoaded: boolean = false;

  constructor() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();

    // iOS: Initialize speech synthesis listeners
    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        this.voicesLoaded = true;
      };
      // Trigger load immediately
      window.speechSynthesis.getVoices();
    }
  }

  /**
   * Helper to ensure voices are loaded before speaking
   */
  private async waitForVoices(): Promise<SpeechSynthesisVoice[]> {
    if ("speechSynthesis" in window) {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) return voices;

      return new Promise((resolve) => {
        const check = setInterval(() => {
          const v = window.speechSynthesis.getVoices();
          if (v.length > 0) {
            clearInterval(check);
            resolve(v);
          }
        }, 100);
        // Timeout after 1s and return empty
        setTimeout(() => {
          clearInterval(check);
          resolve([]);
        }, 1000);
      });
    }
    return [];
  }

  /**
   * Resume audio context
   */
  async resume() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Unlock Web Audio
    try {
      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start(0);
    } catch (e) {
      console.error("Audio unlock failed", e);
    }

    // Unlock Speech Synthesis (iOS requires this in user gesture)
    if ("speechSynthesis" in window) {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }
  }

  /**
   * Speak text using speech synthesis
   */
  async speak(request: SpeechRequest): Promise<void> {
    if (!("speechSynthesis" in window)) return;

    // Ensure voices are ready
    const voices = await this.waitForVoices();

    // Handle priority
    if (request.priority === "high") {
      window.speechSynthesis.cancel();
      this.isSpeaking = false;
    } else if (window.speechSynthesis.speaking) {
      // If normal priority and already speaking, simple queue logic:
      // In a real app, you might want a proper array queue.
      // For navigation, we usually just want to skip if busy to avoid lag.
      return;
    }

    this.isSpeaking = true;
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.rate = request.rate || 1.1; // Slightly slower is clearer for directions
    utterance.volume = 1.0;

    // Robust Voice Selection
    // 1. Look for "Daniel" (great iOS voice)
    // 2. Look for "Google US English" (great Android voice)
    // 3. Fallback to first English voice
    const preferredVoice =
      voices.find((v) => v.name.includes("Daniel")) ||
      voices.find((v) => v.name.includes("Google US English")) ||
      voices.find((v) => v.lang.startsWith("en"));

    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utterance.onend = () => {
      this.isSpeaking = false;
    };

    utterance.onerror = (e) => {
      console.error("Speech error", e);
      this.isSpeaking = false;
      // Force reset on error
      window.speechSynthesis.cancel();
    };

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Play a sound effect
   */
  playSound(effect: SoundEffect): void {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    if (effect.filter) {
      const filter = this.audioContext.createBiquadFilter();
      filter.type = effect.filter.type;
      filter.frequency.setValueAtTime(
        effect.filter.frequency,
        this.audioContext.currentTime,
      );
      if (effect.filter.Q)
        filter.Q.setValueAtTime(effect.filter.Q, this.audioContext.currentTime);
      oscillator.connect(filter);
      filter.connect(gainNode);
    } else {
      oscillator.connect(gainNode);
    }

    gainNode.connect(this.audioContext.destination);

    oscillator.type = "sine";
    const frequency = effect.frequency || this.getDefaultFrequency(effect.type);
    oscillator.frequency.setValueAtTime(
      frequency,
      this.audioContext.currentTime,
    );

    const now = this.audioContext.currentTime;
    const duration = effect.duration || this.getDefaultDuration(effect.type);
    const volume = effect.volume || this.getDefaultVolume(effect.type);

    this.applyEnvelope(gainNode, now, duration, volume, effect.type);

    oscillator.start(now);
    oscillator.stop(now + duration);

    this.activeOscillators.push(oscillator);
    oscillator.onended = () => {
      const index = this.activeOscillators.indexOf(oscillator);
      if (index > -1) this.activeOscillators.splice(index, 1);
    };
  }

  /**
   * Continuous beep for proximity (Mobile Optimized)
   */
  startContinuousBeep(baseFrequency: number, beepRate: number): () => void {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      baseFrequency,
      this.audioContext.currentTime,
    );
    gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.start();
    this.activeOscillators.push(oscillator);

    const scheduleBeep = () => {
      if (this.audioContext.state === "closed") return;
      const now = this.audioContext.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.3, now + 0.02);
      gainNode.gain.setValueAtTime(0.3, now + 0.08);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.1);
    };

    scheduleBeep();
    const interval = setInterval(scheduleBeep, beepRate * 1000);

    return () => {
      clearInterval(interval);
      try {
        const now = this.audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.05);
        setTimeout(() => {
          oscillator.stop();
          oscillator.disconnect();
          gainNode.disconnect();
          const index = this.activeOscillators.indexOf(oscillator);
          if (index > -1) this.activeOscillators.splice(index, 1);
        }, 100);
      } catch (e) {
        // ignore
      }
    };
  }

  stopAllSounds() {
    this.activeOscillators.forEach((osc) => {
      try {
        osc.stop();
      } catch (e) {}
    });
    this.activeOscillators = [];
  }

  stopSpeech() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      this.isSpeaking = false;
    }
  }

  stopAll() {
    this.stopAllSounds();
    this.stopSpeech();
  }

  // --- Private Helpers ---

  private getDefaultFrequency(type: string): number {
    switch (type) {
      case "found":
        return 523.25; // C5 (High chime)
      case "click":
        return 800;
      case "beep":
        return 440;
      default:
        return 440;
    }
  }

  private getDefaultDuration(type: string): number {
    return type === "found" ? 0.6 : 0.1;
  }

  private getDefaultVolume(type: string): number {
    return type === "found" ? 0.4 : 0.2;
  }

  private applyEnvelope(
    gainNode: GainNode,
    startTime: number,
    duration: number,
    volume: number,
    type: string,
  ) {
    if (type === "found") {
      // Bell-like envelope
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
    } else {
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.01);
      gainNode.gain.setValueAtTime(volume, startTime + duration - 0.01);
      gainNode.gain.linearRampToValueAtTime(0, startTime + duration);
    }
  }
}

// Singleton
let audioServiceInstance: AudioService | null = null;
export function getAudioService(): AudioService {
  if (!audioServiceInstance) audioServiceInstance = new AudioService();
  return audioServiceInstance;
}

/**
 * AudioService
 *
 * Manages all audio output including:
 * - Speech synthesis via ElevenLabs (natural voice)
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
  private elevenLabsApiKey: string;
  private voiceId: string = "21m00Tcm4TlvDq8ikWAM"; // Rachel voice (fast, clear)
  private audioQueue: HTMLAudioElement[] = [];
  private isProcessingQueue: boolean = false;

  constructor() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();

    // Get ElevenLabs API key from environment
    this.elevenLabsApiKey = import.meta.env.VITE_ELEVENLABS_API_KEY || "";

    if (!this.elevenLabsApiKey) {
      console.warn(
        "⚠️ ElevenLabs API key not found. Add VITE_ELEVENLABS_API_KEY to .env",
      );
    }
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
  }

  /**
   * Speak text using ElevenLabs API (optimized for speed)
   */
  async speak(request: SpeechRequest): Promise<void> {
    if (!this.elevenLabsApiKey) {
      console.warn("⚠️ No ElevenLabs API key - speech disabled");
      return;
    }

    // Handle priority
    if (request.priority === "high") {
      this.stopSpeech();
    } else if (this.isSpeaking) {
      return; // Skip if already speaking to avoid lag
    }

    try {
      this.isSpeaking = true;

      // Use turbo model for fastest synthesis
      // stability: 0.5 = balanced
      // similarity_boost: 0.75 = clear but fast
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?optimize_streaming_latency=4`,
        {
          method: "POST",
          headers: {
            Accept: "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": this.elevenLabsApiKey,
          },
          body: JSON.stringify({
            text: request.text,
            model_id: "eleven_turbo_v2_5", // Fastest model
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              speed: request.rate || 1.2, // Slightly faster for quick feedback
            },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status}`);
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new HTMLAudioElement(audioUrl);

      audio.onended = () => {
        this.isSpeaking = false;
        URL.revokeObjectURL(audioUrl);
        this.processQueue();
      };

      audio.onerror = (e) => {
        console.error("Audio playback error", e);
        this.isSpeaking = false;
        URL.revokeObjectURL(audioUrl);
        this.processQueue();
      };

      await audio.play();
    } catch (error) {
      console.error("ElevenLabs speech error:", error);
      this.isSpeaking = false;
    }
  }

  /**
   * Process queued audio
   */
  private async processQueue() {
    if (this.isProcessingQueue || this.audioQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    const audio = this.audioQueue.shift()!;

    audio.onended = () => {
      this.isProcessingQueue = false;
      this.processQueue();
    };

    audio.onerror = () => {
      this.isProcessingQueue = false;
      this.processQueue();
    };

    await audio.play();
  }

  /**
   * Play a sound effect (improved beeps)
   */
  playSound(effect: SoundEffect): void {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    // Use triangle wave for softer, less annoying beeps
    oscillator.type = effect.type === "found" ? "sine" : "triangle";

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
   * Continuous beep for proximity (Less frequent, softer)
   */
  startContinuousBeep(baseFrequency: number, beepRate: number): () => void {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    // Use triangle wave for softer sound
    oscillator.type = "triangle";
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
      // Softer attack and decay
      gainNode.gain.linearRampToValueAtTime(0.15, now + 0.03); // Lower volume
      gainNode.gain.setValueAtTime(0.15, now + 0.06);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.1);
    };

    scheduleBeep();
    // Make beeps less frequent - multiply rate by 1.5
    const adjustedRate = Math.max(beepRate * 1.5, 0.3); // Minimum 300ms between beeps
    const interval = setInterval(scheduleBeep, adjustedRate * 1000);

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
    this.isSpeaking = false;
    this.audioQueue = [];
    this.isProcessingQueue = false;
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
        return 600; // Lower, softer
      case "beep":
        return 350; // Much lower, less harsh
      default:
        return 350;
    }
  }

  private getDefaultDuration(type: string): number {
    return type === "found" ? 0.4 : 0.08; // Shorter beeps
  }

  private getDefaultVolume(type: string): number {
    return type === "found" ? 0.3 : 0.15; // Lower volume
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
      // Softer envelope for beeps
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(volume, startTime + 0.015);
      gainNode.gain.setValueAtTime(volume, startTime + duration - 0.015);
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

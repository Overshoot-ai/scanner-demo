/**
 * AudioService
 *
 * Manages all audio output including:
 * - Pre-synthesized ElevenLabs speech for navigational cues
 * - On-demand ElevenLabs speech for specific search queries
 * - Sound effects via generated WAV blobs + HTML5 Audio
 *
 * Uses HTML5 Audio for all playback to ensure iOS routes sound
 * through the main speaker even when a camera MediaStream is active.
 */

type SpeechRequest = {
  text: string;
  rate?: number;
  priority?: "normal" | "high";
};

type SoundEffect = {
  type: "beep" | "click" | "found" | "custom";
  frequency?: number;
  duration?: number;
  volume?: number;
};

export class AudioService {
  private audioContext: AudioContext;
  private isSpeaking: boolean = false;
  private elevenLabsApiKey: string;
  private voiceId: string = "21m00Tcm4TlvDq8ikWAM"; // Rachel voice
  private audioCache: Map<string, string> = new Map(); // text -> blobUrl
  private currentAudio: HTMLAudioElement | null = null;
  private speakingTimeout: ReturnType<typeof setTimeout> | null = null;
  private toneCache: Map<string, string> = new Map(); // cache key -> blob URL

  constructor() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.elevenLabsApiKey = import.meta.env.VITE_ELEVENLABS_API_KEY || "";

    if (!this.elevenLabsApiKey) {
      console.warn("ElevenLabs API key not found.");
    }
  }

  /**
   * Pre-synthesizes common phrases to eliminate API latency during navigation.
   */
  async preSynthesizePhrases(phrases: string[]) {
    if (!this.elevenLabsApiKey) return;

    console.log("Pre-synthesizing navigation phrases...");
    const promises = phrases.map(async (text) => {
      if (this.audioCache.has(text)) return;
      try {
        const url = await this.fetchSpeechBlobUrl(text);
        if (url) this.audioCache.set(text, url);
      } catch (e) {
        console.error(`Failed to pre-synthesize: ${text}`, e);
      }
    });

    await Promise.allSettled(promises);
    console.log("Pre-synthesis complete");
  }

  private async fetchSpeechBlobUrl(
    text: string,
    rate: number = 1.2,
  ): Promise<string | null> {
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
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: rate,
          },
        }),
      },
    );

    if (!response.ok) return null;
    const audioBlob = await response.blob();
    return URL.createObjectURL(audioBlob);
  }

  async resume() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async speak(request: SpeechRequest): Promise<void> {
    await this.resume();

    if (request.priority === "high") {
      this.stopSpeech();
    } else if (this.isSpeaking) {
      return;
    }

    // Try ElevenLabs first if API key exists
    if (this.elevenLabsApiKey) {
      try {
        this.isSpeaking = true;
        this.clearSpeakingTimeout();
        let audioUrl = this.audioCache.get(request.text);

        if (!audioUrl) {
          audioUrl = (await this.fetchSpeechBlobUrl(
            request.text,
            request.rate,
          )) as string;
        }

        if (audioUrl) {
          const audio = new Audio(audioUrl);
          this.currentAudio = audio;

          const cleanup = () => {
            this.isSpeaking = false;
            this.currentAudio = null;
            this.clearSpeakingTimeout();
            if (!this.audioCache.has(request.text)) {
              URL.revokeObjectURL(audioUrl!);
            }
          };

          audio.onended = cleanup;
          audio.onerror = cleanup;

          // Safety timeout — reset isSpeaking if onended/onerror never fires (iOS)
          this.speakingTimeout = setTimeout(() => {
            if (this.isSpeaking) {
              console.warn("Speech timeout — resetting isSpeaking");
              cleanup();
            }
          }, 10000);

          try {
            await audio.play();
          } catch (playError) {
            console.warn("audio.play() failed:", playError);
            cleanup();
            this.speakWithBrowserSynthesis(request);
          }
          return;
        }
      } catch (error) {
        console.error(
          "ElevenLabs speech error, falling back to browser:",
          error,
        );
        this.isSpeaking = false;
      }
    }

    // Fallback to browser speech synthesis
    this.speakWithBrowserSynthesis(request);
  }

  private speakWithBrowserSynthesis(request: SpeechRequest): void {
    if (!("speechSynthesis" in window)) {
      console.warn("Browser speech synthesis not available");
      this.isSpeaking = false;
      return;
    }

    this.isSpeaking = true;
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.rate = request.rate || 1.0;
    utterance.onend = () => {
      this.isSpeaking = false;
    };
    utterance.onerror = () => {
      this.isSpeaking = false;
    };
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Play a one-shot sound effect via HTML5 Audio (works on iOS speaker with camera).
   */
  async playSound(effect: SoundEffect): Promise<void> {
    const frequency =
      effect.frequency || (effect.type === "found" ? 523.25 : 350);
    const duration = effect.duration || (effect.type === "found" ? 0.4 : 0.08);
    const volume = effect.volume || (effect.type === "found" ? 0.15 : 0.08);
    const waveform = effect.type === "found" ? "sine" : "triangle";

    const url = this.getToneUrl(
      frequency,
      duration,
      volume,
      waveform as "sine" | "triangle",
    );
    const audio = new Audio(url);
    try {
      await audio.play();
    } catch (e) {
      console.warn("playSound failed:", e);
    }
  }

  /**
   * Start continuous beeping via HTML5 Audio. Returns handle to update or stop.
   * Uses a single reusable Audio element — no oscillator creation churn.
   */
  startContinuousBeep(
    baseFrequency: number,
    beepRate: number,
  ): { update(frequency: number, rate: number): void; stop(): void } {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let currentRate = beepRate;
    let currentUrl = this.getToneUrl(baseFrequency, 0.1, 0.07, "triangle");
    const beepAudio = new Audio();

    const playBeep = () => {
      if (stopped) return;
      beepAudio.src = currentUrl;
      beepAudio.currentTime = 0;
      beepAudio.play().catch(() => {});
    };

    const resetInterval = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(playBeep, Math.max(currentRate * 1500, 300));
    };

    playBeep();
    resetInterval();

    return {
      update: (frequency: number, rate: number) => {
        if (stopped) return;
        currentUrl = this.getToneUrl(frequency, 0.1, 0.07, "triangle");
        if (rate !== currentRate) {
          currentRate = rate;
          resetInterval();
        }
      },
      stop: () => {
        stopped = true;
        if (interval) clearInterval(interval);
        beepAudio.pause();
      },
    };
  }

  stopSpeech() {
    this.isSpeaking = false;
    this.clearSpeakingTimeout();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  stopAll() {
    this.stopSpeech();
  }

  private clearSpeakingTimeout() {
    if (this.speakingTimeout) {
      clearTimeout(this.speakingTimeout);
      this.speakingTimeout = null;
    }
  }

  /**
   * Get a cached blob URL for a tone with given parameters.
   * Quantizes frequency to 50Hz steps to limit cache entries.
   */
  private getToneUrl(
    frequency: number,
    duration: number,
    volume: number,
    waveform: "sine" | "triangle",
  ): string {
    const qFreq = Math.round(frequency / 50) * 50 || 50;
    const key = `${waveform}-${qFreq}-${duration}-${volume}`;
    let url = this.toneCache.get(key);
    if (!url) {
      url = URL.createObjectURL(
        this.generateToneWav(qFreq, duration, volume, waveform),
      );
      this.toneCache.set(key, url);
    }
    return url;
  }

  /**
   * Render a tone to a PCM WAV blob.
   */
  private generateToneWav(
    frequency: number,
    duration: number,
    volume: number,
    waveform: "sine" | "triangle",
  ): Blob {
    const sampleRate = 22050;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    // WAV header
    const w = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    w(8, "WAVE");
    w(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    w(36, "data");
    view.setUint32(40, numSamples * 2, true);

    // Render samples
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;

      // Waveform
      let wave: number;
      if (waveform === "triangle") {
        wave = 2 * Math.abs(2 * ((t * frequency) % 1) - 1) - 1;
      } else {
        wave = Math.sin(2 * Math.PI * frequency * t);
      }

      // Envelope: 20ms fade-in, exponential decay over duration
      const fadeIn = Math.min(1, i / (sampleRate * 0.02));
      const decay = Math.exp((-3 * t) / duration);
      const sample = wave * fadeIn * decay * volume;

      const clamped = Math.max(-32768, Math.min(32767, sample * 32767));
      view.setInt16(44 + i * 2, clamped, true);
    }

    return new Blob([buffer], { type: "audio/wav" });
  }
}

let audioServiceInstance: AudioService | null = null;
export function getAudioService(): AudioService {
  if (!audioServiceInstance) audioServiceInstance = new AudioService();
  return audioServiceInstance;
}

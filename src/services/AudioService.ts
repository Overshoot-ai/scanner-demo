/**
 * AudioService
 *
 * Manages all audio output including:
 * - Pre-synthesized ElevenLabs speech for navigational cues
 * - On-demand ElevenLabs speech for specific search queries
 * - Sound effects via Web Audio API
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
  private voiceId: string = "21m00Tcm4TlvDq8ikWAM"; // Rachel voice
  private audioCache: Map<string, string> = new Map(); // text -> blobUrl
  private currentAudio: HTMLAudioElement | null = null;
  private speakingTimeout: ReturnType<typeof setTimeout> | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.elevenLabsApiKey = import.meta.env.VITE_ELEVENLABS_API_KEY || "";

    if (!this.elevenLabsApiKey) {
      console.warn("⚠️ ElevenLabs API key not found.");
    }
  }

  /**
   * Pre-synthesizes common phrases to eliminate API latency during navigation.
   */
  async preSynthesizePhrases(phrases: string[]) {
    if (!this.elevenLabsApiKey) return;

    console.log("🎙️ Pre-synthesizing navigation phrases...");
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
    console.log("✅ Pre-synthesis complete");
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
        console.error("ElevenLabs speech error, falling back to browser:", error);
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

  async playSound(effect: SoundEffect): Promise<void> {
    await this.resume();

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    oscillator.type = effect.type === "found" ? "sine" : "triangle";

    oscillator.connect(gainNode);
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
  }

  startContinuousBeep(baseFrequency: number, beepRate: number): () => void {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let oscillator: OscillatorNode | null = null;
    let gainNode: GainNode | null = null;

    const start = async () => {
      await this.resume();
      if (stopped) return;

      oscillator = this.audioContext.createOscillator();
      gainNode = this.audioContext.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(
        baseFrequency,
        this.audioContext.currentTime,
      );
      gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);

      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      oscillator.start();

      const scheduleBeep = () => {
        if (!gainNode || stopped) return;
        // Re-resume if iOS suspended again
        if (this.audioContext.state === "suspended") {
          this.audioContext.resume();
        }
        const now = this.audioContext.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.07, now + 0.03);
        gainNode.gain.linearRampToValueAtTime(0, now + 0.1);
      };

      scheduleBeep();
      interval = setInterval(scheduleBeep, Math.max(beepRate * 1500, 300));
    };

    start();

    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      if (oscillator) {
        try {
          oscillator.stop();
          oscillator.disconnect();
        } catch (e) {}
      }
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
    this.activeOscillators.forEach((o) => {
      try {
        o.stop();
      } catch (e) {}
    });
    this.activeOscillators = [];
    this.stopSpeech();
  }

  /**
   * Keeps iOS AudioContext alive by playing a silent buffer periodically.
   * Call when scanning starts, stop when scanning ends.
   */
  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.audioContext.state === "suspended") {
        this.audioContext.resume();
      }
      const buffer = this.audioContext.createBuffer(1, 1, 22050);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start();
    }, 4000);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private clearSpeakingTimeout() {
    if (this.speakingTimeout) {
      clearTimeout(this.speakingTimeout);
      this.speakingTimeout = null;
    }
  }

  private getDefaultFrequency(type: string) {
    return type === "found" ? 523.25 : 350;
  }
  private getDefaultDuration(type: string) {
    return type === "found" ? 0.4 : 0.08;
  }
  private getDefaultVolume(type: string) {
    return type === "found" ? 0.15 : 0.08;
  }
  private applyEnvelope(
    g: GainNode,
    s: number,
    d: number,
    v: number,
    _t: string,
  ) {
    g.gain.setValueAtTime(0, s);
    g.gain.linearRampToValueAtTime(v, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.01, s + d);
  }
}

let audioServiceInstance: AudioService | null = null;
export function getAudioService(): AudioService {
  if (!audioServiceInstance) audioServiceInstance = new AudioService();
  return audioServiceInstance;
}

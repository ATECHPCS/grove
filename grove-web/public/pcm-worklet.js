/**
 * pcm-worklet — AudioWorkletProcessor for streaming speech-to-text.
 *
 * Runs on the audio render thread. Takes the microphone's Float32 PCM (at the
 * AudioContext's native rate, usually 48 kHz), linearly resamples it down to a
 * target rate (16 kHz for Whisper), accumulates fixed-size frames (~100 ms),
 * and posts each frame to the main thread (ownership transferred) so it can be
 * streamed over a WebSocket as raw little-endian f32.
 *
 * Why a worklet instead of MediaRecorder: MediaRecorder emits webm container
 * fragments that can't be decoded independently, which breaks the backend's
 * "re-transcribe a growing buffer" loop. Raw PCM has no container, so the
 * backend can slice/encode it freely.
 */

class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    // `sampleRate` is a global in the AudioWorkletGlobalScope.
    this.ratio = sampleRate / this.targetRate; // input samples per output sample
    this.frameSamples = opts.frameSamples || 1600; // ~100 ms @ 16 kHz

    this.out = new Float32Array(this.frameSamples);
    this.outPos = 0;

    // Resampler carry-over across process() blocks.
    this.frac = 0; // fractional read position into the virtual [prev, ...block]
    this.prev = 0; // last input sample of the previous block
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;

    const n = ch.length;
    // Virtual sequence: index 0 = prev, index k (1..n) = ch[k-1]. Length n+1.
    // Walk output positions at step `ratio`, linearly interpolating.
    let pos = this.frac;
    while (pos + 1 < n + 1) {
      const j0 = Math.floor(pos);
      const f = pos - j0;
      const a = j0 === 0 ? this.prev : ch[j0 - 1];
      const b = ch[j0]; // j0+1 in [1..n] → ch[j0]
      this.out[this.outPos++] = a + (b - a) * f;

      if (this.outPos >= this.frameSamples) {
        const frame = this.out.slice(0); // copy; out buffer stays ours
        this.port.postMessage(frame, [frame.buffer]);
        this.outPos = 0;
      }
      pos += this.ratio;
    }

    // Carry remainder: next block's virtual index 0 == this block's ch[n-1].
    this.frac = pos - n;
    this.prev = ch[n - 1];
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);

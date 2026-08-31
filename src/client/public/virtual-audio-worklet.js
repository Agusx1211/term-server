const FRAME_SAMPLES = 960;
const JITTER_SAMPLES = FRAME_SAMPLES * 3;
const MAX_BUFFERED_SAMPLES = FRAME_SAMPLES * 25;

class TermServerCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      this.frame[this.offset] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.offset += 1;
      if (this.offset !== FRAME_SAMPLES) continue;
      const packet = this.frame.buffer;
      this.port.postMessage(packet, [packet]);
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.offset = 0;
    }
    return true;
  }
}

class TermServerPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(MAX_BUFFERED_SAMPLES);
    this.readOffset = 0;
    this.writeOffset = 0;
    this.length = 0;
    this.playing = false;
    this.port.onmessage = ({ data }) => this.enqueue(data);
  }

  enqueue(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength % 2 !== 0) return;
    const incoming = new Int16Array(data);
    if (incoming.length > MAX_BUFFERED_SAMPLES) return;
    if (this.length + incoming.length > MAX_BUFFERED_SAMPLES) {
      const retained = Math.min(this.length, JITTER_SAMPLES);
      this.readOffset = (this.writeOffset - retained + MAX_BUFFERED_SAMPLES) % MAX_BUFFERED_SAMPLES;
      this.length = retained;
      this.playing = false;
    }
    for (let index = 0; index < incoming.length; index += 1) {
      this.samples[this.writeOffset] = incoming[index] / 0x8000;
      this.writeOffset = (this.writeOffset + 1) % MAX_BUFFERED_SAMPLES;
    }
    this.length += incoming.length;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (!this.playing && this.length >= JITTER_SAMPLES) this.playing = true;
    if (!this.playing) return true;
    const available = Math.min(output.length, this.length);
    for (let index = 0; index < available; index += 1) {
      output[index] = this.samples[this.readOffset];
      this.readOffset = (this.readOffset + 1) % MAX_BUFFERED_SAMPLES;
    }
    this.length -= available;
    if (available < output.length) this.playing = false;
    return true;
  }
}

registerProcessor("term-server-capture", TermServerCaptureProcessor);
registerProcessor("term-server-playback", TermServerPlaybackProcessor);

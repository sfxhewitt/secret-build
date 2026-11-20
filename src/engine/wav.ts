/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Minimal WAV decoder (PCM 8/16/24/32-bit and 32/64-bit float, any channel
 * count, mixed down to mono). Used for tests and as a fallback importer.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, bytes.length - body);
      break;
    }
    o = body + size + (size & 1);
  }
  if (dataOff < 0 || !channels || !sampleRate || !bits) throw new Error('Malformed WAV file');
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (f * channels + c) * bps;
      let s: number;
      if (format === 3) s = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true);
      else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
      else if (bits === 16) s = v.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
        if (x & 0x800000) x |= ~0xffffff;
        s = x / 8388608;
      } else if (bits === 32) s = v.getInt32(p, true) / 2147483648;
      else throw new Error(`Unsupported WAV bit depth: ${bits}`);
      acc += s;
    }
    out[f] = acc / channels;
  }
  return { samples: out, sampleRate };
}

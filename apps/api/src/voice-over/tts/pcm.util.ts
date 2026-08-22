// Signed 16-bit little-endian PCM -> float samples in -1..1.
//
// Separate from the provider that uses it so it can be tested directly:
// an off-by-one in the stride or the wrong divisor produces audio that
// still plays, just distorted or half-speed, which is exactly the kind of
// bug that survives a "did it run?" check.
export function decodePcmS16le(buffer: Buffer): Float32Array {
  // A trailing odd byte can't form a sample; ignore it rather than
  // reading past the end.
  const sampleCount = Math.floor(buffer.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    // Divide by 32768 (not 32767): int16 runs -32768..32767, so this is
    // the divisor that maps the full range into -1..1 without ever
    // exceeding it.
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

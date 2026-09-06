/** Decode bounded, canonical module content without a release-sized regex stack. */
export function decodeWorkerModuleBase64(value: string, maximumByteLength: number): Uint8Array | null {
  if (value.length < 4 || value.length % 4 !== 0 ||
      value.length > 4 * Math.ceil(maximumByteLength / 3)) return null;
  try {
    const binary = atob(value);
    // atob accepts whitespace and noncanonical pad bits. The linear round trip
    // rejects those forms as well as missing padding before allocating bytes.
    if (binary.length < 1 || binary.length > maximumByteLength || btoa(binary) !== value) return null;
    // String iteration in Uint8Array.from builds a release-sized temporary
    // array. Copy into the final buffer directly to stay within Workers memory.
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

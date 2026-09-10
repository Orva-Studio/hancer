/**
 * Frame decoding for the reference matcher. Uses ffmpeg rather than an image
 * library so the matcher inherits the project's existing dependency set, and
 * so a reference can be a still or a clip without branching.
 */

/**
 * Fixed decode size. Aspect ratio is deliberately not preserved: the matcher
 * only ever reads colour distributions, which are unaffected by geometry, and
 * a known size means the raw buffer can be sized without a second probe.
 */
export const SAMPLE_WIDTH = 320;
export const SAMPLE_HEIGHT = 180;

const EXPECTED_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT * 3;

/** Convert an interleaved rgb24 byte buffer to 0–1 floats. */
export function rgbBytesToFloats(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! / 255;
  return out;
}

/**
 * Decode one representative frame as interleaved RGB floats in 0–1.
 *
 * The `thumbnail` filter picks the most representative frame from the opening
 * batch rather than the first, which is often a fade from black and would
 * describe a look nobody graded.
 */
export async function decodeSampleFrame(inputPath: string): Promise<Float32Array> {
  const proc = Bun.spawn([
    "ffmpeg",
    "-v", "error",
    "-i", inputPath,
    "-vf", `thumbnail,scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`,
    "-frames:v", "1",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-",
  ], { stdout: "pipe", stderr: "pipe" });

  const buffer = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Could not read frames from ${inputPath}: ${stderr.trim()}`);
  }

  if (buffer.length < EXPECTED_BYTES) {
    throw new Error(
      `Could not read frames from ${inputPath} - decoded ${buffer.length} of ${EXPECTED_BYTES} bytes`,
    );
  }

  return rgbBytesToFloats(buffer.subarray(0, EXPECTED_BYTES));
}

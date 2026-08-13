// Camera capture and QR decoding — roadmap items 4 and 10 ("esp-see").
//
// WHOSE CAMERA THIS IS: the one attached to the machine running mcp-core, NOT
// one per box. The BOX-3 has no camera and adding one is a hardware project;
// this is the counter-side camera the roadmap describes as "gated on the camera
// hardware, not on architecture". Tool descriptions say so explicitly, because a
// model that assumes each box can see would call this and reason about the wrong
// place entirely.
//
// Capture goes through ffmpeg rather than a native binding: it is already a
// dependency-in-practice on macOS, needs no build step, and the same code path
// works with avfoundation, v4l2 (Linux) or dshow (Windows) by changing one
// config value.
//
// Decoding uses jsQR against RAW RGBA straight out of ffmpeg. That deliberately
// skips any image-decoding library — no PNG/JPEG round trip, no extra native
// dependency, and the pixels jsQR wants are exactly what ffmpeg can emit.
import { spawn } from "node:child_process";
import jsQRModule from "jsqr";

const jsQR = jsQRModule.default || jsQRModule;

// USB webcams return a black or badly-exposed first frame while auto-exposure
// and white balance settle — measured on the USB2.0 PC CAMERA here. Grabbing a
// short burst and keeping the LAST frame is the cheap fix; a single -frames:v 1
// capture is frequently unusable and fails to decode a QR that is plainly there.
const DEFAULT_WARMUP = 12;

function runProc(cmd, args, { timeoutMs, stdin = null, missingHint, mapError }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const out = [];
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`camera capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? missingHint : e.message));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const buf = Buffer.concat(out);
      // Capture tools write their normal chatter to stderr, so a non-zero exit is
      // the only reliable failure signal — but an empty buffer means failure too.
      if (code !== 0 && buf.length === 0) return reject(new Error(mapError(err)));
      if (buf.length === 0) return reject(new Error(mapError(err)));
      resolve(buf);
    });

    if (stdin) proc.stdin.end(stdin);
  });
}

function runFfmpeg(args, { timeoutMs, stdin = null }) {
  return runProc("ffmpeg", args, {
    timeoutMs, stdin,
    missingHint: "ffmpeg is not installed — it is what captures from the camera (brew install ffmpeg)",
    mapError: cameraError
  });
}

// ffmpeg's device errors are long and buried; these are the three that actually
// happen, turned into something that names the fix.
function cameraError(stderr) {
  const modes = /Supported modes:\s*([\s\S]{0,200})/.exec(stderr);
  if (/not supported by the device/i.test(stderr) && modes) {
    const list = (stderr.match(/\d+x\d+@/g) || []).map((s) => s.replace("@", ""));
    return `the camera does not support that size. Supported: ${[...new Set(list)].join(", ") || "unknown"}`;
  }
  // Order matters: a missing device ALSO raises an I/O error, so the specific
  // cause has to be tested first or every unplugged camera is misreported as a
  // permissions problem and sends someone into System Settings for nothing.
  if (/Video device not found/i.test(stderr)) {
    return "no camera with that name is connected — check `vision.device` in config.json " +
           "(list them: ffmpeg -f avfoundation -list_devices true -i \"\"). " +
           "Erroring here is deliberate: the alternative is filming the wrong camera.";
  }
  if (/Invalid device index|No such device|does not exist/i.test(stderr)) {
    return "no camera at that index — check `vision.device` in config.json " +
           "(list them: ffmpeg -f avfoundation -list_devices true -i \"\")";
  }
  if (/Operation not permitted|not authorized|denied/i.test(stderr)) {
    return "the OS refused access to the camera. On macOS grant the terminal Camera " +
           "permission (System Settings > Privacy & Security > Camera).";
  }
  if (/Input\/output error/i.test(stderr)) {
    return "the camera could not be opened — it may be unplugged, or in use by another app " +
           "(video calls hold the device exclusively).";
  }
  return (stderr.trim().split("\n").pop() || "camera capture failed").slice(0, 200);
}

// Per-platform input flags. Only the capture layer knows about this; everything
// above deals in frames.
function inputArgs(cfg) {
  const size = `${cfg.width}x${cfg.height}`;
  if (cfg.backend === "v4l2") {
    return ["-f", "v4l2", "-video_size", size, "-i", cfg.device];
  }
  if (cfg.backend === "dshow") {
    return ["-f", "dshow", "-video_size", size, "-i", `video=${cfg.device}`];
  }
  // avfoundation (macOS). pixel_format matters: this camera offers only
  // uyvy422, and letting ffmpeg guess yuv420p makes it refuse the device.
  return [
    "-f", "avfoundation",
    ...(cfg.pixelFormat ? ["-pixel_format", cfg.pixelFormat] : []),
    "-framerate", String(cfg.framerate),
    "-video_size", size,
    "-i", String(cfg.device)
  ];
}

// ---------------------------------------------------------------------------
// The "v4l2raw" backend — MIPI cameras whose ISP path does not work.
//
// WHY THIS EXISTS: on the OrangePi 5 Max the OV13855 is detected and streams,
// but the Rockchip ISP node (/dev/video42) never emits a frame — it needs the
// rkaiq 3A daemon, which is not on this image and not in apt. It fails as
// `rkisp_stream_stop id:0 timeout` after 30s with a 0-byte file. The CIF node
// (/dev/video11) has no such dependency and hands over the sensor's raw Bayer
// immediately: a full 4224x3136 frame in 0.26s.
//
// So this path skips ffmpeg for CAPTURE and reads the sensor directly with
// v4l2-ctl. ffmpeg is still used to ENCODE (see captureJpeg) — it just never
// touches the device.
//
// The output is greyscale, which is not a compromise for the QR job: jsQR
// converts to luminance anyway, and skipping demosaic avoids inventing colour
// detail that was never sampled.
const RAW10_PIXELS_PER_GROUP = 4;    // MIPI RAW10 packs 4 pixels into 5 bytes:
const RAW10_BYTES_PER_GROUP = 5;     // 4 MSB bytes, then one byte of packed LSBs.

function rawCameraError(stderr) {
  if (/No such file or directory|Cannot open device/i.test(stderr)) {
    return "no camera at that device node — check `vision.device` in config.json " +
           "(list them: v4l2-ctl --list-devices). On the OrangePi the raw node is " +
           "the rkcif one, e.g. /dev/video11, NOT /dev/video-camera0.";
  }
  if (/Invalid argument/i.test(stderr)) {
    return "the camera rejected that size or pixel format — check vision.width/height " +
           "and vision.raw_pixel_format (list them: v4l2-ctl -d <dev> --list-formats-ext)";
  }
  if (/Device or resource busy/i.test(stderr)) {
    return "the camera is already in use by another process";
  }
  return (stderr.trim().split("\n").pop() || "raw camera capture failed").slice(0, 200);
}

// Unpack RAW10 to 8-bit greyscale, subsampling as we go.
//
// Two things make this cheap. Taking only the MSB byte of each pixel discards
// the low 2 bits, which is invisible for barcode work and means no bit-shifting
// at all. And `step` MUST be even: a Bayer mosaic repeats every 2 pixels, so an
// even stride keeps every sampled pixel on the SAME colour plane. Sample on an
// odd step and you alternate between green and red/blue sites, producing a
// checkerboard that reads as texture and defeats the QR finder patterns.
function decodeRaw10ToGray(buf, { width, height, stride, step, offset }) {
  const outW = Math.floor(width / step);
  const outH = Math.floor(height / step);
  const gray = Buffer.allocUnsafe(outW * outH);
  let o = 0;
  for (let oy = 0; oy < outH; oy++) {
    const rowBase = offset + oy * step * stride;
    for (let ox = 0; ox < outW; ox++) {
      const x = ox * step;
      gray[o++] = buf[rowBase +
        Math.floor(x / RAW10_PIXELS_PER_GROUP) * RAW10_BYTES_PER_GROUP +
        (x % RAW10_PIXELS_PER_GROUP)];
    }
  }
  return { data: gray, width: outW, height: outH };
}

async function captureRawGray(cfg) {
  const frames = cfg.rawWarmupFrames;
  const buf = await runProc("v4l2-ctl", [
    "-d", String(cfg.device),
    `--set-fmt-video=width=${cfg.width},height=${cfg.height},pixelformat=${cfg.rawPixelFormat}`,
    "--stream-mmap=3",
    "--stream-to=-",
    `--stream-count=${frames}`
  ], {
    timeoutMs: cfg.timeoutMs,
    missingHint: "v4l2-ctl is not installed — it is what reads the MIPI camera " +
                 "(sudo apt install v4l-utils)",
    mapError: rawCameraError
  });

  if (buf.length % frames !== 0) {
    throw new Error(`camera returned ${buf.length} bytes, not divisible into ${frames} frames`);
  }
  const frameBytes = buf.length / frames;

  // Derive the row stride from what actually arrived rather than trusting a
  // formula. The hardware pads rows to an alignment boundary — here 4224 pixels
  // is 5280 bytes of RAW10 but lands as 5376 — and that padding is not
  // documented anywhere we can read at runtime. Getting it wrong does not throw;
  // it shears the image diagonally and silently decodes nothing.
  const stride = cfg.rawStride || frameBytes / cfg.height;
  if (!Number.isInteger(stride)) {
    throw new Error(`frame of ${frameBytes} bytes does not divide by height ${cfg.height} — ` +
                    `set vision.raw_stride explicitly`);
  }
  const minStride = Math.ceil(cfg.width * RAW10_BYTES_PER_GROUP / RAW10_PIXELS_PER_GROUP);
  if (stride < minStride) {
    throw new Error(`stride ${stride} is too small for ${cfg.width} RAW10 pixels ` +
                    `(need at least ${minStride}) — check vision.width`);
  }

  // Keep the LAST frame: the sensor's first frame after start is often still
  // settling. Unlike the ffmpeg path this defaults to 2, not 12 — each frame
  // here is ~16 MB, so a 12-frame warmup would buffer 200 MB to throw away.
  return decodeRaw10ToGray(buf, {
    width: cfg.width,
    height: cfg.height,
    stride,
    step: cfg.rawDownsample,
    offset: buf.length - frameBytes
  });
}

function grayToRgba({ data, width, height }) {
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0, o = 0; i < data.length; i++) {
    const v = data[i];
    rgba[o++] = v; rgba[o++] = v; rgba[o++] = v; rgba[o++] = 255;
  }
  return { data: rgba, width, height };
}

// ---------------------------------------------------------------------------

// Enumerate cameras so a human (and the startup log) can see what is actually
// attached. avfoundation only — v4l2 and dshow enumerate differently, and
// guessing wrong here is worse than saying nothing.
export async function listCameras() {
  let stderr = "";
  await new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", resolve);
    p.on("close", resolve);
  });
  const cams = [];
  for (const line of stderr.split("\n")) {
    if (/audio devices/i.test(line)) break;          // video section ends here
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (m && !/AVFoundation (video|audio) devices/i.test(line)) {
      cams.push({ index: Number(m[1]), name: m[2] });
    }
  }
  return cams;
}

// Which camera will `cfg.device` actually open, and is that stable?
//
// WHY THIS EXISTS: a bare index is not an identity. Unplug a USB webcam and
// index 1 becomes whatever now sits in that slot — on a MacBook, the built-in
// camera. A config that quietly starts filming a different camera than intended
// is a privacy problem, not a bug report, so this resolves the name up front and
// says so at startup.
export async function describeDevice(cfg) {
  if (cfg.backend !== "avfoundation") {
    return { name: String(cfg.device), byIndex: false, warning: null };
  }
  const cams = await listCameras();
  const isIndex = /^\d+$/.test(String(cfg.device));
  if (!isIndex) {
    const hit = cams.find((c) => c.name === cfg.device);
    return {
      name: cfg.device,
      byIndex: false,
      warning: hit ? null : `no camera named "${cfg.device}" is connected right now`
    };
  }
  const hit = cams.find((c) => c.index === Number(cfg.device));
  return {
    name: hit ? hit.name : `(index ${cfg.device}, not currently present)`,
    byIndex: true,
    warning: `vision.device is the index "${cfg.device}", which is not a stable identifier — ` +
             `it changes when cameras are plugged or unplugged. ` +
             (hit ? `Use "${hit.name}" instead.` : `Use the camera's name instead.`)
  };
}

// A frame as raw RGBA — the shape jsQR consumes directly.
export async function captureRgba(cfg) {
  // The raw path already produces exactly one settled frame; there is no ffmpeg
  // stream to slice up, so it returns straight away.
  if (cfg.backend === "v4l2raw") return grayToRgba(await captureRawGray(cfg));

  const frames = cfg.warmupFrames ?? DEFAULT_WARMUP;
  const buf = await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    ...inputArgs(cfg),
    "-frames:v", String(frames),
    "-fps_mode", "passthrough",
    "-pix_fmt", "rgba", "-f", "rawvideo", "-"
  ], { timeoutMs: cfg.timeoutMs });

  const frameBytes = cfg.width * cfg.height * 4;
  if (buf.length < frameBytes) {
    throw new Error(`camera returned ${buf.length} bytes, expected at least ${frameBytes} ` +
                    `for one ${cfg.width}x${cfg.height} frame`);
  }
  // The stream must divide evenly into frames of the size we asked for. If it
  // does not, the device handed back a DIFFERENT resolution than configured —
  // avfoundation rejects a bad size outright, but v4l2 and dshow will happily
  // substitute their own. Slicing on the wrong stride then yields a frame that
  // looks fine to every type check and decodes nothing, forever. Fail loudly.
  if (buf.length % frameBytes !== 0) {
    throw new Error(
      `camera did not return ${cfg.width}x${cfg.height} frames (got ${buf.length} bytes, ` +
      `not a multiple of ${frameBytes}). Set vision.width/height to a size the device ` +
      `actually supports.`);
  }
  // Keep the LAST complete frame — the warmed-up one.
  const start = buf.length - frameBytes;
  return { data: buf.subarray(start, start + frameBytes), width: cfg.width, height: cfg.height };
}

// A frame as JPEG, for handing to a model that can actually look at it.
export async function captureJpeg(cfg) {
  // Raw path: ffmpeg still encodes, it just never opens the device. Feeding it
  // the already-decoded greyscale keeps one JPEG encoder for both backends
  // rather than hand-rolling a second one.
  if (cfg.backend === "v4l2raw") {
    const gray = await captureRawGray(cfg);
    return await runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "gray",
      "-s", `${gray.width}x${gray.height}`, "-i", "-",
      "-q:v", String(cfg.jpegQuality ?? 4),
      "-frames:v", "1", "-f", "image2", "-"
    ], { timeoutMs: cfg.timeoutMs, stdin: gray.data });
  }

  return await runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    ...inputArgs(cfg),
    "-frames:v", String(cfg.warmupFrames ?? DEFAULT_WARMUP),
    "-fps_mode", "passthrough",
    "-q:v", String(cfg.jpegQuality ?? 4),
    "-update", "1", "-f", "image2", "-"
  ], { timeoutMs: cfg.timeoutMs });
}

// Decode any QR in an RGBA frame. Returns null when there is none — an absent
// code is a normal outcome (nobody is holding one up yet), not an error.
export function decodeQr(frame) {
  const res = jsQR(new Uint8ClampedArray(frame.data), frame.width, frame.height, {
    inversionAttempts: "attemptBoth"   // handles light-on-dark codes, e.g. on a screen
  });
  if (!res || !res.data) return null;
  return {
    text: res.data,
    // Where it was, so a caller can tell "held up to the camera" from
    // "happened to be on a poster in the background".
    corners: res.location
      ? {
          topLeft: res.location.topLeftCorner,
          topRight: res.location.topRightCorner,
          bottomLeft: res.location.bottomLeftCorner,
          bottomRight: res.location.bottomRightCorner
        }
      : null
  };
}

// Capture and decode, retrying across a few frames. One frame is a coin flip
// when someone is holding a code by hand — it moves, it blurs, it catches glare.
export async function scanQr(cfg, { attempts = 3 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const found = decodeQr(await captureRgba(cfg));
      if (found) return found;
    } catch (err) {
      lastErr = err;      // a transient device-busy error should not end the scan
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

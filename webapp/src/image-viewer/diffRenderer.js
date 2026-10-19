// Renders the difference of what two viewers display, on the GPU.
//
// All the viewers of the page share one WebGL context: browsers keep only ~16 per page. We draw there, and copy the
// result to each viewer's canvas. Without WebGL (or with images too large for the GPU) we compute it on the CPU,
// with the same functions as the values under the pointer (metrics.js).

import { colormap } from './colormaps';
import { CONTEXT_BELOW, normalizeDiff, renderDiff as renderDiffOnCpu } from './metrics';

const METHODS = { absolute: 0, signed: 1, perceptual: 2, deltaE: 3, exact: 4 };

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2(position.x + 1.0, 1.0 - position.y) / 2.0;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// Keep in sync with metrics.js
const FRAGMENT = `
precision highp float;
uniform sampler2D a;
uniform sampler2D b;
uniform sampler2D luts;
uniform int method;
uniform float gain;
uniform float maximum;
varying vec2 uv;

const float CONTEXT_BELOW = ${CONTEXT_BELOW.toFixed(4)};

// 0-255, transparent pixels over white
vec3 opaque(vec4 c) { return 255.0 + (c.rgb * 255.0 - 255.0) * c.a; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 context(vec3 c) { return vec3((255.0 + (luma(c) - 255.0) * 0.1) / 255.0); }
// row 0: inferno, reversed. row 1: diverging
vec3 heat(float amount) {
  float i = floor(255.0 * (1.0 - min(amount, 1.0)) + 0.5);
  return texture2D(luts, vec2((i + 0.5) / 256.0, 0.25)).rgb;
}
vec3 diverging(float amount) {
  float i = floor(255.0 * (0.5 + 0.5 * amount) + 0.5);
  return texture2D(luts, vec2((i + 0.5) / 256.0, 0.75)).rgb;
}

float yiq(vec3 c1, vec3 c2) {
  vec3 d = c1 - c2;
  float y = dot(d, vec3(0.29889531, 0.58662247, 0.11448223));
  float i = dot(d, vec3(0.59597799, -0.27417610, -0.32180189));
  float q = dot(d, vec3(0.21147017, -0.52261711, 0.31114694));
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

float linear(float c) {
  c /= 255.0;
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
float lab_f(float t) { return t > 216.0 / 24389.0 ? pow(t, 1.0 / 3.0) : (24389.0 / 27.0 * t + 16.0) / 116.0; }
vec3 lab(vec3 c) {
  vec3 l = vec3(linear(c.r), linear(c.g), linear(c.b));
  float fx = lab_f(dot(l, vec3(0.4124564, 0.3575761, 0.1804375)) / 0.95047);
  float fy = lab_f(dot(l, vec3(0.2126729, 0.7151522, 0.0721750)));
  float fz = lab_f(dot(l, vec3(0.0193339, 0.1191920, 0.9503041)) / 1.08883);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
float hue(float b, float ap) {
  if (b == 0.0 && ap == 0.0) return 0.0;
  float h = degrees(atan(b, ap));
  return h < 0.0 ? h + 360.0 : h;
}
float deltaE2000(vec3 l1, vec3 l2) {
  float C_mean = (length(l1.yz) + length(l2.yz)) / 2.0;
  float C7 = pow(C_mean, 7.0);
  float G = 0.5 * (1.0 - sqrt(C7 / (C7 + 6103515625.0)));
  float a1p = (1.0 + G) * l1.y;
  float a2p = (1.0 + G) * l2.y;
  float C1p = length(vec2(a1p, l1.z));
  float C2p = length(vec2(a2p, l2.z));
  float h1p = hue(l1.z, a1p);
  float h2p = hue(l2.z, a2p);
  float dLp = l2.x - l1.x;
  float dCp = C2p - C1p;
  float dhp = 0.0;
  if (C1p * C2p != 0.0) {
    dhp = h2p - h1p;
    if (dhp > 180.0) dhp -= 360.0;
    else if (dhp < -180.0) dhp += 360.0;
  }
  float dHp = 2.0 * sqrt(C1p * C2p) * sin(radians(dhp / 2.0));
  float Lp_mean = (l1.x + l2.x) / 2.0;
  float Cp_mean = (C1p + C2p) / 2.0;
  float hp_mean = h1p + h2p;
  if (C1p * C2p != 0.0) {
    if (abs(h1p - h2p) <= 180.0) hp_mean /= 2.0;
    else hp_mean = (h1p + h2p < 360.0) ? (h1p + h2p + 360.0) / 2.0 : (h1p + h2p - 360.0) / 2.0;
  }
  float T = 1.0 - 0.17 * cos(radians(hp_mean - 30.0)) + 0.24 * cos(radians(2.0 * hp_mean))
    + 0.32 * cos(radians(3.0 * hp_mean + 6.0)) - 0.20 * cos(radians(4.0 * hp_mean - 63.0));
  float k = (hp_mean - 275.0) / 25.0;
  float d_theta = 30.0 * exp(-k * k);
  float Cp7 = pow(Cp_mean, 7.0);
  float R_C = 2.0 * sqrt(Cp7 / (Cp7 + 6103515625.0));
  float L50 = (Lp_mean - 50.0) * (Lp_mean - 50.0);
  float S_L = 1.0 + 0.015 * L50 / sqrt(20.0 + L50);
  float S_C = 1.0 + 0.045 * Cp_mean;
  float S_H = 1.0 + 0.015 * Cp_mean * T;
  float R_T = -sin(radians(2.0 * d_theta)) * R_C;
  float tl = dLp / S_L;
  float tc = dCp / S_C;
  float th = dHp / S_H;
  return sqrt(max(0.0, tl * tl + tc * tc + th * th + R_T * tc * th));
}

void main() {
  vec3 ca = opaque(texture2D(a, uv));
  vec3 cb = opaque(texture2D(b, uv));
  vec3 color;
  if (method == 0) {
    color = min(abs(ca - cb) * gain, vec3(255.0)) / 255.0;
  } else if (method == 1) {
    float amount = clamp((luma(ca) - luma(cb)) * gain / 255.0, -1.0, 1.0);
    color = abs(amount) < CONTEXT_BELOW / 2.0 ? context(ca) : diverging(amount);
  } else if (method == 2) {
    float amount = sqrt(yiq(ca, cb) / 35215.0) / maximum;
    color = amount < CONTEXT_BELOW ? context(ca) : heat(amount);
  } else if (method == 3) {
    float amount = deltaE2000(lab(ca), lab(cb)) / maximum;
    color = amount < CONTEXT_BELOW ? context(ca) : heat(amount);
  } else {
    color = any(greaterThan(abs(ca - cb), vec3(0.5))) ? vec3(230.0, 30.0, 30.0) / 255.0 : context(ca);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

const compile = (gl, type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader error');
  return shader;
};

let shared = null;
let gpu_failed = false;

const setup = () => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, depth: false });
  if (!gl) throw new Error('No WebGL');
  const program = gl.createProgram();
  [compile(gl, gl.VERTEX_SHADER, VERTEX), compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)].forEach(shader => gl.attachShader(program, shader));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = unit => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    // any size, not only powers of 2, and the actual pixels
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  };
  const textures = [texture(0), texture(1)];
  texture(2);
  const luts = new Uint8Array(256 * 2 * 4);
  [colormap('inferno'), colormap('diverging')].forEach((lut, row) => {
    for (let i = 0; i < 256; i++) {
      luts.set([lut[3 * i], lut[3 * i + 1], lut[3 * i + 2], 255], 4 * (256 * row + i));
    }
  });
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, luts);

  const uniform = name => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform('a'), 0);
  gl.uniform1i(uniform('b'), 1);
  gl.uniform1i(uniform('luts'), 2);
  const state = {
    canvas,
    gl,
    textures,
    method: uniform('method'),
    gain: uniform('gain'),
    maximum: uniform('maximum'),
    max_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    lost: false,
  };
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    state.lost = true;
    if (shared === state) shared = null;
  });
  return state;
};

const renderOnGpu = (target, a, b, diff, width, height) => {
  if (gpu_failed) return false;
  if (!shared) {
    try {
      shared = setup();
    } catch (error) {
      console.warn(`The image viewer computes the difference on the CPU: ${error.message}`);
      gpu_failed = true;
      return false;
    }
  }
  const { canvas, gl, textures, max_size } = shared;
  if (width > max_size || height > max_size) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  [a, b].forEach((source, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  });
  const { method, gain = 1, max = 1 } = normalizeDiff(diff);
  gl.uniform1i(shared.method, METHODS[method]);
  gl.uniform1f(shared.gain, gain);
  gl.uniform1f(shared.maximum, max);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // the drawing buffer is still there until we return to the event loop
  const context = target.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.drawImage(canvas, 0, 0);
  return true;
};

const cors_message = "Can't compute the difference: the server doesn't allow reading the pixels (CORS headers).";

// The size of what a source shows: a canvas, or a <video> (its frame)
const sizeOf = source => typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement
  ? { width: source.videoWidth, height: source.videoHeight }
  : { width: source.width, height: source.height };

// The pixels of a source, at width x height: a canvas' are read as they are, others (videos) are drawn at that size
const pixelsOf = (source, width, height) => {
  if (typeof source.getContext === 'function') return source.getContext('2d').getImageData(0, 0, width, height).data;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
};

// Draws the difference of two canvases of the same size (what two viewers display) into `target`, resized to them.
// They can be <video> elements too: their current frames, compared at the same relative positions when their sizes differ.
// Throws an Error users can read, e.g. when the image server doesn't send CORS headers.
export const renderDiff = (target, a, b, diff) => {
  const size_a = sizeOf(a);
  const size_b = sizeOf(b);
  const width = Math.min(size_a.width, size_b.width);
  const height = Math.min(size_a.height, size_b.height);
  if (!width || !height) return;
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  try {
    if (renderOnGpu(target, a, b, diff, width, height)) return;
    const context = target.getContext('2d');
    const out = context.createImageData(width, height);
    renderDiffOnCpu(pixelsOf(a, width, height), pixelsOf(b, width, height), out.data, diff);
    context.putImageData(out, 0, 0);
  } catch (error) {
    if (error?.name === 'SecurityError') throw new Error(cors_message);
    throw error;
  }
};

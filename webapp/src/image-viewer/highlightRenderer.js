// Highlights the pixels a viewer displays within a range of values, on the GPU (see histogram.js).
//
// Like the difference (diffRenderer.js), all the viewers of the page share one WebGL context: we draw there, and copy
// the result to each viewer's canvas. Without WebGL (or with images too large for the GPU) we compute it on the CPU.

import { HIGHLIGHT, renderHighlight } from './histogram';

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2(position.x + 1.0, 1.0 - position.y) / 2.0;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const vec4 = ([r, g, b, a]) => `vec4(${(r / 255).toFixed(4)}, ${(g / 255).toFixed(4)}, ${(b / 255).toFixed(4)}, ${a.toFixed(4)})`;

// Keep in sync with renderHighlight in histogram.js
const FRAGMENT = `
precision highp float;
uniform sampler2D image;
uniform float lo;
uniform float hi;
uniform vec4 channels;
uniform float period;
uniform float height;
varying vec2 uv;
void main() {
  vec4 c = texture2D(image, uv);
  if (c.a == 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 rgb = floor(c.rgb * 255.0 + 0.5);
  vec4 values = vec4(rgb, floor(dot(rgb, vec3(0.299, 0.587, 0.114)) + 0.5));
  // 1 for the channels out of the range
  vec4 out_of_range = (step(values, vec4(lo - 0.5)) + step(vec4(hi + 0.5), values)) * channels;
  if (dot(out_of_range, vec4(1.0)) > 0.0) {
    gl_FragColor = ${vec4(HIGHLIGHT.dimmed)};
    return;
  }
  // from the top left, like the canvas' rows
  vec2 pixel = floor(vec2(gl_FragCoord.x, height - gl_FragCoord.y));
  gl_FragColor = fract((pixel.x + pixel.y) / period) < 0.5 ? ${vec4(HIGHLIGHT.light)} : ${vec4(HIGHLIGHT.dark)};
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

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  // any size, not only powers of 2, and the actual pixels
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const uniform = name => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform('image'), 0);
  const state = {
    canvas,
    gl,
    lo: uniform('lo'),
    hi: uniform('hi'),
    channels: uniform('channels'),
    period: uniform('period'),
    height: uniform('height'),
    max_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    if (shared === state) shared = null;
  });
  return state;
};

const renderOnGpu = (target, source, highlight, ratio) => {
  if (gpu_failed) return false;
  if (!shared) {
    try {
      shared = setup();
    } catch (error) {
      console.warn(`The image viewer highlights the values on the CPU: ${error.message}`);
      gpu_failed = true;
      return false;
    }
  }
  const { canvas, gl, max_size } = shared;
  const { width, height } = source;
  if (width > max_size || height > max_size) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.uniform1f(shared.lo, highlight.lo);
  gl.uniform1f(shared.hi, highlight.hi);
  gl.uniform4fv(shared.channels, highlight.channels.map(Number));
  gl.uniform1f(shared.period, HIGHLIGHT.period * ratio);
  gl.uniform1f(shared.height, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // the drawing buffer is still there until we return to the event loop
  const context = target.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.drawImage(canvas, 0, 0);
  return true;
};

// Draws the highlight of what a viewer displays (its canvas) into `target`, resized to it.
// Throws a SecurityError when the image server doesn't send CORS headers.
export const drawHighlight = (target, source, highlight, ratio = 1) => {
  const { width, height } = source;
  if (!width || !height) return;
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  if (renderOnGpu(target, source, highlight, ratio)) return;
  const context = target.getContext('2d');
  const data = source.getContext('2d').getImageData(0, 0, width, height).data;
  const out = context.createImageData(width, height);
  renderHighlight(data, out.data, width, highlight, ratio);
  context.putImageData(out, 0, 0);
};

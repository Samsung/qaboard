import { useEffect, useRef } from 'react';

// |new - reference| per channel, amplified, computed on the GPU for every frame.
// Videos of different resolutions are compared at the same relative position.
// Browsers keep ~16 WebGL contexts per page: mount it only when it's visible, it releases its context when unmounted.

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2(position.x + 1.0, 1.0 - position.y) / 2.0;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D a;
uniform sampler2D b;
uniform float gain;
varying vec2 uv;
void main() {
  vec3 difference = abs(texture2D(a, uv).rgb - texture2D(b, uv).rgb) * gain;
  gl_FragColor = vec4(min(difference, vec3(1.0)), 1.0);
}`;

const HAVE_CURRENT_DATA = 2;

const compile = (gl, type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
};

const setupGl = (gl) => {
  const program = gl.createProgram();
  const shaders = [compile(gl, gl.VERTEX_SHADER, VERTEX), compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)];
  shaders.forEach(shader => gl.attachShader(program, shader));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const textures = [0, 1].map(unit => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // any size (not only powers of 2), and we want to see actual pixels
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  });
  gl.uniform1i(gl.getUniformLocation(program, 'a'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'b'), 1);
  const gain = gl.getUniformLocation(program, 'gain');
  const release = () => {
    textures.forEach(texture => gl.deleteTexture(texture));
    gl.deleteBuffer(buffer);
    shaders.forEach(shader => gl.deleteShader(shader));
    gl.deleteProgram(program);
  };
  return { textures, gain, release };
};

// The canvas is sized like the videos: the parent zooms it like them. Errors go to onError.
// Mount a new one (`key`) for other videos: the canvas' context is released on unmount.
export const DiffLayer = ({ a, b, gain, controller, canvasRef, onError, className, style }) => {
  const canvas = useRef(null);
  const draw = useRef(() => {});
  const gainRef = useRef(gain);
  const errorRef = useRef(onError);
  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const element = canvas.current;
    if (canvasRef) canvasRef.current = element;
    const setError = message => errorRef.current?.(message);
    if (!element || !a || !b) return;
    let gl = null;
    try {
      gl = element.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    } catch {
      // handled below
    }
    if (!gl) {
      setError('Your browser can\'t compute the difference: it needs WebGL.');
      return;
    }
    let resources;
    try {
      resources = setupGl(gl);
    } catch (e) {
      setError(`Can't compute the difference: ${e.message}`);
      return;
    }
    setError(null);
    const onLost = () => {
      draw.current = () => {};
      setError('The browser released the difference\'s GPU memory: too many are shown. Scroll it out of sight and back.');
    };
    element.addEventListener('webglcontextlost', onLost);
    draw.current = () => {
      if (a.readyState < HAVE_CURRENT_DATA || b.readyState < HAVE_CURRENT_DATA || !a.videoWidth) return;
      if (element.width !== a.videoWidth || element.height !== a.videoHeight) {
        element.width = a.videoWidth;
        element.height = a.videoHeight;
      }
      gl.viewport(0, 0, element.width, element.height);
      try {
        [a, b].forEach((video, unit) => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, resources.textures[unit]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        });
      } catch (e) {
        draw.current = () => {};
        setError(e.name === 'SecurityError'
          ? 'Can\'t compute the difference: the videos are served from another website, without CORS headers.'
          : `Can't compute the difference: ${e.message}`);
        return;
      }
      gl.uniform1f(resources.gain, gainRef.current);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    draw.current();
    const stop = controller.onFrames(() => draw.current());
    const redraw = () => draw.current();
    [a, b].forEach(video => video.addEventListener('loadeddata', redraw));
    return () => {
      stop();
      [a, b].forEach(video => video.removeEventListener('loadeddata', redraw));
      draw.current = () => {};
      element.removeEventListener('webglcontextlost', onLost);
      resources.release();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [a, b, controller, canvasRef]);

  useEffect(() => {
    gainRef.current = gain;
    draw.current();
  }, [gain]);

  return <canvas ref={canvas} className={className} style={style} />;
};

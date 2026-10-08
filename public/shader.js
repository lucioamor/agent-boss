// Background shader for the board. Low-contrast noise field behind translucent panels.
// It is still by default: it only animates for a few seconds after a REAL state change
// (task/phase/handoff/verification events arriving live), then stops drawing entirely.
// With prefers-reduced-motion it draws a single static frame and never animates.
'use strict';

(() => {
  const canvas = document.getElementById('bg');
  const gl = canvas && canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  const stats = { webgl: !!gl, frames: 0, animFrames: 0, pulses: 0, reducedMotion: false, lastReason: null };
  window.__bg = stats;
  if (!gl) return; // plain CSS background stays

  const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
  const FRAG = `
    precision mediump float;
    uniform vec2 res;
    uniform float t;
    uniform float energy;
    uniform vec3 base;
    uniform vec3 tint;
    uniform float lightTheme;
    float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int k = 0; k < 4; k++) { v += a * n(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / res.y;
      float slow = t * 0.035;
      float f = fbm(uv * 2.2 + vec2(slow, -slow * 0.7) + fbm(uv * 1.3 - slow) * 0.8);
      // Very low amplitude so text contrast is unaffected; a live event briefly lifts it.
      float amp = 0.035 + 0.05 * energy;
      float glow = smoothstep(0.35, 0.95, f);
      vec3 col = base + (tint - base) * glow * amp * 4.0;
      col += (f - 0.5) * 0.025 * (1.0 - 2.0 * lightTheme);
      gl_FragColor = vec4(col, 1.0);
    }`;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    stats.webgl = false;
    stats.error = String(err);
    return;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = Object.fromEntries(['res', 't', 'energy', 'base', 'tint', 'lightTheme'].map((k) => [k, gl.getUniformLocation(prog, k)]));

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = (hex) => {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex) || [0, '0c', '0e', '12'];
    return [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  };
  const TONES = { good: '--ok', warn: '--warn', bad: '--bad', info: '--accent', ext: '--ext' };

  let simTime = 0; // advances only while animating, so the still frame never jumps
  let energy = 0;
  let tint = '--accent';
  let raf = 0;
  let last = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  stats.reducedMotion = reduce.matches;

  function resize() {
    const scale = 0.5; // half resolution: it's a blurry field anyway
    const w = Math.max(1, Math.floor(innerWidth * scale));
    const h = Math.max(1, Math.floor(innerHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw() {
    resize();
    const light = matchMedia('(prefers-color-scheme: light)').matches && document.documentElement.dataset.theme !== 'dark';
    gl.uniform2f(U.res, canvas.width, canvas.height);
    gl.uniform1f(U.t, simTime);
    gl.uniform1f(U.energy, energy);
    gl.uniform3fv(U.base, rgb(css('--bg')));
    gl.uniform3fv(U.tint, rgb(css(tint)));
    gl.uniform1f(U.lightTheme, light ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    stats.frames++;
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    stats.animFrames++;
    simTime += dt * (0.6 + 2.5 * energy);
    energy *= Math.pow(0.35, dt); // ~3 s to settle
    draw();
    if (energy > 0.02 && !document.hidden) raf = requestAnimationFrame(loop);
    else {
      energy = 0;
      raf = 0;
      last = 0;
      draw(); // final still frame
    }
  }

  function pulse(tone, reason) {
    stats.lastReason = reason;
    tint = TONES[tone] || '--accent';
    if (stats.reducedMotion) return draw(); // recolor the still frame, no motion
    stats.pulses++;
    energy = Math.min(1, energy + 0.8);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // Only real state changes, and only ones that happen after the page loaded (not the replay).
  const loadedAt = Date.now();
  const SIGNIFICANT = {
    'task.status': 'info', 'session.phase': 'info', 'handoff.started': 'warn', 'handoff.validated': 'good',
    'handoff.rejected': 'bad', 'verify.finished': null, 'supervisor.recovered': 'bad', 'task.paused': 'warn',
    'task.resumed': 'info', 'constraint.learned': 'warn', 'external.session': 'ext',
  };
  window.addEventListener('supervisor-event', (e) => {
    const ev = e.detail;
    if (!(ev.type in SIGNIFICANT) || Date.parse(ev.ts) <= loadedAt) return;
    const tone = ev.type === 'verify.finished' ? (ev.data?.ok ? 'good' : 'bad') : SIGNIFICANT[ev.type];
    pulse(tone, ev.type);
  });

  const setReduced = (on) => {
    stats.reducedMotion = on;
    if (on && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      energy = 0;
    }
    draw();
  };
  reduce.addEventListener('change', (e) => setReduced(e.matches));
  stats.setReducedMotion = setReduced; // test hook, same path as the media query listener
  addEventListener('resize', () => !raf && draw());
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => !raf && draw());
  draw();
})();

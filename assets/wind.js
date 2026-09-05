/* Gentle wind over the meadow photo. Draws assets/meadow.webp into a
   full-screen WebGL canvas with the same "center / cover" mapping as the CSS
   background, then displaces only the grass with a slow, drifting noise field.
   Sky and horizon stay put; the far grass barely moves; the near grass sways
   a few pixels. Skips itself under prefers-reduced-motion or without WebGL,
   leaving the static CSS background in place. */
(function () {
  var canvas = document.getElementById("bg-wind");
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) return;

  var VERT =
    "attribute vec2 p;" +
    "varying vec2 v;" +
    "void main(){v=p*0.5+0.5;v.y=1.0-v.y;gl_Position=vec4(p,0.0,1.0);}";

  // Two-octave value noise is enough: the grass is textured already, the
  // noise only has to move it, not draw it.
  var FRAG =
    "precision mediump float;" +
    "varying vec2 v;" +
    "uniform sampler2D img;" +
    "uniform vec2 off;" +      // top-left of the covered image, in canvas px
    "uniform vec2 size;" +     // drawn image size, in canvas px
    "uniform vec2 res;" +      // canvas size, in px
    "uniform float t;" +
    "uniform float amp;" +     // max displacement, in canvas px
    "float hash(vec2 q){return fract(sin(dot(q,vec2(127.1,311.7)))*43758.5453);}" +
    "float noise(vec2 q){vec2 i=floor(q);vec2 f=fract(q);f=f*f*(3.0-2.0*f);" +
    " return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}" +
    "float fbm(vec2 q){return noise(q)*0.65+noise(q*2.3+7.1)*0.35;}" +
    "void main(){" +
    " vec2 px=v*res;" +
    " vec2 uv=(px-off)/size;" +
    // Horizon of meadow.webp sits at ~0.64 of its height. Ramp the wind in
    // below it so the horizon line itself never wobbles.
    " float g=smoothstep(0.66,0.90,uv.y);" +
    // Gusts: a broad slow wave travelling left-to-right, so the whole field
    // breathes instead of shimmering uniformly.
    " float gust=0.55+0.45*sin(uv.x*4.0-t*0.55+sin(uv.y*6.0+t*0.3));" +
    " vec2 q=vec2(uv.x*5.0-t*0.32,uv.y*9.0-t*0.06);" +
    " float nx=fbm(q)-0.5;" +
    " float ny=fbm(q+vec2(3.7,9.2))-0.5;" +
    " vec2 d=vec2(nx,ny*0.35)*amp*g*gust;" +
    " vec2 suv=(px+d-off)/size;" +
    " vec4 c=texture2D(img,clamp(suv,0.0,1.0));" +
    // A touch of wind glint: leaning blades catch a little more light.
    " c.rgb*=1.0+0.045*nx*g*gust;" +
    " gl_FragColor=vec4(c.rgb,1.0);" +
    "}";

  function shader(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  }
  var vs = shader(gl.VERTEX_SHADER, VERT);
  var fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );
  var loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var u = {
    off: gl.getUniformLocation(prog, "off"),
    size: gl.getUniformLocation(prog, "size"),
    res: gl.getUniformLocation(prog, "res"),
    t: gl.getUniformLocation(prog, "t"),
    amp: gl.getUniformLocation(prog, "amp"),
  };

  var img = new Image();
  var ready = false;
  var W = 0, H = 0, dpr = 1;

  function resize() {
    // Cap the pixel ratio: the effect is soft, 1.5x is plenty and keeps
    // phones cool.
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.round(window.innerWidth * dpr);
    var h = Math.round(window.innerHeight * dpr);
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W;
    canvas.height = H;
    gl.viewport(0, 0, W, H);
    // Same math as CSS "center / cover".
    var s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    gl.uniform2f(u.off, (W - dw) / 2, (H - dh) / 2);
    gl.uniform2f(u.size, dw, dh);
    gl.uniform2f(u.res, W, H);
    gl.uniform1f(u.amp, 7 * dpr);
  }

  var last = 0;
  var start = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    // ~30 fps is invisible for motion this slow and halves the GPU work.
    if (now - last < 31) return;
    last = now;
    if (!start) start = now;
    resize();
    gl.uniform1f(u.t, (now - start) / 1000);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!ready) {
      ready = true;
      canvas.classList.add("on");
    }
  }

  img.onload = function () {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.disable(gl.BLEND);
    requestAnimationFrame(frame);
  };
  img.onerror = function () {};
  img.src = "assets/meadow.webp";
})();

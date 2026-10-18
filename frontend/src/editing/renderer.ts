import type { ExportEnhanceSettings } from "../types";
import { geometry, presets } from "./recipe";

export interface EditingBase {
  width: number;
  height: number;
  pixels: Float32Array;
  sourceWidth?: number;
  sourceHeight?: number;
}
export async function loadEditingBase(
  photoId: string,
  signal: AbortSignal,
): Promise<EditingBase> {
  const response = await fetch(
    `/api/photos/${encodeURIComponent(photoId)}/editing-base`,
    { signal },
  );
  if (!response.ok)
    throw new Error(
      (await response.json()).error || "Unable to develop RAW preview",
    );
  const width = Number(response.headers.get("X-Image-Width")),
    height = Number(response.headers.get("X-Image-Height"));
  const pixels = new Float32Array(await response.arrayBuffer());
  if (!width || !height || pixels.length !== width * height * 3)
    throw new Error("Invalid editing image");
  return {
    width,
    height,
    pixels,
    sourceWidth: Number(response.headers.get("X-Source-Width")) || width,
    sourceHeight: Number(response.headers.get("X-Source-Height")) || height,
  };
}

const vertex = `attribute vec2 aPosition; varying vec2 vUv;
void main(){ vUv=vec2(aPosition.x*.5+.5,.5-aPosition.y*.5); gl_Position=vec4(aPosition,0.,1.); }`;
// Shared by both passes: output-to-source mapping, the gradient mask and the clipping/mask overlays.
const finishing = `precision highp float;
varying vec2 vUv;
uniform vec2 uSource; uniform vec2 uOutput; uniform vec2 uCenter; uniform vec2 uRotation;
uniform bool uOriginal; uniform bool uClipping; uniform bool uMaskOverlay;
uniform vec4 uGradientPoints; uniform float uGradientFeather; uniform bool uGradientEnabled; uniform bool uGradientInvert;
float gradientWeight(vec2 uv) {
  vec2 d=uGradientPoints.zw-uGradientPoints.xy;
  float t=dot(uv-uGradientPoints.xy,d)/max(dot(d,d),.000001);
  float weight=1.-smoothstep(0.,1.,(t-.5)/uGradientFeather+.5);
  return uGradientInvert ? 1.-weight : weight;
}
vec2 rotate(vec2 p){ return vec2(uRotation.x*p.x-uRotation.y*p.y,uRotation.y*p.x+uRotation.x*p.y); }
vec2 sourceUv(){ return (uCenter+rotate((vUv-.5)*uOutput))/uSource; }
vec3 finish(vec3 c, vec2 uv){
  if(uOriginal) return c;
  if(uClipping){ if(max(max(c.r,c.g),c.b)>=.999) c=vec3(1.,.15,.12); else if(min(min(c.r,c.g),c.b)<=.001) c=vec3(.1,.35,1.); }
  if(uMaskOverlay && uGradientEnabled) c=mix(c,vec3(1.,.25,.15),gradientWeight(uv)*.4);
  return c;
}
`;
// Pass 1: develop each pixel. Sharpening needs its neighbours, so it is a second pass over this
// result: evaluating the whole pipeline nine times per pixel in one shader made the program so
// large that Direct3D's compiler (ANGLE on Windows) could stall the GPU and black out the window.
const fragment = `${finishing}
uniform sampler2D uImage; uniform bool uFinish;
uniform vec4 uLight; uniform vec4 uColor; uniform vec3 uTone;
uniform vec4 uStyleLight; uniform vec4 uStyleColor; uniform vec3 uStyleTone;
uniform float uPalette; uniform vec3 uGradientControls;
uniform bool uSelectedEnabled; uniform vec2 uSelectedBand; uniform vec3 uSelectedControls;
vec3 selectedColor(vec3 rgb) {
  float high=max(max(rgb.r,rgb.g),rgb.b), low=min(min(rgb.r,rgb.g),rgb.b), d=high-low;
  float h=(high==rgb.r ? (rgb.g-rgb.b)/max(d,.000001) : high==rgb.g ? 2.+(rgb.b-rgb.r)/max(d,.000001) : 4.+(rgb.r-rgb.g)/max(d,.000001))/6.;
  h=fract(h); float light=(high+low)*.5;
  float saturation=d/max(1.-abs(2.*light-1.),.000001);
  float distance=abs(fract(h-uSelectedBand.x+.5)-.5);
  float weight=(1.-smoothstep(.5,1.,distance/uSelectedBand.y))*smoothstep(0.,.08,d);
  if(weight<=0.) return rgb;
  h=fract(h+uSelectedControls.x*weight/6.);
  saturation=clamp(saturation*(1.+uSelectedControls.y*weight),0.,1.);
  light=clamp(light+uSelectedControls.z*weight*.25,0.,1.);
  float c=(1.-abs(2.*light-1.))*saturation, x=c*(1.-abs(mod(h*6.,2.)-1.));
  vec3 outColor=h<1./6. ? vec3(c,x,0.) : h<2./6. ? vec3(x,c,0.) : h<3./6. ? vec3(0.,c,x) : h<4./6. ? vec3(0.,x,c) : h<5./6. ? vec3(x,0.,c) : vec3(c,0.,x);
  return outColor+light-c*.5;
}
vec3 linearize(vec3 c){ return mix(c/12.92,pow((max(c,0.)+.055)/1.055,vec3(2.4)),step(vec3(.04045),c)); }
vec3 encode(vec3 c){ return mix(c*12.92,1.055*pow(max(c,0.),vec3(1./2.4))-.055,step(vec3(.0031308),c)); }
vec3 adjust(vec3 outColor, vec4 l, vec4 k, vec3 t) {
  if(l.x!=0. || k.z!=0. || k.w!=0.) outColor=encode(linearize(outColor)*pow(2.,l.x)*pow(vec3(2.),vec3(k.z*.28,-k.w*.20,-k.z*.28)));
  float y=dot(outColor,vec3(.2126,.7152,.0722));
  float shadow=pow(1.-clamp(y,0.,1.),3.), high=pow(clamp(y,0.,1.),3.);
  float delta=(l.w*shadow+l.z*high)*.30+l.y*(.20*shadow-.12*high+.05*sin(clamp(y,0.,1.)*3.141592653589793));
  outColor+=delta;
  outColor=(outColor-.5)*(1.+t.x*.65)+.5;
  outColor=(outColor-t.y*.12)/max(.1,1.-t.y*.12);
  outColor=(outColor-t.z*.06)*(1.+t.z*.12);
  float gray=dot(outColor,vec3(.2126,.7152,.0722));
  float sat=max(max(outColor.r,outColor.g),outColor.b)-min(min(outColor.r,outColor.g),outColor.b);
  float factor=(1.+k.x)*(1.+k.y*(1.-clamp(sat*1.5,0.,1.)));
  return clamp(vec3(gray)+(outColor-vec3(gray))*factor,0.,1.);
}
vec3 processed(vec2 uv) {
  vec3 src=texture2D(uImage,uv).rgb;
  if(uOriginal) return src;
  vec3 base=adjust(src,uLight,uColor,uTone);
  base=mix(base,adjust(base,uStyleLight,uStyleColor,uStyleTone),uPalette);
  if(uSelectedEnabled) base=selectedColor(base);
  if(uGradientEnabled) {
    vec3 local=adjust(base,vec4(uGradientControls.x,0.,uGradientControls.y,0.),vec4(0.,0.,uGradientControls.z,0.),vec3(0.));
    base=mix(base,local,gradientWeight(uv));
  }
  return base;
}
void main(){
  vec2 uv=sourceUv();
  vec3 c=processed(uv);
  gl_FragColor=vec4(uFinish ? finish(c,uv) : c,1.);
}`;
// Pass 2: 3x3 unsharp mask over pass 1. The canvas is the crop at source resolution, so one output
// pixel is one source pixel along the rotated axes, as in the export pipeline.
const sharpenFragment = `${finishing}
uniform sampler2D uProcessed; uniform float uSharpen;
vec3 tap(vec2 t, float x, float y){ return texture2D(uProcessed,t+vec2(x,y)/uOutput).rgb; }
void main(){
  vec2 t=vec2(vUv.x,1.-vUv.y);
  vec3 c=tap(t,0.,0.);
  vec3 blur=(tap(t,-1.,-1.)+tap(t,1.,-1.)+tap(t,-1.,1.)+tap(t,1.,1.)
    +2.*(tap(t,0.,-1.)+tap(t,-1.,0.)+tap(t,1.,0.)+tap(t,0.,1.))+4.*c)/16.;
  c=clamp(c+(c-blur)*uSharpen,0.,1.);
  gl_FragColor=vec4(finish(c,sourceUv()),1.);
}`;

function compileProgram(gl: WebGLRenderingContext, sources: [string, string], shaders: WebGLShader[]) {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, sources[0]],
    [gl.FRAGMENT_SHADER, sources[1]],
  ] as const) {
    const shader = gl.createShader(type)!;
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteProgram(program);
      throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed");
    }
    gl.attachShader(program, shader);
  }
  // Both passes share one quad buffer, so pin the attribute to the same slot.
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new Error("Preview program failed");
  }
  return program;
}

export class EditingRenderer {
  private gl: WebGLRenderingContext;
  private program!: WebGLProgram;
  private sharpenProgram!: WebGLProgram;
  private shaders: WebGLShader[] = [];
  private texture!: WebGLTexture;
  private buffer!: WebGLBuffer;
  // Pass-1 result when sharpening; created on first use and resized with the crop.
  private processedTexture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private processedSize = { width: 0, height: 0 };
  private locations = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  constructor(
    private canvas: HTMLCanvasElement,
    private base: EditingBase,
  ) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl || !gl.getExtension("OES_texture_float"))
      throw new Error("Live preview unavailable; using rendered preview.");
    this.gl = gl;
    try {
      this.program = compileProgram(gl, [vertex, fragment], this.shaders);
      this.sharpenProgram = compileProgram(gl, [vertex, sharpenFragment], this.shaders);
    } catch (error) {
      this.dispose();
      throw error;
    }
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const filter = gl.getExtension("OES_texture_float_linear")
      ? gl.LINEAR
      : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB,
      base.width,
      base.height,
      0,
      gl.RGB,
      gl.FLOAT,
      base.pixels,
    );
    if (gl.getError() !== gl.NO_ERROR) {
      this.dispose();
      throw new Error("Unable to upload editing image");
    }
  }
  private location(name: string) {
    const program = this.gl.getParameter(this.gl.CURRENT_PROGRAM) as WebGLProgram;
    let table = this.locations.get(program);
    if (!table) this.locations.set(program, (table = new Map()));
    if (!table.has(name)) table.set(name, this.gl.getUniformLocation(program, name));
    return table.get(name)!;
  }
  private processedTarget(width: number, height: number) {
    const gl = this.gl;
    if (!this.framebuffer) {
      this.processedTexture = gl.createTexture();
      this.framebuffer = gl.createFramebuffer();
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.processedTexture);
    if (this.processedSize.width !== width || this.processedSize.height !== height) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      // Float keeps pass 1 exact (8 bits would round 0.998 up to a "clipped" 1.0); not every GPU can
      // render to float, so fall back to 8 bits there.
      const types = gl.getExtension("WEBGL_color_buffer_float") ? [gl.FLOAT, gl.UNSIGNED_BYTE] : [gl.UNSIGNED_BYTE];
      for (const type of types) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.processedTexture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) break;
      }
      this.processedSize = { width, height };
    }
    gl.activeTexture(gl.TEXTURE0);
    return this.framebuffer;
  }
  draw(
    settings: ExportEnhanceSettings,
    original = false,
    clipping = false,
    maskOverlay = false,
  ) {
    if (
      (settings.engineVersion ?? 1) !== 1 ||
      (settings.rawProfileVersion ?? 1) !== 1
    )
      throw new Error("This edit requires a newer version of Photo Cull.");
    const gl = this.gl,
      base = this.base,
      crop = geometry(base.width, base.height, settings.crop);
    if (
      this.canvas.width !== crop.width ||
      this.canvas.height !== crop.height
    ) {
      this.canvas.width = crop.width;
      this.canvas.height = crop.height;
    }
    const sharpen = settings.sharpen > 0 && !original;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.location("uImage"), 0);
    gl.uniform1i(this.location("uFinish"), sharpen ? 0 : 1);
    const controls = (prefix: string, s: Partial<ExportEnhanceSettings>) => {
      gl.uniform4f(
        this.location(`${prefix}Light`),
        s.exposure ?? 0,
        s.brilliance ?? 0,
        s.highlights ?? 0,
        s.shadows ?? 0,
      );
      gl.uniform4f(
        this.location(`${prefix}Color`),
        s.saturation ?? 0,
        s.vibrance ?? 0,
        s.temperature ?? 0,
        s.tint ?? 0,
      );
      gl.uniform3f(
        this.location(`${prefix}Tone`),
        s.contrast ?? 0,
        s.blackPoint ?? 0,
        s.dehaze ?? 0,
      );
    };
    controls("u", settings);
    const style =
      presets[settings.photoStyle.preset as keyof typeof presets] ??
      presets.standard;
    controls("uStyle", {
      ...style,
      contrast: style.contrast + (settings.photoStyle.tone / 100) * 0.15,
      temperature:
        style.temperature + (settings.photoStyle.colour / 100) * 0.12,
    });
    gl.uniform1f(this.location("uPalette"), settings.photoStyle.palette / 100);
    const gradient = settings.gradient;
    // Uniforms both passes read (declared in the shared finishing code).
    const shared = () => {
      gl.uniform2f(this.location("uSource"), base.width, base.height);
      gl.uniform2f(this.location("uOutput"), crop.width, crop.height);
      gl.uniform2f(this.location("uCenter"), crop.cx, crop.cy);
      gl.uniform2f(this.location("uRotation"), crop.c, crop.s);
      gl.uniform1i(this.location("uOriginal"), original ? 1 : 0);
      gl.uniform1i(this.location("uClipping"), clipping ? 1 : 0);
      gl.uniform1i(this.location("uGradientEnabled"), gradient?.enabled ? 1 : 0);
      gl.uniform1i(this.location("uGradientInvert"), gradient?.invert ? 1 : 0);
      gl.uniform1i(this.location("uMaskOverlay"), maskOverlay ? 1 : 0);
      gl.uniform4f(
        this.location("uGradientPoints"),
        gradient?.start.x ?? 0.5,
        gradient?.start.y ?? 0,
        gradient?.end.x ?? 0.5,
        gradient?.end.y ?? 1,
      );
      gl.uniform1f(this.location("uGradientFeather"), gradient?.feather ?? 1);
    };
    shared();
    gl.uniform3f(
      this.location("uGradientControls"),
      gradient?.exposure ?? 0,
      gradient?.highlights ?? 0,
      gradient?.temperature ?? 0,
    );
    const selected = settings.selectedColor;
    gl.uniform1i(
      this.location("uSelectedEnabled"),
      selected && (selected.hue || selected.saturation || selected.luminance)
        ? 1
        : 0,
    );
    gl.uniform2f(
      this.location("uSelectedBand"),
      selected?.center ?? 0,
      selected?.range ?? 0.12,
    );
    gl.uniform3f(
      this.location("uSelectedControls"),
      selected?.hue ?? 0,
      selected?.saturation ?? 0,
      selected?.luminance ?? 0,
    );
    gl.viewport(0, 0, crop.width, crop.height);
    if (!sharpen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.processedTarget(crop.width, crop.height));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.sharpenProgram);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.processedTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.location("uProcessed"), 1);
    gl.uniform1f(this.location("uSharpen"), settings.sharpen);
    shared();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    if (this.sharpenProgram) gl.deleteProgram(this.sharpenProgram);
    if (this.processedTexture) gl.deleteTexture(this.processedTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    this.shaders.forEach((shader) => gl.deleteShader(shader));
  }
  histogram() {
    const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    this.gl.readPixels(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels,
    );
    const bins = Array.from({ length: 4 }, () =>
      new Array<number>(256).fill(0),
    );
    for (let i = 0; i < pixels.length; i += 4) {
      bins[0][pixels[i]]++;
      bins[1][pixels[i + 1]]++;
      bins[2][pixels[i + 2]]++;
      bins[3][
        Math.round(
          pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722,
        )
      ]++;
    }
    return bins;
  }
  readPixel() {
    const value = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, value);
    return [value[0] / 255, value[1] / 255, value[2] / 255];
  }
}

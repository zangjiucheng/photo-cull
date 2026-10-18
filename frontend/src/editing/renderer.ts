import type { ExportEnhanceSettings } from "../types";
import { geometry, presets } from "./recipe";

export interface EditingBase {
  width: number;
  height: number;
  pixels: Float32Array;
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
  return { width, height, pixels };
}

const vertex = `attribute vec2 aPosition; varying vec2 vUv;
void main(){ vUv=vec2(aPosition.x*.5+.5,.5-aPosition.y*.5); gl_Position=vec4(aPosition,0.,1.); }`;
const fragment = `precision highp float;
varying vec2 vUv; uniform sampler2D uImage;
uniform vec4 uLight; uniform vec4 uColor; uniform vec3 uTone;
uniform vec4 uStyleLight; uniform vec4 uStyleColor; uniform vec3 uStyleTone;
uniform vec2 uSource; uniform vec2 uOutput; uniform vec2 uCenter; uniform vec2 uRotation;
uniform float uPalette; uniform float uSharpen; uniform bool uOriginal; uniform bool uClipping;
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
  return mix(base,adjust(base,uStyleLight,uStyleColor,uStyleTone),uPalette);
}
vec2 rotate(vec2 p){ return vec2(uRotation.x*p.x-uRotation.y*p.y,uRotation.y*p.x+uRotation.x*p.y); }
void main(){
  vec2 uv=(uCenter+rotate((vUv-.5)*uOutput))/uSource;
  vec3 c=processed(uv);
  if(uSharpen>0. && !uOriginal){
    vec3 blur=vec3(0.);
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
      float weight=(x==0?2.:1.)*(y==0?2.:1.);
      blur+=processed(uv+rotate(vec2(float(x),float(y)))/uSource)*weight/16.;
    }
    c=clamp(c+(c-blur)*uSharpen,0.,1.);
  }
  if(uClipping && !uOriginal){ if(max(max(c.r,c.g),c.b)>=.999) c=vec3(1.,.15,.12); else if(min(min(c.r,c.g),c.b)<=.001) c=vec3(.1,.35,1.); }
  gl_FragColor=vec4(c,1.);
}`;

export class EditingRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private shaders: WebGLShader[] = [];
  private texture: WebGLTexture;
  private buffer: WebGLBuffer;
  private locations = new Map<string, WebGLUniformLocation | null>();
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
    this.program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)!;
      this.shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        this.dispose();
        throw new Error(error || "Shader compilation failed");
      }
      gl.attachShader(this.program, shader);
    }
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      this.dispose();
      throw new Error("Preview program failed");
    }
    gl.useProgram(this.program);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(this.program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
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
    if (!this.locations.has(name))
      this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locations.get(name)!;
  }
  draw(settings: ExportEnhanceSettings, original = false, clipping = false) {
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
    gl.useProgram(this.program);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
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
    gl.uniform2f(this.location("uSource"), base.width, base.height);
    gl.uniform2f(this.location("uOutput"), crop.width, crop.height);
    gl.uniform2f(this.location("uCenter"), crop.cx, crop.cy);
    gl.uniform2f(this.location("uRotation"), crop.c, crop.s);
    gl.uniform1f(this.location("uPalette"), settings.photoStyle.palette / 100);
    gl.uniform1f(this.location("uSharpen"), settings.sharpen);
    gl.uniform1i(this.location("uOriginal"), original ? 1 : 0);
    gl.uniform1i(this.location("uClipping"), clipping ? 1 : 0);
    gl.viewport(0, 0, crop.width, crop.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    this.shaders.forEach((shader) => gl.deleteShader(shader));
  }
}

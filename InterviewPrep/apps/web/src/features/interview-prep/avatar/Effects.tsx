import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** Final grade after tone mapping: an S-curve for contrast (AgX is flat by design), slight saturation, grain and vignette. */
const GrainVignette = {
  name: 'GrainVignette',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    grain: { value: 0.028 },
    vignette: { value: 0.32 },
    contrast: { value: 0.22 },
    saturation: { value: 1.06 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float grain;
    uniform float vignette;
    uniform float contrast;
    uniform float saturation;
    varying vec2 vUv;
    float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // smoothstep S-curve blended in by 'contrast': deeper blacks, brighter highlights
      vec3 s = c.rgb * c.rgb * (3.0 - 2.0 * c.rgb);
      c.rgb = mix(c.rgb, s, contrast);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, saturation), 0.0);
      float n = rand(vUv * 913.0 + fract(time * 7.3)) - 0.5;
      // grain is strongest in the mid-tones, as on film
      float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += n * grain * (1.0 - abs(luma - 0.5) * 1.2);
      vec2 d = (vUv - 0.5) * vec2(1.15, 1.0);
      c.rgb *= mix(1.0, 1.0 - vignette, smoothstep(0.28, 0.9, length(d)));
      gl_FragColor = c;
    }`,
};

export interface EffectsProps {
  /** World point to keep in focus (the face). */
  focus: THREE.Vector3;
}

/**
 * Photographic post-processing for the interviewer stage: ground-truth ambient occlusion (soft
 * contact shadows in creases, under the collar and between the fingers), a shallow depth of field
 * focused on the face, tone mapping, then grain and vignette. Rendered at priority 1, which takes
 * over R3F's default render; unmounting the component returns to the plain render.
 */
export function Effects({ focus }: EffectsProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);

  const { composer, bokeh, grain } = useMemo(() => {
    // multisampled HDR target so edges (and alpha-to-coverage hair) stay antialiased
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(gl, target);
    c.addPass(new RenderPass(scene, camera));
    const ao = new GTAOPass(scene, camera, 1, 1);
    ao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.4, thickness: 1.5, scale: 1.1, samples: 12 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    ao.blendIntensity = 0.85;
    c.addPass(ao);
    const b = new BokehPass(scene, camera, { focus: 2, aperture: 0.0016, maxblur: 0.0055 });
    c.addPass(b);
    c.addPass(new OutputPass());
    const g = new ShaderPass(GrainVignette);
    c.addPass(g);
    return { composer: c, bokeh: b, grain: g };
  }, [gl, scene, camera]);

  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
  }, [composer, gl, size.width, size.height]);

  useEffect(() => () => composer.dispose(), [composer]);

  // AgX renders skin naturally where ACES oversaturates warm tones; it is flat on its own, so it is
  // used only together with this grade, and ACES is restored if the effects switch off.
  useEffect(() => {
    const prev = { mapping: gl.toneMapping, exposure: gl.toneMappingExposure };
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = 1.1;
    return () => {
      gl.toneMapping = prev.mapping;
      gl.toneMappingExposure = prev.exposure;
    };
  }, [gl]);

  useFrame((_, delta) => {
    (bokeh.uniforms as Record<string, THREE.IUniform>).focus!.value = camera.position.distanceTo(focus);
    grain.uniforms.time!.value += delta;
    composer.render(delta);
  }, 1);

  return null;
}

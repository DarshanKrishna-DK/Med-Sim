import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Environment } from '@react-three/drei';
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import * as THREE from 'three';

export const HDRI_URL = '/assets/hdri/hospital_room_1k.hdr';

/** Image-based lighting from a CC0 Poly Haven hospital-room HDRI. Not shown
 *  as background: interiors provide their own walls. */
export function WorldEnvironment({ intensity = 0.55 }: { intensity?: number }) {
  const { scene, gl } = useThree();
  useEffect(() => {
    gl.toneMapping = THREE.NoToneMapping; // ACES runs in the composer
    scene.environmentIntensity = intensity;
  }, [scene, gl, intensity]);
  return <Environment files={HDRI_URL} environmentIntensity={intensity} />;
}

export type FxQuality = 'high' | 'low';

/** Subtle post: AO for contact grounding, bloom on emissive panels only,
 *  a soft vignette, ACES filmic at the end. */
export function PostFX({ quality = 'high', exposure = 1 }: { quality?: FxQuality; exposure?: number }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.toneMappingExposure = exposure;
  }, [gl, exposure]);
  return (
    <EffectComposer multisampling={quality === 'high' ? 4 : 0} enableNormalPass={false}>
      {quality === 'high' ? (
        <N8AO halfRes quality="performance" aoRadius={0.7} distanceFalloff={0.6} intensity={2.4} color="#1a1410" />
      ) : (
        <></>
      )}
      <Bloom mipmapBlur luminanceThreshold={1.0} luminanceSmoothing={0.2} intensity={0.45} radius={0.7} />
      <Vignette offset={0.3} darkness={0.48} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}

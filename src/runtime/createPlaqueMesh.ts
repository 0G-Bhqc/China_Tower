import * as THREE from 'three';

export type PlaqueSpec = {
  text: string;
  width: number;
  height: number;
  bgColor: string;
  textColor: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  font?: string;
};

export function createPlaqueMesh(spec: PlaqueSpec): THREE.Mesh {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = 1024;
  const height = Math.round((spec.height / spec.width) * width);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire plaque canvas context');
  }

  context.fillStyle = spec.bgColor;
  context.fillRect(0, 0, width, height);

  // Add subtle border to suggest a wooden/metal plaque board
  context.strokeStyle = spec.textColor;
  context.lineWidth = Math.max(12, width * 0.025);
  context.strokeRect(
    width * 0.06,
    height * 0.06,
    width * 0.88,
    height * 0.88,
  );

  context.fillStyle = spec.textColor;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const fontSize = Math.round(width * 0.52);
  context.font = `${fontSize}px ${spec.font ?? '"Noto Serif SC", "SimSun", "STSong", serif'}`;
  context.fillText(spec.text, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.55,
    metalness: 0.05,
  });
  material.name = `plaque-${spec.text}`;

  const geometry = new THREE.PlaneGeometry(spec.width, spec.height, 1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `Plaque ${spec.text}`;
  if (spec.rotation) {
    mesh.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

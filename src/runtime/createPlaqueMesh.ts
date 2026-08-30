import * as THREE from 'three';

export type PlaqueSpec = {
  /** Single-line horizontal text (classic plaque). */
  text?: string;
  /** Vertical columns, rendered right-to-left (couplets, poem steles). */
  lines?: string[];
  /** Small horizontal caption drawn along the bottom edge (e.g. 唐 · 崔颢). */
  caption?: string;
  width: number;
  height: number;
  bgColor: string;
  textColor: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  font?: string;
};

function paintVerticalText(
  context: CanvasRenderingContext2D,
  lines: string[],
  width: number,
  height: number,
  font: string,
  textColor: string,
): void {
  const padding = width * 0.09;
  const maxChars = Math.max(...lines.map((line) => line.length));
  const columnCount = lines.length;
  const charSize = Math.min(
    (width - padding * 2) / (columnCount * 1.28),
    (height - padding * 2.4) / (maxChars * 1.12),
  );
  const columnGap = charSize * 0.28;
  const blockWidth = columnCount * charSize + (columnCount - 1) * columnGap;
  const startX = (width + blockWidth) / 2 - charSize / 2; // first column on the RIGHT
  context.font = `${Math.round(charSize)}px ${font}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  lines.forEach((line, columnIndex) => {
    const x = startX - columnIndex * (charSize + columnGap);
    const columnHeight = line.length * charSize;
    const startY = (height - columnHeight) / 2 + charSize / 2;
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      context.fillText(line[charIndex], x, startY + charIndex * charSize);
    }
  });
}

function paintCaption(
  context: CanvasRenderingContext2D,
  caption: string,
  width: number,
  height: number,
  font: string,
  textColor: string,
): void {
  const fontSize = Math.round(width * 0.055);
  context.font = `${fontSize}px ${font}`;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  context.globalAlpha = 0.82;
  context.fillText(caption, width / 2, height - width * 0.05);
  context.globalAlpha = 1;
}

// Classic 匾额 lettering: a calligraphic 楷书 face first (the Ma Shan Zheng
// webfont is the reliable cross-platform one; Kaiti system faces cover the
// rest), with serif as the sober fallback.
export const PLAQUE_FONT = '"Ma Shan Zheng", "Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", "SimSun", serif';

export function createPlaqueMesh(spec: PlaqueSpec): THREE.Mesh {
  const canvas = document.createElement('canvas');
  const width = 1024;
  const height = Math.round((spec.height / spec.width) * width);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to acquire plaque canvas context');
  }

  const font = spec.font ?? PLAQUE_FONT;
  const paint = (): void => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = spec.bgColor;
    context.fillRect(0, 0, width, height);
    if (spec.lines) {
      paintVerticalText(context, spec.lines, width, height, font, spec.textColor);
    } else {
      context.fillStyle = spec.textColor;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      // Fit by glyph count AND canvas height: the old fixed 0.52*width sized a
      // 3-character board past the canvas edge and clipped the outer strokes.
      const fontSize = Math.min(
        Math.round((width * 0.86) / Math.max(1, (spec.text ?? '').length)),
        Math.round(height * 0.62),
      );
      context.font = `${fontSize}px ${font}`;
      context.fillText(spec.text ?? '', width / 2, height / 2);
    }
    if (spec.caption) {
      paintCaption(context, spec.caption, width, height, font, spec.textColor);
    }
    // Border last so text never overlaps the frame.
    context.strokeStyle = spec.textColor;
    context.lineWidth = Math.max(12, width * 0.025);
    context.strokeRect(
      width * 0.06,
      height * 0.06,
      width * 0.88,
      height * 0.88,
    );
  };
  paint();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;

  // The GLB resolves seconds after page load, so the webfont often has not
  // landed when the canvas first paints — the plaque would freeze in the
  // fallback serif. Re-stamp once fonts settle.
  if (typeof document.fonts?.check === 'function' && !document.fonts.check(`24px ${font}`)) {
    void document.fonts.ready.then(() => {
      paint();
      texture.needsUpdate = true;
    });
  }

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.55,
    metalness: 0.05,
  });
  material.name = `plaque-${spec.text ?? spec.lines?.[0] ?? 'unnamed'}`;

  const geometry = new THREE.PlaneGeometry(spec.width, spec.height, 1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `Plaque ${spec.text ?? spec.lines?.join('') ?? 'unnamed'}`;
  if (spec.rotation) {
    mesh.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

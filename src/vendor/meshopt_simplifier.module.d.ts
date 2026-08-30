// Type declarations for the vendored meshoptimizer simplifier module
// (src/vendor/meshopt_simplifier.module.js, meshoptimizer 0.22, MIT).

export type MeshoptSimplifierFlags = ('LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune')[];

export var MeshoptSimplifier: {
  supported: boolean;
  ready: Promise<void>;
  useExperimentalFeatures: boolean;
  simplify(
    indices: Uint32Array | Uint16Array,
    vertexPositions: Float32Array,
    vertexPositionsStride: number,
    targetIndexCount: number,
    targetError: number,
    flags?: MeshoptSimplifierFlags,
  ): [Uint32Array, number];
  compactMesh(indices: Uint32Array | Uint16Array): Uint32Array;
};

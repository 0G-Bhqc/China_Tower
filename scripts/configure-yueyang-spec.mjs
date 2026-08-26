import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '..');
const specPath = path.join(workspace, 'object-sculpt-spec.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const rgbaByMaterial = {
  'granite-stone': ['rgba(148, 145, 135, 1)', 'rgba(94, 92, 86, 1)', 'stone', 0.82],
  'red-lacquer': ['rgba(104, 24, 22, 1)', 'rgba(39, 17, 17, 1)', 'wood', 0.86],
  'dark-timber': ['rgba(30, 22, 20, 1)', 'rgba(77, 45, 34, 1)', 'wood', 0.82],
  'glazed-tile': ['rgba(218, 153, 50, 1)', 'rgba(139, 74, 26, 1)', 'ceramic', 0.84],
  'gold-accent': ['rgba(190, 133, 39, 1)', 'rgba(82, 51, 18, 1)', 'metal', 0.72],
};

function materialRecipe(material) {
  const [dominantAlbedo, secondaryAlbedo, materialClass, materialClassConfidence] = rgbaByMaterial[material];
  return { dominantAlbedo, secondaryAlbedo, materialClass, materialClassConfidence };
}

function actionProfile(id, role = 'static-part') {
  return {
    animationRole: role,
    pivot: { mode: 'center', localPosition: [0, 0, 0], axis: [0, 1, 0], confidence: 0.9 },
    transformChannels: {
      translate: true, rotate: true, scale: true, bend: false, twist: false,
      detach: id !== 'root', visibility: true, materialState: true,
    },
    sockets: [],
    collider: { type: 'box', offset: [0, 0, 0], scale: [1, 1, 1], isTrigger: false, notes: 'Broad-phase proxy; refine after form acceptance.' },
    constraints: [],
    destruction: {
      breakable: false, fractureGroup: id, seamRefs: [], detachableFragments: [],
      breakImpulse: 0, debrisMaterial: 'dark-timber',
    },
  };
}

function component({
  id, name, level, role, primitive = 'box', topologyClass = 'assembled-solid',
  topologyRationale, parent = 'root', material, dimensions, position,
  geometryDescriptor = {}, localFeatures = [], confidence = 0.82,
}) {
  return {
    id, name, level, role, importance: level === 'macro' ? 0.95 : 0.76, confidence,
    primitive, topologyClass, topologyRationale,
    geometryDescriptor: {
      topologyIntent: level === 'macro' ? 'architectural blockout with separable masses' : 'separable architectural sub-assembly',
      edgeTreatment: { type: 'chamfer', bevelRadius: level === 'macro' ? 0.025 : 0.012, segments: 1 },
      deformationStack: [], uvStrategy: 'generated procedural coordinates', normalStrategy: 'vertex normals from generated geometry',
      ...geometryDescriptor,
    },
    parent, attachment: null,
    dimensions: { ...dimensions, units: 'metres', confidence },
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    actionProfile: actionProfile(id),
    material, materialLayers: [material], deformations: [], joints: [], seams: [], localFeatures,
    surfaceDetail: {
      macroRoughness: 0.12, microRoughness: 0.08, bumpAmplitude: 0.02,
      normalPattern: 'material-specific independent field', displacementPattern: 'none in blockout',
      occlusionPattern: 'contact and construction seams', edgeWearPattern: 'subtle exposed edge variation',
      notes: 'Blockout uses scalar PBR response; extracted maps remain review evidence until material pass.',
    },
    colorMaterialRecipe: materialRecipe(material), evidenceRefs: ['full-object'], details: [],
    fidelityTier: level === 'macro' ? 'blockout' : level === 'meso' ? 'structural-pass' : 'form-refinement',
  };
}

const shallowRoofProfile = {
  points: [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]],
  depth: 1,
};
const helmetProfile = {
  points: [[-0.5, 0.08], [-0.42, -0.08], [-0.2, -0.19], [0, -0.23], [0.2, -0.19], [0.42, -0.08], [0.5, 0.08], [0.32, 0.17], [0.1, 0.29], [0, 0.36], [-0.1, 0.29], [-0.32, 0.17]],
  depth: 1,
};

spec.preSpecAssessment.unknownsToResolveBeforeImplementation = [];
spec.assumptions = [
  'Rear facade and rear roof slopes are resolved for the PoC by bilateral symmetry, confidence 0.65.',
  'Dougong is resolved as a simplified stepped three-block module until licensed close-up evidence is available.',
  'Tile and railing motifs are represented by observed distribution rhythm, not exact ornamental carving.',
  'Overall height is parameterized at 19.42 m; a 20.36 m alternative remains a future source-reconciliation task.',
];
spec.scores = {
  object_isolation: 2, silhouette_readability: 3, depth_inference: 2,
  primitive_decomposition: 3, material_procedurality: 3, occlusion_risk: 2, interaction_fit: 3,
};
spec.referenceCamera = {
  solved: false, fovDegrees: 46, aspect: 1007 / 671,
  orientation: { yaw: -28, pitch: -8, roll: 0 }, positionHint: [25, 17, 30],
  note: 'Approximate three-quarter review camera; no projection route. Match by browser overlay before fidelity claims.',
};
spec.coordinateFrame = { front: '+Z faces the principal east facade', up: '+Y', scaleReference: '1 unit = 1 metre' };
spec.silhouette = {
  boundingShape: 'rectangular three-storey pavilion with three horizontally separated swept-eave bands',
  aspectRatios: [17.24 / 14.54, 19.42 / 17.24], symmetry: 'bilateral across X and Z axes with ornament-level deviations',
  dominantCurves: ['three upturned eave profiles', 'helmet roof inward curve', 'mild upward storey taper'],
  negativeSpaces: ['second-storey open gallery', 'column bays below eaves'],
  landmarks: ['granite base', 'three yellow roof bands', 'second-storey balcony', 'helmet roof', 'central finial'],
};
spec.viewEvidence = [
  { id: 'full-object', view: 'three-quarter-primary', imageRegion: { x: 0, y: 0, width: 0.69, height: 1, units: 'normalized' }, observations: ['three storeys', 'three yellow eaves', 'helmet roof', 'gallery', 'red column rhythm'], confidence: 0.92 },
  { id: 'official-aerial', view: 'near-front-wide', imageRegion: { x: 0.25, y: 0, width: 0.5, height: 1, units: 'normalized' }, observations: ['front symmetry', 'main/auxiliary relationship'], confidence: 0.74 },
  { id: 'hunan-aerial', view: 'top-oblique', imageRegion: { x: 0.25, y: 0.3, width: 0.5, height: 0.55, units: 'normalized' }, observations: ['rectangular footprint', 'wall and courtyard context'], confidence: 0.79 },
  { id: 'official-main', view: 'eave-detail', imageRegion: { x: 0, y: 0, width: 1, height: 1, units: 'normalized' }, observations: ['tile rows', 'corner ridge', 'dark timber underside'], confidence: 0.76 },
  { id: 'official-building-data', view: 'documentary', imageRegion: { x: 0, y: 0, width: 1, height: 1, units: 'normalized' }, observations: ['17.24 m width', '14.54 m depth', '19.42 m height', 'three storeys', 'four main columns', 'helmet roof'], confidence: 0.94 },
];

spec.componentTree = [
  component({ id: 'root', name: 'Yueyang Tower assembly root', level: 'macro', role: 'body', parent: null, material: 'dark-timber', dimensions: { width: 0.01, height: 0.01, depth: 0.01 }, position: [0, 0, 0], topologyRationale: 'A minimal pickable assembly anchor; visible architecture remains in named child masses.' }),
  component({ id: 'granite-base', name: 'Granite platform', level: 'macro', role: 'platform', material: 'granite-stone', dimensions: { width: 17.8, height: 1.4, depth: 15.1 }, position: [0, 0.7, 0], topologyRationale: 'Visible rigid rectangular stone courses form a discrete load-bearing plinth.', localFeatures: [{ id: 'granite-base.course-seams', type: 'seam', realization: 'procedural course grooves', evidenceRefs: ['full-object'] }] }),
  component({ id: 'storey-one', name: 'First storey mass', level: 'macro', role: 'storey', material: 'dark-timber', dimensions: { width: 15, height: 3.8, depth: 12.4 }, position: [0, 3.3, 0], topologyRationale: 'The first storey reads as a rigid rectangular post-and-panel envelope at blockout distance.', localFeatures: [{ id: 'door-lattice-system.gold-grid', type: 'linework', realization: 'repeated geometry in structural/form pass', evidenceRefs: ['full-object'] }] }),
  component({ id: 'lower-eave', name: 'Lower swept eave', level: 'macro', role: 'roof-shell', primitive: 'extrude', topologyClass: 'conforming-shell', material: 'glazed-tile', dimensions: { width: 18.6, height: 1.5, depth: 15.5 }, position: [0, 5.55, -7.75], topologyRationale: 'A thin custom-profile roof shell follows the structural frame and defines the lower silhouette.', geometryDescriptor: { profile2D: shallowRoofProfile }, localFeatures: [{ id: 'eave-corner-system.curved-ridges', type: 'ridge', realization: 'curved corner ridge geometry in form pass', evidenceRefs: ['full-object', 'official-main'] }] }),
  component({ id: 'storey-two', name: 'Second storey gallery mass', level: 'macro', role: 'storey', material: 'dark-timber', dimensions: { width: 12.8, height: 3, depth: 10.3 }, position: [0, 7.4, 0], topologyRationale: 'The second storey is a separable rectangular volume inside a projecting gallery.', localFeatures: [{ id: 'second-storey.open-gallery-shadow-gap', type: 'negative-space', realization: 'projecting deck plus inset wall volume', evidenceRefs: ['full-object'] }] }),
  component({ id: 'middle-eave', name: 'Middle swept eave', level: 'macro', role: 'roof-shell', primitive: 'extrude', topologyClass: 'conforming-shell', material: 'glazed-tile', dimensions: { width: 15.6, height: 1.35, depth: 12.9 }, position: [0, 9.25, -6.45], topologyRationale: 'A thinner custom-profile shell repeats the lower eave with mild upward taper.', geometryDescriptor: { profile2D: shallowRoofProfile }, localFeatures: [{ id: 'roof-tile-system.instanced-rows', type: 'ridge', realization: 'instanced roof tile rows in form pass', evidenceRefs: ['full-object', 'official-main'] }] }),
  component({ id: 'storey-three', name: 'Third storey mass', level: 'macro', role: 'storey', material: 'dark-timber', dimensions: { width: 9.9, height: 2.65, depth: 7.9 }, position: [0, 11.15, 0], topologyRationale: 'The upper enclosed rectangular volume is visibly smaller but not pagoda-like in taper.', localFeatures: [{ id: 'plaque-carrier', type: 'surface-relief', realization: 'separate plaque mesh', evidenceRefs: ['full-object'] }] }),
  component({ id: 'helmet-roof', name: 'Curved helmet roof blockout', level: 'macro', role: 'roof-shell', primitive: 'extrude', topologyClass: 'conforming-shell', material: 'glazed-tile', dimensions: { width: 12.5, height: 3.2, depth: 10.4 }, position: [0, 13.55, -5.2], topologyRationale: 'A custom closed profile preserves the unique depressed-centre and rising-corner silhouette; the form pass will replace its depth extrusion with a two-axis continuous surface.', geometryDescriptor: { profile2D: helmetProfile }, localFeatures: [{ id: 'helmet-roof.edge-profile', type: 'contour', realization: 'custom extruded blockout profile; two-axis shell deferred', evidenceRefs: ['full-object', 'official-main'] }] }),
  component({ id: 'roof-finial', name: 'Central roof finial', level: 'macro', role: 'ornament', primitive: 'lathe', topologyClass: 'continuous-sculpt', material: 'gold-accent', dimensions: { width: 0.65, height: 1.35, depth: 0.65 }, position: [0, 15.38, 0], topologyRationale: 'The small axial ornament is rotationally symmetric with a stacked turned profile and its lower endpoint contacts the helmet-roof crown.', geometryDescriptor: { latheProfile: { points: [[0.18, -0.5], [0.28, -0.32], [0.12, -0.12], [0.22, 0.05], [0.1, 0.25], [0.03, 0.5]], segments: 20 } }, localFeatures: [{ id: 'roof-finial.stacked-profile', type: 'ridge', realization: 'lathed stacked profile', evidenceRefs: ['full-object'] }] }),

  component({ id: 'first-floor-deck', name: 'First floor deck', level: 'meso', role: 'deck', material: 'dark-timber', dimensions: { width: 15.4, height: 0.28, depth: 12.8 }, position: [0, 1.55, 0], topologyRationale: 'A rigid rectangular timber floor plate separates base and first-storey frame.' }),
  component({ id: 'second-floor-gallery', name: 'Second floor gallery deck', level: 'meso', role: 'gallery', material: 'dark-timber', dimensions: { width: 14.4, height: 0.32, depth: 11.8 }, position: [0, 6.08, 0], topologyRationale: 'The projecting rigid deck creates the observable open gallery perimeter.', localFeatures: [{ id: 'balcony-railing-system.lattice-bays', type: 'linework', realization: 'instanced railing bays', evidenceRefs: ['full-object'] }] }),
  component({ id: 'third-floor-deck', name: 'Third floor deck', level: 'meso', role: 'deck', material: 'dark-timber', dimensions: { width: 10.7, height: 0.26, depth: 8.7 }, position: [0, 9.75, 0], topologyRationale: 'A rigid rectangular timber floor plate separates second and third storeys.' }),
  component({ id: 'beam-band-one', name: 'First-storey beam band', level: 'meso', role: 'beam-band', material: 'dark-timber', dimensions: { width: 15.5, height: 0.42, depth: 12.9 }, position: [0, 5.02, 0], topologyRationale: 'A discrete horizontal beam/fang band caps the first-storey column rhythm.', localFeatures: [{ id: 'dougong-system.stepped-brackets', type: 'ridge', realization: 'instanced stepped block groups', evidenceRefs: ['full-object'] }] }),
  component({ id: 'beam-band-two', name: 'Second-storey beam band', level: 'meso', role: 'beam-band', material: 'dark-timber', dimensions: { width: 13.1, height: 0.38, depth: 10.6 }, position: [0, 8.78, 0], topologyRationale: 'A second rigid beam/fang band supports the middle eave.' }),
  component({ id: 'beam-band-three', name: 'Third-storey beam band', level: 'meso', role: 'beam-band', material: 'dark-timber', dimensions: { width: 10.2, height: 0.35, depth: 8.2 }, position: [0, 12.45, 0], topologyRationale: 'A compact upper beam/fang band supports the helmet roof.' }),
  component({ id: 'railing-front', name: 'Front gallery railing carrier', level: 'meso', role: 'railing', material: 'dark-timber', dimensions: { width: 13.4, height: 0.92, depth: 0.14 }, position: [0, 6.7, 5.78], topologyRationale: 'A thin rigid carrier establishes the front railing silhouette before lattice instancing.' }),
  component({ id: 'railing-back', name: 'Rear gallery railing carrier', level: 'meso', role: 'railing', material: 'dark-timber', dimensions: { width: 13.4, height: 0.92, depth: 0.14 }, position: [0, 6.7, -5.78], topologyRationale: 'A mirrored thin carrier encodes the inferred rear gallery boundary.' }),
  component({ id: 'railing-left', name: 'Left gallery railing carrier', level: 'meso', role: 'railing', material: 'dark-timber', dimensions: { width: 0.14, height: 0.92, depth: 11.4 }, position: [-7.08, 6.7, 0], topologyRationale: 'A thin rigid side carrier preserves the rectangular gallery perimeter.' }),
  component({ id: 'railing-right', name: 'Right gallery railing carrier', level: 'meso', role: 'railing', material: 'dark-timber', dimensions: { width: 0.14, height: 0.92, depth: 11.4 }, position: [7.08, 6.7, 0], topologyRationale: 'A mirrored thin side carrier preserves the rectangular gallery perimeter.' }),
  component({ id: 'upper-plaque', name: 'Upper plaque carrier', level: 'meso', role: 'plaque', primitive: 'plane-card', topologyClass: 'material-only', material: 'gold-accent', dimensions: { width: 3.6, height: 0.78, depth: 0.03 }, position: [0, 11.75, 4.02], topologyRationale: 'A flat plaque/decal carrier sits on the front facade and has negligible independent volume.' }),
  component({ id: 'front-steps', name: 'Front stone step mass', level: 'meso', role: 'stair', material: 'granite-stone', dimensions: { width: 5.6, height: 0.55, depth: 2.2 }, position: [0, 0.35, 8.05], topologyRationale: 'The visible access steps form a discrete rigid stone mass in the front axis.' }),
  component({ id: 'door-lattice-carrier', name: 'Door lattice carrier', level: 'meso', role: 'facade-panel', primitive: 'plane-card', topologyClass: 'material-only', material: 'gold-accent', dimensions: { width: 9.4, height: 2.3, depth: 0.03 }, position: [0, 3.05, 6.22], topologyRationale: 'A thin facade carrier reserves the observed repeated gold lattice system for the form pass.' }),
];

// The authoritative government record gives an overall height of 19.42 m.
// Preserve the verified 17.24 m x 14.54 m plan while scaling the authored
// vertical stack (whose finial-contact envelope is 16.055 m) to that height.
const officialHeightScale = 19.42 / 16.055;
for (const item of spec.componentTree) {
  if (item.id === 'root') continue;
  item.transform.position[1] *= officialHeightScale;
  item.dimensions.height *= officialHeightScale;
}

const pbrRoot = path.join(workspace, 'evidence', 'yueyang', 'pbr');
function referencePbr(id, confidence, sourceImage) {
  const dir = path.join(pbrRoot, id);
  const maps = Object.fromEntries(['albedo', 'roughness', 'height', 'normal', 'ao'].map(channel => [channel, {
    path: path.join(dir, `${id}_${channel}.png`), channel, source: 'reference-pixel-extraction',
  }]));
  return {
    version: '1', sourceImage, extractor: 'img2threejs/extract_pbr_evidence.py',
    method: 'single-image inferred independent channels', verdict: 'pass-with-crop-contamination-warning',
    usable: true, confidence, estimatedFidelity: confidence, targetThreshold: 0.7,
    hardLimit: 'Evidence maps mix nearby sky/architecture and are audit inputs, not production textures until material-pass crop review.', maps,
  };
}
function material(id, name, baseColor, roughness, metalness, pbrConfidence, sourceImage, localOverrides = [], extra = {}) {
  return {
    id, name, type: extra.type ?? 'physical', shaderModel: 'MeshPhysicalMaterial', baseColor, color: baseColor,
    albedo: { dominant: baseColor, secondary: extra.secondary ?? [], samplingNotes: extra.samplingNotes ?? 'Reference-observed region with contamination limitation recorded in referencePbr.' },
    colorVariation: { palette: [baseColor, ...(extra.secondary ?? [])], pattern: 'low-amplitude object-space mottling', amplitude: 0.06, heightCorrelation: 0.1 },
    textureResolution: 1024, textureProjection: { mode: 'world-units', repeat: [2, 2], anisotropy: 8, texelDensityIntent: 'Stable object-scale detail.' },
    surfaceFrequencyBands: [
      { id: 'macro', frequency: 2, amplitude: 0.12, role: 'broad value breakup' },
      { id: 'meso', frequency: 12, amplitude: 0.06, role: 'construction/grain relief' },
      { id: 'micro', frequency: 54, amplitude: 0.025, role: 'grazing-highlight breakup' },
    ],
    roughness: { base: roughness, variation: 0.1, map: 'independent-reference-evidence', localResponse: 'higher in cavities and lower on exposed edges' },
    metalness: { base: metalness, variation: 0.02 },
    normal: { pattern: 'independent-reference-height-derived', strength: 0.22, scale: 24, space: 'tangent' },
    bump: { pattern: 'independent fine field', amplitude: 0.02, scale: 38 },
    displacement: { pattern: 'none for blockout', amplitude: 0, scale: 1, silhouetteAffects: false },
    ambientOcclusion: { cavityStrength: 0.28, contactShadowBias: 0.35, notes: 'Construction seams and intersections only.' },
    wear: { edgeWear: 0.02, scratches: [], chips: [] }, dirt: { amount: 0.03, cavityBias: 0.7, color: '#211B18' },
    localOverrides, referencePbr: referencePbr(id, pbrConfidence, sourceImage),
    shaderNotes: ['Keep albedo, roughness, height/normal and AO independent.', 'Do not bind extracted evidence maps in blockout; crop contamination must be corrected before material pass.'],
    ...extra,
  };
}

const zones = path.join(workspace, 'evidence', 'yueyang', 'detail-zones');
spec.materials = [
  material('granite-stone', 'Weathered pale granite', '#8F8C82', 0.78, 0, 0.909, path.join(zones, 'ground-floor.png'), [{ id: 'granite-base.course-seams', region: 'platform courses', roughness: 0.9, aoStrength: 0.45, evidenceRefs: ['full-object'] }], { secondary: ['#68664F', '#B4B0A4'] }),
  material('red-lacquer', 'Dark red lacquered columns', '#641A18', 0.3, 0, 0.909, path.join(zones, 'ground-floor.png'), [{ id: 'red-lacquer.column-clearcoat', region: 'column crowns and lit vertical bands', roughness: 0.22, clearcoat: 0.42, clearcoatRoughness: 0.24, evidenceRefs: ['full-object'] }], { secondary: ['#2F1716', '#8C2C27'], clearcoat: 0.35, clearcoatRoughness: 0.28 }),
  material('dark-timber', 'Dark stained timber frame', '#211817', 0.56, 0, 0.829, path.join(zones, 'middle-balcony.png'), [{ id: 'dark-timber.cavity-shadow', region: 'under-eave bracket bands', roughness: 0.72, dirtAmount: 0.14, evidenceRefs: ['full-object'] }], { secondary: ['#4B2D23', '#0E0B0B'] }),
  material('glazed-tile', 'Warm yellow glazed roof tiles', '#D5962F', 0.34, 0, 0.829, path.join(zones, 'roof-and-finial.png'), [{ id: 'glazed-tile.ridge-highlight', region: 'tile row crowns', roughness: 0.25, clearcoat: 0.25, evidenceRefs: ['official-main'] }], { secondary: ['#8F4D1F', '#EDB84F'], clearcoat: 0.24, clearcoatRoughness: 0.3 }),
  material('gold-accent', 'Muted gold ornamental accents', '#B47D23', 0.38, 0.72, 0.909, path.join(zones, 'ground-floor.png'), [{ id: 'plaque-material.gold-on-black', region: 'plaque and sparse lattice accents', roughness: 0.32, baseColor: '#C18D31', evidenceRefs: ['full-object'] }], { secondary: ['#513311', '#D2A84A'] }),
];

spec.repetitionSystems = [
  { id: 'first-storey-columns', level: 'meso', parent: 'root', primitive: 'cylinder', material: 'red-lacquer', count: 24, instanceScale: [0.42, 3.55, 0.42], placement: { mode: 'rectangular-perimeter', axis: [0, 1, 0], radius: 12.4, startAngleDeg: 0 }, buildsGeometry: true, geometry: { head: 'round timber post' }, distributionRule: 'Six bays on long faces and four on short faces; generator radial fallback must be replaced before structural-pass acceptance.' },
  { id: 'second-storey-columns', level: 'meso', parent: 'root', primitive: 'cylinder', material: 'red-lacquer', count: 20, instanceScale: [0.34, 2.75, 0.34], placement: { mode: 'rectangular-perimeter', axis: [0, 1, 0], radius: 10.3, startAngleDeg: 0 }, buildsGeometry: true, geometry: { head: 'round timber post' }, distributionRule: 'Rectangular gallery post rhythm.' },
  { id: 'third-storey-columns', level: 'meso', parent: 'root', primitive: 'cylinder', material: 'red-lacquer', count: 16, instanceScale: [0.3, 2.35, 0.3], placement: { mode: 'rectangular-perimeter', axis: [0, 1, 0], radius: 7.9, startAngleDeg: 0 }, buildsGeometry: true, geometry: { head: 'round timber post' }, distributionRule: 'Compact upper post rhythm.' },
  { id: 'dougong-levels', level: 'meso', parent: 'root', primitive: 'box', material: 'dark-timber', count: 44, instanceScale: [0.5, 0.24, 0.34], placement: { mode: 'rectangular-perimeter', axis: [0, 1, 0], radius: 13.4, startAngleDeg: 0 }, buildsGeometry: true, geometry: { module: 'simplified stepped bracket' }, distributionRule: 'Dense repeated shadow band below each eave; split per storey in structural pass.' },
  { id: 'balcony-lattice-bays', level: 'micro', parent: 'second-floor-gallery', primitive: 'box', material: 'dark-timber', count: 48, instanceScale: [0.08, 0.72, 0.08], placement: { mode: 'rectangular-perimeter', axis: [0, 1, 0], radius: 11.6, startAngleDeg: 0 }, buildsGeometry: true, geometry: { module: 'vertical lattice member' }, distributionRule: 'Even bay rhythm around all four gallery faces.' },
  { id: 'roof-tile-rows', level: 'micro', parent: 'root', primitive: 'cylinder', material: 'glazed-tile', count: 96, instanceScale: [0.07, 1.1, 0.07], placement: { mode: 'roof-row-field', axis: [0, 1, 0], radius: 13, startAngleDeg: 0 }, buildsGeometry: true, geometry: { module: 'half-round tile ridge' }, distributionRule: 'Parallel rows per roof slope; exact count adapts by LOD.' },
];

spec.featureReviewTargets = [
  { id: 'three-eave-silhouette', name: 'Three separated swept-eave silhouette', tier: 'critical', passIds: ['blockout'], minimumScore: 0.8, mustPass: true, componentRefs: ['lower-eave', 'middle-eave', 'helmet-roof'], evidenceRefs: ['full-object', 'official-aerial'] },
  { id: 'helmet-roof-profile', name: 'Helmet roof depressed centre and rising corners', tier: 'critical', passIds: ['blockout', 'form-refinement'], minimumScore: 0.8, mustPass: true, componentRefs: ['helmet-roof', 'roof-finial'], evidenceRefs: ['full-object', 'official-main'] },
  { id: 'rectangular-massing', name: 'Rectangular footprint and mild storey taper', tier: 'critical', passIds: ['blockout'], minimumScore: 0.8, mustPass: true, componentRefs: ['granite-base', 'storey-one', 'storey-two', 'storey-three'], evidenceRefs: ['official-building-data', 'hunan-aerial'] },
  { id: 'timber-post-beam-system', name: 'Timber post, beam and bracket hierarchy', tier: 'critical', passIds: ['structural-pass'], minimumScore: 0.78, mustPass: true, componentRefs: ['beam-band-one', 'beam-band-two', 'beam-band-three'], evidenceRefs: ['full-object'] },
  { id: 'second-storey-gallery', name: 'Projecting second-storey gallery and railing rhythm', tier: 'critical', passIds: ['structural-pass', 'form-refinement'], minimumScore: 0.78, mustPass: true, componentRefs: ['second-floor-gallery', 'railing-front', 'railing-back', 'railing-left', 'railing-right'], evidenceRefs: ['full-object', 'official-aerial'] },
  { id: 'tile-timber-material-separation', name: 'Yellow tile, dark timber, red lacquer and stone separation', tier: 'critical', passIds: ['material-pass', 'surface-pass'], minimumScore: 0.75, mustPass: true, componentRefs: ['lower-eave', 'storey-one', 'granite-base'], evidenceRefs: ['full-object', 'official-main'] },
];

spec.qualityTargets.reviewViewpoints = ['reference-three-quarter', 'front', 'right-side', 'rear', 'top-oblique'];
spec.performanceBudget = { qualityPriority: 'reference-fidelity-with-realtime-budget', targetTriangles: 180000, maxDrawCalls: 45, textureSize: 1024, fpsTarget: 60, optimizationPolicy: 'Instance repeated columns, brackets, railings and tiles; protect the three-eave and helmet-roof silhouettes.' };
spec.lightingFromPhoto = [
  'key light: warm directional sun from upper camera-left, intensity 2.4, soft shadow radius 3',
  'fill light: cool sky hemisphere, intensity 0.85, keeps dark timber above black clipping',
  'rim/environment light: blue-sky environment plus subtle rear rim; ACES Filmic tone mapping, exposure 1.05, pale-sky background, contact shadow on neutral ground plane',
];
spec.risks = [
  'The generic img2threejs generator supports radial instance placement only; rectangular-perimeter systems must be custom-authored before structural-pass acceptance.',
  'The blockout helmet roof is a depth extrusion. It preserves the primary-view profile but is not yet a two-axis continuous helmet shell.',
  'Reference PBR evidence contains crop contamination and must not be bound as production texture before material-pass crop review.',
  'Exact hidden/rear details remain inferred and must never be described as measured.',
];

for (const pass of spec.buildPasses) {
  pass.componentRefs = pass.id === 'blockout'
    ? ['root', 'granite-base', 'storey-one', 'lower-eave', 'storey-two', 'middle-eave', 'storey-three', 'helmet-roof', 'roof-finial']
    : spec.componentTree.map(item => item.id);
}

fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
console.log(`Configured ${spec.componentTree.length} components, ${spec.materials.length} materials and ${spec.repetitionSystems.length} repetition systems.`);

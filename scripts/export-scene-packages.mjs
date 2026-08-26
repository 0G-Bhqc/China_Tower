import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const blender = process.env.BLENDER_EXECUTABLE || 'D:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const configPath = path.join(root, 'pipeline', 'blender', 'scene-package-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

for (const [id, packageConfig] of Object.entries(config.packages)) {
  const outputPath = path.join(root, packageConfig.outputGlb);
  const reportPath = path.join(root, packageConfig.report);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const args = [
    '--background', '--factory-startup',
    '--python', path.join(root, 'pipeline', 'blender', 'export_scene_package.py'), '--',
    path.join(root, packageConfig.sourceFbx),
    outputPath,
    reportPath,
    configPath,
    id,
  ];
  console.log(`[scene-package] exporting ${id}`);
  execFileSync(blender, args, { cwd: root, stdio: 'inherit', windowsHide: true });
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const workspace = resolve(import.meta.dirname, '..');
const assetId = process.argv.at(process.argv.indexOf('--asset') + 1);
if (assetId !== 'yueyang') throw new Error('This evidence runner currently supports --asset yueyang.');
const blender = 'D:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
if (!existsSync(blender)) throw new Error('Blender 5.2 executable was not found.');
const jobRoot = resolve(workspace, 'evidence/3d-assets/jobs/yueyang');
const command = ['--background', '--factory-startup', '--python', resolve(workspace, 'pipeline/blender/render_fbx_evidence.py'), '--', '--input', resolve(jobRoot, 'outputs/full-scene.fbx'), '--output', resolve(jobRoot, 'blender-analysis')];
const child = spawn(blender, command, { cwd: workspace, stdio: 'inherit', shell: false });
child.once('error', (error) => { throw error; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });

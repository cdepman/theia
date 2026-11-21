// Runs the local API server and Vite together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const run = (name, args) => {
  const child = spawn('npm', ['run', name, ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    for (const other of children) if (other !== child) other.kill();
    process.exit(code ?? 0);
  });
  return child;
};
const children = [run('dev:api', []), run('dev:web', [])];
process.on('SIGINT', () => children.forEach((c) => c.kill('SIGINT')));

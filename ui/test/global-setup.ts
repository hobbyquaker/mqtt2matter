/* Starts the stack (serve.ts) as a child process, waits for its port, and hands the base URL to the
   tests through the environment; the teardown stops the child by the pid it recorded. */

import {type ChildProcess, spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export default async function globalSetup(): Promise<() => Promise<void>> {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'serve.ts');
    const child: ChildProcess = spawn(process.execPath, [script], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {...process.env, UI_SERVE_STDIN: '1'},
    });
    const port = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const match = /PORT (\d+)/.exec(buffer);
            if (match !== null) {
                resolve(Number(match[1]));
            }
        });
        child.once('exit', (code) => {
            reject(new Error(`the stack exited with ${code ?? 'a signal'} before it listened`));
        });
        setTimeout(() => {
            reject(new Error('the stack did not listen within 60 s'));
        }, 60_000);
    });
    process.env.M2M_BASE_URL = `http://127.0.0.1:${port}`;
    return async () => {
        await new Promise<void>((resolve) => {
            child.once('exit', () => {
                resolve();
            });
            child.kill('SIGTERM');
            setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 10_000);
        });
    };
}

import { parentPort, workerData } from 'worker_threads';
import { scanner, configure } from './scanner';

configure(workerData ?? {});
parentPort!.on('message', ({ id, method, args }) => {
    try {
        if (!Object.prototype.hasOwnProperty.call(scanner, method)) { throw new Error('Unknown scan operation'); }
        const result = (scanner[method] as Function)(...args);
        parentPort!.postMessage({ id, result });
    } catch (error) {
        parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
});

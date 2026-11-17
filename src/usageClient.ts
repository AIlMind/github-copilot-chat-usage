import * as path from 'path';
import { Worker } from 'worker_threads';
import type { DiscoveryOptions } from './discovery';
import type { Scanner } from './scanner';

/** Persistent worker preserves parser caches without blocking VS Code's extension host. */
export class UsageClient {
    private worker?: Worker;
    private nextId = 0;
    private disposed = false;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    private inFlight = new Map<string, Promise<any>>();
    constructor(private options: DiscoveryOptions = {}) {}

    private start(): Worker {
        if (this.disposed) { throw new Error('Usage scanner is disposed'); }
        if (this.worker) { return this.worker; }
        const worker = this.worker = new Worker(path.join(__dirname, 'usageWorker.js'), { workerData: this.options });
        worker.on('message', ({ id, result, error }) => {
            const request = this.pending.get(id);
            this.pending.delete(id);
            if (error) { request?.reject(new Error(error)); } else { request?.resolve(result); }
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) { return; }
            this.worker = undefined;
            for (const request of this.pending.values()) { request.reject(error); }
            this.pending.clear();
            this.inFlight.clear();
        };
        worker.on('error', fail);
        worker.on('exit', code => fail(new Error(`Usage scanner stopped (${code})`)));
        return worker;
    }

    request<K extends keyof Scanner>(method: K, ...args: Parameters<Scanner[K]>): Promise<ReturnType<Scanner[K]>> {
        if (method === 'configure') { this.options = args[0] as DiscoveryOptions; }
        const key = JSON.stringify([method, args]);
        const existing = this.inFlight.get(key);
        if (existing) { return existing; }
        const promise = new Promise<any>((resolve, reject) => {
            const worker = this.start();
            const id = ++this.nextId;
            this.pending.set(id, { resolve, reject });
            try { worker.postMessage({ id, method, args }); }
            catch (error) { this.pending.delete(id); reject(error); }
        });
        this.inFlight.set(key, promise);
        const cleanup = () => { if (this.inFlight.get(key) === promise) { this.inFlight.delete(key); } };
        promise.then(cleanup, cleanup);
        return promise;
    }

    dispose(): void {
        this.disposed = true;
        for (const request of this.pending.values()) { request.reject(new Error('Usage scanner is disposed')); }
        this.pending.clear();
        this.inFlight.clear();
        const worker = this.worker;
        this.worker = undefined;
        void worker?.terminate();
    }
}

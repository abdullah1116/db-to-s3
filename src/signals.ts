import type { Subprocess } from "bun";

/**
 * SignalManager owns the abort signal and the set of spawned child processes.
 * On SIGTERM/SIGINT it aborts the pipeline and kills all registered children,
 * then exits with code 130 (128 + SIGINT).
 */
export class SignalManager {
  private controller = new AbortController();
  private children = new Set<Subprocess>();
  private _aborted = false;

  constructor() {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => this.handle(sig));
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  register(child: Subprocess): void {
    this.children.add(child);
  }

  private handle(sig: string): void {
    if (this._aborted) return;
    this._aborted = true;
    console.error(`[signals] received ${sig}, aborting backup`);
    this.controller.abort();
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        // child already exited
      }
    }
    process.exit(130);
  }
}

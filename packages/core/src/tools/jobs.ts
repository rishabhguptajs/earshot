export interface BackgroundJob {
  id: string;
  command: string;
  /** Appended to as the process runs; read by the `bash_output` tool. */
  output: string;
  exitCode: number | null;
  running: boolean;
  kill(): void;
}

/**
 * Background jobs outlive the tool call that started them, so the registry hangs
 * off the tool context rather than a module global: two sessions in one process
 * (the TUI running a subagent, say) must not see each other's jobs.
 */
export class BackgroundJobs {
  private readonly jobs = new Map<string, BackgroundJob>();
  private counter = 0;

  nextId(): string {
    this.counter += 1;
    return `bg_${this.counter}`;
  }

  add(job: BackgroundJob): void {
    this.jobs.set(job.id, job);
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()];
  }

  /** Called when a session ends: a stray dev server must not survive it. */
  killAll(): void {
    for (const job of this.jobs.values()) if (job.running) job.kill();
  }
}

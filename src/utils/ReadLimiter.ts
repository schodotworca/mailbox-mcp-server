/** Bounds expensive body reads; queued requests never hold IMAP connections. */
export class ReadLimiter {
  private active = false;
  private closed = false;
  private queue: Array<{ start: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(private maxPending = 5, private waitMs = 15000) {}

  async run<T>(read: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Email reads unavailable: service is shutting down");
    if (this.active) {
      if (this.queue.length >= this.maxPending) throw new Error("Email read queue full; try again later");
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          start: resolve, reject,
          timer: setTimeout(() => {
            const index = this.queue.indexOf(waiter);
            if (index >= 0) this.queue.splice(index, 1);
            reject(new Error("Email read queue timed out; no mailbox read was started"));
          }, this.waitMs),
        };
        this.queue.push(waiter);
      });
    } else {
      this.active = true;
    }
    try {
      if (this.closed) throw new Error("Email reads unavailable: service is shutting down");
      return await read();
    } finally {
      const next = this.queue.shift();
      if (next) { clearTimeout(next.timer); next.start(); }
      else this.active = false;
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Email reads unavailable: service is shutting down"));
    }
  }
}

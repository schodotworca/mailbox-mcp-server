export class ReadQueueError extends Error {
  constructor(public readonly code: "EMAIL_READ_BUSY" | "EMAIL_READ_QUEUE_TIMEOUT" | "EMAIL_READ_CLOSED", message: string) {
    super(message);
    this.name = "ReadQueueError";
  }
}

/** Bounds expensive body reads; queued requests never hold IMAP connections. */
export class ReadLimiter {
  private active = false;
  private closed = false;
  private queue: Array<{ start: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(private maxPending = 2, private waitMs = 45000) {}

  async run<T>(read: () => Promise<T>): Promise<T> {
    if (this.closed) throw new ReadQueueError("EMAIL_READ_CLOSED", "Email reads unavailable: service is shutting down");
    if (this.active) {
      if (this.queue.length >= this.maxPending) throw new ReadQueueError("EMAIL_READ_BUSY", "Email read queue full: one active read and two waiting requests. No mailbox read was started for this request. Submit remaining reads sequentially.");
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          start: resolve, reject,
          timer: setTimeout(() => {
            const index = this.queue.indexOf(waiter);
            if (index >= 0) this.queue.splice(index, 1);
            reject(new ReadQueueError("EMAIL_READ_QUEUE_TIMEOUT", `Email read queue timed out after ${this.waitMs}ms; no mailbox read was started for this request. Try this read again after pending reads finish.`));
          }, this.waitMs),
        };
        this.queue.push(waiter);
      });
    } else {
      this.active = true;
    }
    try {
      if (this.closed) throw new ReadQueueError("EMAIL_READ_CLOSED", "Email reads unavailable: service is shutting down");
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
      waiter.reject(new ReadQueueError("EMAIL_READ_CLOSED", "Email reads unavailable: service is shutting down"));
    }
  }
}

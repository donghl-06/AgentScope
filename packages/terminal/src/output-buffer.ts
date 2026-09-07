export interface TerminalOutputOptions {
  maxBytes?: number;
  maxChunks?: number;
}

export interface TerminalOutputStats {
  queuedBytes: number;
  queuedChunks: number;
  droppedBytes: number;
  droppedChunks: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHUNKS = 2048;

/**
 * A bounded, non-blocking async queue for raw terminal chunks.
 * Chunks are never split, so a multi-byte UTF-8 character cannot be cut in half.
 */
export class TerminalOutputBuffer implements AsyncIterable<string> {
  private readonly maxBytes: number;
  private readonly maxChunks: number;
  private readonly chunks: string[] = [];
  private queuedBytes = 0;
  private droppedBytes = 0;
  private droppedChunks = 0;
  private closed = false;
  private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];

  constructor(options: TerminalOutputOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('maxBytes must be a positive integer');
    }
    if (!Number.isInteger(this.maxChunks) || this.maxChunks <= 0) {
      throw new Error('maxChunks must be a positive integer');
    }
  }

  get stats(): TerminalOutputStats {
    return {
      queuedBytes: this.queuedBytes,
      queuedChunks: this.chunks.length,
      droppedBytes: this.droppedBytes,
      droppedChunks: this.droppedChunks,
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(chunk: string): boolean {
    if (this.closed || chunk.length === 0) return false;
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (bytes > this.maxBytes) {
      this.droppedBytes += bytes;
      this.droppedChunks += 1;
      return false;
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: chunk });
      return true;
    }

    while (this.chunks.length >= this.maxChunks || this.queuedBytes + bytes > this.maxBytes) {
      const evicted = this.chunks.shift();
      if (evicted === undefined) break;
      this.queuedBytes -= Buffer.byteLength(evicted, 'utf8');
      this.droppedBytes += Buffer.byteLength(evicted, 'utf8');
      this.droppedChunks += 1;
    }

    this.chunks.push(chunk);
    this.queuedBytes += bytes;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  async next(): Promise<IteratorResult<string>> {
    const chunk = this.chunks.shift();
    if (chunk !== undefined) {
      this.queuedBytes -= Buffer.byteLength(chunk, 'utf8');
      return { done: false, value: chunk };
    }
    if (this.closed) return { done: true, value: undefined };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    return this;
  }
}

/**
 * @file In-memory fakes for the ceremony injection seam.
 *   Each ceremony function takes a `CeremonyDeps` struct (see
 *   src/ceremony-deps.mts). Production wires the struct to real
 *   fetch / readline / crypto; tests build fakes:
 *
 *   - `FakeEnv` — Map-backed env-var store. Supports the same four verbs the
 *     production EnvClient does. Tests inspect the internal map between calls.
 *   - `FakeAdmin` — scripted responses for keyAudit + rewrap, plus hooks for
 *     tests that want to model row state evolving across calls.
 *   - `FakeIo` — pre-loaded share queue + captured stdout array. The factory
 *     `makeDeps()` returns all three plus a deterministic randomWrappingKey,
 *     ready to pass to a ceremony function.
 */

import type {
  AdminClient,
  CeremonyDeps,
  EnvClient,
  IoChannel,
  KeyAuditResponse,
  RewrapRequest,
  RewrapResponse,
} from '../../src/ceremony-deps.mts'

/* ------------------------------------------------------------------ */
/*  FakeEnv                                                             */
/* ------------------------------------------------------------------ */

export class FakeEnv implements EnvClient {
  readonly store: Map<string, string>

  constructor(initial: Record<string, string> = {}) {
    this.store = new Map(Object.entries(initial))
  }

  async getEnvVar(key: string): Promise<string | undefined> {
    return this.store.get(key)
  }

  async setEnvVar(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async deleteEnvVar(key: string): Promise<boolean> {
    if (!this.store.has(key)) {
      return false
    }
    this.store.delete(key)
    return true
  }

  async listEnvVarNames(): Promise<string[]> {
    return [...this.store.keys()]
  }
}

/* ------------------------------------------------------------------ */
/*  FakeAdmin                                                           */
/* ------------------------------------------------------------------ */

/**
 * Scripted admin client. Tests configure either:
 * - a fixed `keyAudit` response, OR
 * - a function that recomputes the response on each call (so
 * simulated row-counts can change as rewrap progresses)
 * Same for `rewrap` — fixed response or a closure.
 */
export class FakeAdmin implements AdminClient {
  audit: (() => KeyAuditResponse) | KeyAuditResponse
  rewrapImpl: ((req: RewrapRequest) => RewrapResponse) | RewrapResponse
  readonly auditCalls: number[] = []
  readonly rewrapCalls: RewrapRequest[] = []

  constructor(
    audit: (() => KeyAuditResponse) | KeyAuditResponse = {
      visibleGenerations: [1],
      currentGeneration: 1,
      rowCounts: {},
    },
    rewrapImpl: ((req: RewrapRequest) => RewrapResponse) | RewrapResponse = {
      rewrapped: 0,
      remaining: 0,
    },
  ) {
    this.audit = audit
    this.rewrapImpl = rewrapImpl
  }

  async keyAudit(): Promise<KeyAuditResponse> {
    this.auditCalls.push(this.auditCalls.length + 1)
    return typeof this.audit === 'function' ? this.audit() : this.audit
  }

  async rewrap(req: RewrapRequest): Promise<RewrapResponse> {
    this.rewrapCalls.push(req)
    return typeof this.rewrapImpl === 'function'
      ? this.rewrapImpl(req)
      : this.rewrapImpl
  }
}

/* ------------------------------------------------------------------ */
/*  FakeIo                                                              */
/* ------------------------------------------------------------------ */

export class FakeIo implements IoChannel {
  readonly shares: string[]
  readonly output: string[] = []

  constructor(shares: readonly string[] = []) {
    this.shares = [...shares]
  }

  async readShare(_prompt: string): Promise<string> {
    if (this.shares.length === 0) {
      throw new Error('FakeIo: no more shares queued')
    }
    return this.shares.shift()!
  }

  printLine(line: string): void {
    this.output.push(line)
  }

  /**
   * Convenience — returns the captured output as a single string.
   */
  text(): string {
    return this.output.join('\n')
  }
}

/* ------------------------------------------------------------------ */
/*  Deterministic random                                                */
/* ------------------------------------------------------------------ */

/**
 * Produce a deterministic-but-distinct 32-byte buffer per call.
 * Tests that need a specific buffer pass an explicit `Buffer`.
 * Tests that need just "any random key" use `seq()` to get
 * 0x01..0x20, then 0x21..0x40, etc.
 */
export function deterministicRandom(seed = 1): () => Buffer {
  let next = seed
  return () => {
    const out = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) {
      out[i] = (next + i) & 0xff
    }
    next = (next + 32) & 0xff
    return out
  }
}

/**
 * Return a fixed key — useful when a test wants the same Buffer
 * on every randomWrappingKey() call.
 */
export function fixedKey(byte: number): () => Buffer {
  return () => Buffer.alloc(32, byte)
}

/* ------------------------------------------------------------------ */
/*  Bundle factory                                                      */
/* ------------------------------------------------------------------ */

export type FakeBundle = CeremonyDeps & {
  env: FakeEnv
  admin: FakeAdmin
  io: FakeIo
}

export function makeDeps(
  opts: {
    envInitial?: Record<string, string> | undefined
    shares?: readonly string[] | undefined
    audit?: (() => KeyAuditResponse) | KeyAuditResponse | undefined
    rewrap?:
      | ((req: RewrapRequest) => RewrapResponse)
      | RewrapResponse
      | undefined
    randomWrappingKey?: (() => Buffer) | undefined
  } = {},
): FakeBundle {
  const env = new FakeEnv(opts.envInitial)
  const admin = new FakeAdmin(opts.audit, opts.rewrap)
  const io = new FakeIo(opts.shares ?? [])
  const random = opts.randomWrappingKey ?? deterministicRandom(0x10)
  return { env, admin, io, randomWrappingKey: random }
}

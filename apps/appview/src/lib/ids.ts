import { randomBytes } from 'node:crypto'

const B32 = '234567abcdefghijklmnopqrstuvwxyz'

/** An ATProto TID: 13 chars, sortable, monotonic within a process. */
let lastTid = 0n
export function tid(): string {
  let now = BigInt(Date.now()) * 1000n
  if (now <= lastTid) now = lastTid + 1n
  lastTid = now
  const clock = BigInt(randomBytes(1)[0]! & 0x1f)
  let n = (now << 10n) | clock
  let out = ''
  for (let i = 0; i < 13; i++) {
    out = B32[Number(n & 31n)] + out
    n >>= 5n
  }
  return out
}

/** Opaque app-side row id. Not a TID: these never reach the protocol. */
export function rowId(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Minimal lib0-compatible LEB128 varint codec for Edge runtime.
 *
 * Every integer on the y-websocket wire is an unsigned LEB128 varint;
 * every byte array and string is that varint (length) followed by raw bytes.
 */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export class Writer {
  private buf = new Uint8Array(256)
  private len = 0

  private ensure(extra: number): void {
    const needed = this.len + extra
    if (needed <= this.buf.length) return
    let cap = this.buf.length
    while (cap < needed) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  varUint(value: number): this {
    let n = value
    this.ensure(10)
    while (n > 127) {
      this.buf[this.len++] = 128 | (n % 128)
      n = Math.floor(n / 128)
    }
    this.buf[this.len++] = n % 128
    return this
  }

  varBytes(bytes: Uint8Array): this {
    this.varUint(bytes.length)
    this.ensure(bytes.length)
    this.buf.set(bytes, this.len)
    this.len += bytes.length
    return this
  }

  varString(str: string): this {
    return this.varBytes(textEncoder.encode(str))
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

export class Reader {
  private readonly bytes: Uint8Array
  private pos = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get hasMore(): boolean {
    return this.pos < this.bytes.length
  }

  byte(): number {
    if (this.pos >= this.bytes.length) throw new RangeError('unexpected end of message')
    return this.bytes[this.pos++]
  }

  varUint(): number {
    let value = 0
    let mult = 1
    for (let i = 0; i < 8; i++) {
      const b = this.byte()
      value += (b & 127) * mult
      if (b < 128) return value
      mult *= 128
    }
    throw new RangeError('varint too long')
  }

  varBytes(): Uint8Array {
    const len = this.varUint()
    if (this.pos + len > this.bytes.length) throw new RangeError('varBytes overruns message')
    const out = this.bytes.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  varString(): string {
    return textDecoder.decode(this.varBytes())
  }
}

/** Converts ArrayBuffer or ArrayBufferView to Uint8Array. */
export function toUint8Array(data: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof data === 'string') {
    return textEncoder.encode(data)
  }
  if (data instanceof Uint8Array) {
    return data
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return new Uint8Array(data)
}

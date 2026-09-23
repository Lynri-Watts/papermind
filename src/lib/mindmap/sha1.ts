/**
 * 同步 SHA-1（纯函数实现）——mermaid 无注解节点的「索引路径」确定性 ID 需要。
 *
 * 不能用 Web Crypto 的 crypto.subtle.digest（返回 Promise，会让解析器变成异步，
 * 污染整条「文本框 → parse → 校验」调用链）。输出为小写 hex，与 Python
 * hashlib.sha1(...).hexdigest() 逐字节一致（mmdParser 的跨语言契约）。
 *
 * 参考：RFC 3174。输入按 UTF-8 编码（与 Python str.encode('utf-8') 一致）。
 */

const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

function rotl(n: number, x: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** 处理一个 64 字节块（视图位于 buf 的 offset 处）。 */
function processBlock(
  h: [number, number, number, number, number],
  buf: Uint8Array,
  offset: number
): void {
  const w = new Uint32Array(80);
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) >>> 0;
  }
  for (let i = 16; i < 80; i++) {
    w[i] = rotl(1, w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]);
  }

  let [a, b, c, d, e] = h;
  for (let i = 0; i < 80; i++) {
    let f: number;
    if (i < 20) f = (b & c) | (~b & d);
    else if (i < 40) f = b ^ c ^ d;
    else if (i < 60) f = (b & c) | (b & d) | (c & d);
    else f = b ^ c ^ d;

    const temp = (rotl(5, a) + f + e + K[Math.floor(i / 20)] + w[i]) >>> 0;
    e = d;
    d = c;
    c = rotl(30, b);
    b = a;
    a = temp;
  }

  h[0] = (h[0] + a) >>> 0;
  h[1] = (h[1] + b) >>> 0;
  h[2] = (h[2] + c) >>> 0;
  h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0;
}

/** 计算 UTF-8 字符串的 SHA-1，返回 40 位小写十六进制串。 */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;

  // 填充：0x80 + 0x00... + 8 字节大端长度，使总长 ≡ 56 (mod 64) 后再加 8。
  const padCount = (56 - ((bytes.length + 1) % 64) + 64) % 64;
  const buf = new Uint8Array(bytes.length + 1 + padCount + 8);
  buf.set(bytes, 0);
  buf[bytes.length] = 0x80;
  // 长度按 64 位大端写入；长度 < 2^32 时高 4 字节保持 0。
  const lenOffset = buf.length - 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  buf[lenOffset] = (hi >>> 24) & 0xff;
  buf[lenOffset + 1] = (hi >>> 16) & 0xff;
  buf[lenOffset + 2] = (hi >>> 8) & 0xff;
  buf[lenOffset + 3] = hi & 0xff;
  buf[lenOffset + 4] = (lo >>> 24) & 0xff;
  buf[lenOffset + 5] = (lo >>> 16) & 0xff;
  buf[lenOffset + 6] = (lo >>> 8) & 0xff;
  buf[lenOffset + 7] = lo & 0xff;

  const h: [number, number, number, number, number] = [
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
  ];
  for (let offset = 0; offset < buf.length; offset += 64) {
    processBlock(h, buf, offset);
  }

  return h.map((v) => v.toString(16).padStart(8, '0')).join('');
}

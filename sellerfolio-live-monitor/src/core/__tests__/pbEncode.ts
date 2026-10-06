// Minimal protobuf encoder — TEST USE ONLY, to build decoder inputs.
function varint(n: number): number[] {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7 }
  out.push(v)
  return out
}
export function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire)
}
export function vField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)]
}
export function sField(field: number, str: string): number[] {
  const bytes = [...str].map((c) => c.charCodeAt(0))
  return [...tag(field, 2), ...varint(bytes.length), ...bytes]
}
export function mField(field: number, inner: number[]): number[] {
  return [...tag(field, 2), ...varint(inner.length), ...inner]
}
export function bytes(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat())
}

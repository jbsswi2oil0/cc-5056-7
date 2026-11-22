import type {
  IntervalSample,
  LayerId,
  LegacySegmentSample,
  PointSample,
  Rgba,
  Sample,
  SampleChain,
} from '../core/types';

/**
 * DSC1: a portable, compact container for per-pixel depth sample chains.
 *
 * Little-endian. Header:
 *   magic      char[4]  "DSC1"
 *   version    u16      = 1
 *   flags      u16      bit0 = payload is gzip-compressed
 *   width      u32
 *   height     u32
 *   layerCount u16
 *   layers     layerCount × { u16 idLen, id, u16 labelLen, label, u32 rgbHex }
 *   pixelCount u32
 *   pixels     pixelCount × { u32 sampleCount, sample[sampleCount] }
 *
 * Sample:
 *   kind       u8       0=point, 1=interval, 2=legacy-segment
 *   layerIndex u8       255 = none
 *   provenance u8       0=segmented, 1=supplemented, 2=derived, 3=legacy
 *   idLen      u16
 *   id         utf8
 *   payload    depends on kind:
 *     point     f32 z, f32 r,g,b,a
 *     interval  f32 zNear,zFar, f32 extinction rgb, f32 emission rgb
 *     legacy    f32 zNear,zFar, f32 r,g,b,a
 *
 * Float32 storage is deliberate: assets are delivery, not the in-memory working
 * set. Round-trip tolerance is documented in tests.
 */

export const DSC_MAGIC = 'DSC1';
export const DSC_VERSION = 1;

export interface DscLayer {
  id: LayerId;
  label: string;
  color: number;
}

export interface DscDocument {
  width: number;
  height: number;
  layers: DscLayer[];
  chains: SampleChain[];
  /** True when the container was gzip-compressed on disk. */
  compressed: boolean;
}

const KIND_TO_CODE = { point: 0, interval: 1, 'legacy-segment': 2 } as const;
const CODE_TO_KIND: ('point' | 'interval' | 'legacy-segment')[] = ['point', 'interval', 'legacy-segment'];
const PROV_TO_CODE: Record<string, number> = {
  segmented: 0,
  supplemented: 1,
  derived: 2,
  legacy: 3,
  'legacy-accumulated': 4,
};
const CODE_TO_PROV = ['segmented', 'supplemented', 'derived', 'legacy', 'legacy-accumulated'];

class Writer {
  private chunks: Uint8Array[] = [];
  private scratch = new ArrayBuffer(8);
  private view = new DataView(this.scratch);
  private encoder = new TextEncoder();

  u8(v: number): void {
    this.chunks.push(new Uint8Array([v & 0xff]));
  }
  u16(v: number): void {
    this.view.setUint16(0, v & 0xffff, true);
    this.chunks.push(new Uint8Array(this.scratch.slice(0, 2)));
  }
  u32(v: number): void {
    this.view.setUint32(0, v >>> 0, true);
    this.chunks.push(new Uint8Array(this.scratch.slice(0, 4)));
  }
  f32(v: number): void {
    this.view.setFloat32(0, v, true);
    this.chunks.push(new Uint8Array(this.scratch.slice(0, 4)));
  }
  bytes(b: Uint8Array): void {
    this.chunks.push(b);
  }
  string(s: string): void {
    const b = this.encoder.encode(s);
    if (b.length > 0xffff) throw new Error(`string too long for DSC1: ${b.length}`);
    this.u16(b.length);
    this.chunks.push(b);
  }
  finish(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

class Reader {
  private view: DataView;
  private off = 0;
  private decoder = new TextDecoder();
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
  string(): string {
    const len = this.u16();
    const s = this.decoder.decode(this.buf.subarray(this.off, this.off + len));
    this.off += len;
    return s;
  }
  done(): boolean {
    return this.off >= this.buf.length;
  }
}

function provenanceCode(s: Sample): number {
  const p = (s as { provenance?: string }).provenance;
  return p && p in PROV_TO_CODE ? PROV_TO_CODE[p] : 0;
}

function serializeRaw(doc: Omit<DscDocument, 'compressed'>): Uint8Array {
  const w = new Writer();
  for (const ch of DSC_MAGIC) w.u8(ch.charCodeAt(0));
  w.u16(DSC_VERSION);
  w.u16(0); // flags filled by caller for gzip; raw uses 0
  w.u32(doc.width);
  w.u32(doc.height);
  if (doc.layers.length > 0xffff) throw new Error('too many layers for DSC1');
  w.u16(doc.layers.length);
  for (const layer of doc.layers) {
    w.string(layer.id);
    w.string(layer.label);
    w.u32(layer.color >>> 0);
  }
  const pixelCount = doc.width * doc.height;
  if (doc.chains.length !== pixelCount) {
    throw new Error(`chain count ${doc.chains.length} does not match ${doc.width}x${doc.height}`);
  }
  w.u32(pixelCount);
  const layerIndex = new Map(doc.layers.map((l, i) => [l.id, i]));
  for (const chain of doc.chains) {
    if (chain.samples.length > 0xffffffff) throw new Error('too many samples in a pixel');
    w.u32(chain.samples.length);
    for (const s of chain.samples) {
      w.u8(KIND_TO_CODE[s.kind]);
      const li = s.layer !== undefined ? layerIndex.get(s.layer) : undefined;
      w.u8(li === undefined ? 0xff : li);
      w.u8(provenanceCode(s));
      w.string(s.id);
      if (s.kind === 'point') {
        w.f32(s.z);
        w.f32(s.color.r);
        w.f32(s.color.g);
        w.f32(s.color.b);
        w.f32(s.color.a);
      } else if (s.kind === 'interval') {
        w.f32(s.zNear);
        w.f32(s.zFar);
        w.f32(s.extinction.r);
        w.f32(s.extinction.g);
        w.f32(s.extinction.b);
        w.f32(s.emission.r);
        w.f32(s.emission.g);
        w.f32(s.emission.b);
      } else {
        w.f32(s.zNear);
        w.f32(s.zFar);
        w.f32(s.accumulated.r);
        w.f32(s.accumulated.g);
        w.f32(s.accumulated.b);
        w.f32(s.accumulated.a);
      }
    }
  }
  return w.finish();
}

function parseRaw(buf: Uint8Array): Omit<DscDocument, 'compressed'> {
  const r = new Reader(buf);
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(r.u8());
  if (magic !== DSC_MAGIC) throw new Error(`not a DSC1 file (magic "${magic}")`);
  const version = r.u16();
  if (version !== DSC_VERSION) throw new Error(`unsupported DSC version ${version}`);
  const flags = r.u16();
  if ((flags & 0x1) !== 0) throw new Error('gzip flag present in raw payload');
  const width = r.u32();
  const height = r.u32();
  const layerCount = r.u16();
  const layers: DscLayer[] = [];
  for (let i = 0; i < layerCount; i++) {
    const id = r.string();
    const label = r.string();
    const color = r.u32();
    layers.push({ id, label, color });
  }
  const pixelCount = r.u32();
  if (pixelCount !== width * height) {
    throw new Error(`pixel count ${pixelCount} does not match ${width}x${height}`);
  }
  const chains: SampleChain[] = new Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    const n = r.u32();
    const samples: Sample[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const kindCode = r.u8();
      const kind = CODE_TO_KIND[kindCode];
      if (!kind) throw new Error(`unknown sample kind code ${kindCode}`);
      const layerIdx = r.u8();
      const provCode = r.u8();
      const provenance = CODE_TO_PROV[provCode];
      const id = r.string();
      const layer = layerIdx === 0xff ? undefined : layers[layerIdx]?.id;
      if (layerIdx !== 0xff && !layers[layerIdx]) {
        throw new Error(`sample ${id} references missing layer index ${layerIdx}`);
      }
      if (kind === 'point') {
        const z = r.f32();
        const color: Rgba = { r: r.f32(), g: r.f32(), b: r.f32(), a: r.f32() };
        const sample: PointSample = { kind: 'point', id, z, color };
        if (layer) sample.layer = layer;
        if (provenance) sample.provenance = provenance as PointSample['provenance'];
        samples[i] = sample;
      } else if (kind === 'interval') {
        const zNear = r.f32();
        const zFar = r.f32();
        const extinction = { r: r.f32(), g: r.f32(), b: r.f32() };
        const emission = { r: r.f32(), g: r.f32(), b: r.f32() };
        const sample: IntervalSample = { kind: 'interval', id, zNear, zFar, extinction, emission };
        if (layer) sample.layer = layer;
        if (provenance) sample.provenance = provenance as IntervalSample['provenance'];
        samples[i] = sample;
      } else {
        const zNear = r.f32();
        const zFar = r.f32();
        const accumulated: Rgba = { r: r.f32(), g: r.f32(), b: r.f32(), a: r.f32() };
        const sample: LegacySegmentSample = {
          kind: 'legacy-segment',
          id,
          zNear,
          zFar,
          accumulated,
          provenance: 'legacy-accumulated',
        };
        if (layer) sample.layer = layer;
        samples[i] = sample;
      }
    }
    chains[p] = { samples };
  }
  if (!r.done()) {
    // Trailing bytes indicate a corrupt or extended file; refuse silently
    // ignoring them.
    throw new Error('DSC1 file has trailing bytes');
  }
  return { width, height, layers, chains };
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeDsc(
  doc: Omit<DscDocument, 'compressed'>,
  compress = true,
): Promise<Uint8Array> {
  const raw = serializeRaw(doc);
  if (!compress) return raw;
  const packed = await gzip(raw);
  // Mark bit0 in the flags field (offset 6..8) so readers can tell before
  // attempting decompression.
  const out = packagedWithFlag(packed);
  return out;
}

function packagedWithFlag(packed: Uint8Array): Uint8Array {
  // The gzip stream does not retain the DSC header. We wrap the compressed
  // payload in a tiny 8-byte preamble: "DSCG" + u16 version + u16 flags.
  const out = new Uint8Array(8 + packed.length);
  out[0] = 0x44; // D
  out[1] = 0x53; // S
  out[2] = 0x43; // C
  out[3] = 0x47; // G
  out[4] = DSC_VERSION & 0xff;
  out[5] = (DSC_VERSION >> 8) & 0xff;
  out[6] = 1; // gzip flag
  out[7] = 0;
  out.set(packed, 8);
  return out;
}

export async function decodeDsc(data: Uint8Array): Promise<DscDocument> {
  if (data.length >= 8 && data[0] === 0x44 && data[1] === 0x53 && data[2] === 0x43 && data[3] === 0x47) {
    const version = data[4] | (data[5] << 8);
    if (version !== DSC_VERSION) throw new Error(`unsupported DSC container version ${version}`);
    const raw = await gunzip(data.subarray(8));
    return { ...parseRaw(raw), compressed: true };
  }
  return { ...parseRaw(data), compressed: false };
}

export function chainStatistics(doc: DscDocument): {
  pixels: number;
  samples: number;
  emptyPixels: number;
  kinds: Record<string, number>;
  layers: Record<string, number>;
} {
  let samples = 0;
  let emptyPixels = 0;
  const kinds: Record<string, number> = { point: 0, interval: 0, 'legacy-segment': 0 };
  const layers: Record<string, number> = {};
  for (const chain of doc.chains) {
    if (chain.samples.length === 0) emptyPixels++;
    for (const s of chain.samples) {
      samples++;
      kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
      const key = s.layer ?? 'unassigned';
      layers[key] = (layers[key] ?? 0) + 1;
    }
  }
  return { pixels: doc.chains.length, samples, emptyPixels, kinds, layers };
}

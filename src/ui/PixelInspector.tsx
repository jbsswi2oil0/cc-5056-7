import { useMemo, useState } from 'react';
import type { ChainEvent, CompositeOptions, Sample } from '../core/types';
import { evaluatePixel } from '../core/pixel';
import { clamp01, compositeOverTransmittance, linearToSrgbByte } from '../core/color';

export interface PixelInspectorProps {
  x: number;
  y: number;
  chain: { samples: Sample[] };
  options: CompositeOptions;
  layerLabels: Record<string, string>;
  layerColors: Record<string, string>;
  background: { r: number; g: number; b: number };
}

function css(c: { r: number; g: number; b: number }): string {
  return `rgb(${linearToSrgbByte(clamp01(c.r))},${linearToSrgbByte(clamp01(c.g))},${linearToSrgbByte(clamp01(c.b))})`;
}

function swatchCss(c: { r: number; g: number; b: number; a?: number }): string {
  const a = c.a ?? 1;
  return `rgba(${Math.round(clamp01(c.r) * 255)},${Math.round(clamp01(c.g) * 255)},${Math.round(clamp01(c.b) * 255)},${clamp01(a)})`;
}

function fmt(v: number, digits = 4): string {
  return Number.isFinite(v) ? v.toFixed(digits) : String(v);
}

export function PixelInspector(props: PixelInspectorProps) {
  const { x, y, chain, options } = props;
  const evaluation = useMemo(() => evaluatePixel(chain, options), [chain, options]);
  const { result, events } = evaluation;
  const composed = compositeOverTransmittance(result.radiance, result.transmittance, props.background);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandAll, setExpandAll] = useState(false);

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // Which sources were split into multiple medium spans at a surface.
  const spanCounts = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === 'medium') {
      for (const id of ev.sourceIds) spanCounts.set(id, (spanCounts.get(id) ?? 0) + 1);
    }
  }

  return (
    <div className="inspector" data-testid="pixel-inspector">
      <div className="inspector-head">
        <div>
          <strong data-testid="inspector-coords">Pixel ({x}, {y})</strong>
          <span className="muted"> · {chain.samples.length} input samples · {events.length} events</span>
        </div>
        <div className="swatch-row">
          <span className="swatch" style={{ background: css(composed) }} data-testid="inspector-result-swatch" />
          <span className="mono muted" data-testid="inspector-result-values">
            L ({fmt(result.radiance.r, 3)}, {fmt(result.radiance.g, 3)}, {fmt(result.radiance.b, 3)}) · T (
            {fmt(result.transmittance.r, 3)}, {fmt(result.transmittance.g, 3)}, {fmt(result.transmittance.b, 3)})
          </span>
        </div>
      </div>

      {result.report.issues.length > 0 && (
        <ul className="issues">
          {result.report.issues.map((issue, i) => (
            <li key={i} className={`issue issue-${issue.code}`} data-issue-code={issue.code}>
              <span className="issue-code">{issue.code}</span> {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="inspector-toolbar">
        <button className="link" onClick={() => setExpandAll((v) => !v)}>
          {expandAll ? 'Collapse all' : 'Expand all'}
        </button>
        <span className="muted mono">
          {result.report.pieces} spans · {result.report.points} points · exact={String(result.report.exact)}
        </span>
      </div>

      <div className="event-list" data-testid="event-list">
        <div className="event-row event-header">
          <span>#</span>
          <span>event</span>
          <span>depth</span>
          <span>contribution (premultiplied)</span>
          <span>T after</span>
        </div>
        {events.map((ev, i) => {
          const isOpen = expandAll || expanded.has(i);
          return (
            <div key={i} className={`event-block ${isOpen ? 'open' : ''}`}>
              <button
                className="event-row event-main"
                data-event-kind={ev.kind}
                onClick={() => toggle(i)}
                aria-expanded={isOpen}
              >
                <span className="mono muted">{i}</span>
                <span className="event-kind">
                  <span className="kind-tag">{ev.kind}</span>
                  {ev.approximate && <span className="badge badge-warn">approx</span>}
                  {ev.merged && <span className="badge">merged</span>}
                  {ev.overlap && <span className="badge badge-overlap">overlap split</span>}
                  {ev.kind === 'medium' && ev.sourceIds.some((id) => (spanCounts.get(id) ?? 0) > 1) && (
                    <span className="badge badge-split">split</span>
                  )}
                </span>
                <span className="mono">
                  {ev.kind === 'medium' ? `[${fmt(ev.z0, 2)}, ${fmt(ev.z1, 2)})` : fmt(ev.z0, 3)}
                </span>
                <span className="contrib">
                  <span className="swatch small" style={{ background: swatchCss(ev.color ?? { ...ev.emitted, a: 1 }) }} />
                  <span className="mono">
                    +({fmt(ev.emitted.r, 3)}, {fmt(ev.emitted.g, 3)}, {fmt(ev.emitted.b, 3)})
                  </span>
                </span>
                <span className="mono">
                  ({fmt(ev.transmittanceAfter.r, 3)}, {fmt(ev.transmittanceAfter.g, 3)}, {fmt(ev.transmittanceAfter.b, 3)})
                </span>
              </button>
              {isOpen && <EventDetails ev={ev} layerLabels={props.layerLabels} layerColors={props.layerColors} />}
            </div>
          );
        })}
        {events.length === 0 && (
          <div className="empty-note" data-testid="empty-pixel-note">
            Empty pixel: transparent output, fully transmissive, no events.
          </div>
        )}
      </div>
    </div>
  );
}

function EventDetails({
  ev,
  layerLabels,
  layerColors,
}: {
  ev: ChainEvent;
  layerLabels: Record<string, string>;
  layerColors: Record<string, string>;
}) {
  return (
    <div className="event-details">
      <div className="detail-grid">
        <span className="detail-label">depth</span>
        <span className="mono">
          {ev.kind === 'medium'
            ? `near ${fmt(ev.z0, 4)} → far ${fmt(ev.z1, 4)} (length ${fmt(ev.z1 - ev.z0, 4)})`
            : `point at ${fmt(ev.z0, 4)}`}
        </span>
        <span className="detail-label">radiance before</span>
        <span className="mono">
          ({fmt(ev.radianceBefore.r)}, {fmt(ev.radianceBefore.g)}, {fmt(ev.radianceBefore.b)})
        </span>
        <span className="detail-label">radiance after</span>
        <span className="mono">
          ({fmt(ev.radianceAfter.r)}, {fmt(ev.radianceAfter.g)}, {fmt(ev.radianceAfter.b)})
        </span>
        <span className="detail-label">transmittance before</span>
        <span className="mono">
          ({fmt(ev.transmittanceBefore.r)}, {fmt(ev.transmittanceBefore.g)}, {fmt(ev.transmittanceBefore.b)})
        </span>
        <span className="detail-label">transmittance after</span>
        <span className="mono">
          ({fmt(ev.transmittanceAfter.r)}, {fmt(ev.transmittanceAfter.g)}, {fmt(ev.transmittanceAfter.b)})
        </span>
        {ev.kind === 'medium' && ev.extinction && ev.emission && (
          <>
            <span className="detail-label">Σ extinction / unit</span>
            <span className="mono">
              ({fmt(ev.extinction.r)}, {fmt(ev.extinction.g)}, {fmt(ev.extinction.b)})
            </span>
            <span className="detail-label">Σ emission / unit</span>
            <span className="mono">
              ({fmt(ev.emission.r)}, {fmt(ev.emission.g)}, {fmt(ev.emission.b)})
            </span>
            <span className="detail-label">integrated optical depth</span>
            <span className="mono">
              ({fmt(ev.extinctance.r)}, {fmt(ev.extinctance.g)}, {fmt(ev.extinctance.b)})
            </span>
          </>
        )}
        {ev.color && (
          <>
            <span className="detail-label">applied color</span>
            <span className="mono">
              premul ({fmt(ev.color.r)}, {fmt(ev.color.g)}, {fmt(ev.color.b)}) · coverage {fmt(ev.color.a, 3)}
            </span>
          </>
        )}
      </div>
      {ev.sources && ev.sources.length > 0 && (
        <div className="source-list">
          <div className="detail-label">sources on this span</div>
          {ev.sources.map((s) => (
            <div key={s.id} className="source-row" style={{ borderLeftColor: layerColors[s.id] ?? '#666' }}>
              <span className="layer-chip" style={{ borderColor: layerColors[s.id] ?? '#666' }}>
                {layerLabels[s.id] ?? s.id}
              </span>
              <span className="mono muted">
                σ=({fmt(s.extinction.r, 3)}, {fmt(s.extinction.g, 3)}, {fmt(s.extinction.b, 3)}) e=(
                {fmt(s.emission.r, 3)}, {fmt(s.emission.g, 3)}, {fmt(s.emission.b, 3)})
              </span>
            </div>
          ))}
        </div>
      )}
      {ev.kind !== 'medium' && (
        <div className="source-list">
          <div className="detail-label">applied samples</div>
          {ev.sourceIds.map((id) => (
            <div key={id} className="source-row" style={{ borderLeftColor: layerColors[id] ?? '#666' }}>
              <span className="layer-chip" style={{ borderColor: layerColors[id] ?? '#666' }}>
                {layerLabels[id] ?? id}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

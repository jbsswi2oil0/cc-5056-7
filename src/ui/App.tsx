import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompositeOptions, Rgb, SampleChain, TiePolicy } from '../core/types';
import { parseHexColor } from '../core/color';
import { SCENE_LAYERS } from '../scene/scene';
import {
  decodeToState,
  encodeState,
  makeGeneratedState,
  pixelOptions,
  runCompose,
  supplementLegacy,
  type AppState,
  type AssetKind,
  type ComposeOutcome,
  type LayerVisibility,
  type SupplementReport,
  type ViewMode,
} from '../app/state';
import { drawImage } from '../app/renderCanvas';
import { imageToPngBlob } from '../app/exportPng';
import { PixelInspector } from './PixelInspector';

const VIEW_LABELS: { id: ViewMode; label: string; hint: string }[] = [
  { id: 'color', label: 'Color', hint: 'Accumulated radiance composited over the background' },
  { id: 'transmittance', label: 'Transmittance', hint: 'Per-channel light that survives every depth event' },
  { id: 'coverage', label: 'Occlusion', hint: 'Luminance-weighted blockage: white = fully occluded' },
  { id: 'exactness', label: 'Exactness', hint: 'Green = exact, magenta = approximate legacy preview' },
];

function layerLabelMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of SCENE_LAYERS) m[l.id] = l.label;
  return m;
}

function layerColorMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const l of SCENE_LAYERS) m[l.id] = l.color;
  return m;
}

// Issue codes grouped by the physical term they threaten. Occlusion anomalies
// change how much light survives (transmittance); color anomalies change the
// radiance actually shown. Both are derived from real per-pixel reports, never
// from a default, so a misread sample cannot be hidden by a "no anomaly" state.
const OCCLUSION_ANOMALIES = new Set([
  'non-mergeable-tie',
  'tie',
  'large-tie-group',
  'overlap',
  'legacy-needs-segmentation',
]);
const COLOR_ANOMALIES = new Set([
  'straight-converted',
  'mixed-color-convention',
  'non-finite',
  'legacy-approximate',
]);

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<AppState>(() => makeGeneratedState('segmented'));
  const [view, setView] = useState<ViewMode>('color');
  const [backgroundHex, setBackgroundHex] = useState('#0b1020');
  const [tiePolicy, setTiePolicy] = useState<TiePolicy>('stable-order');
  const [allowApproximate, setAllowApproximate] = useState(false);
  const [visibility, setVisibility] = useState<LayerVisibility>({
    plate: true,
    'smoke-a': true,
    'smoke-b': true,
    slice: true,
  });
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [outcome, setOutcome] = useState<ComposeOutcome | null>(null);
  const [compareReference, setCompareReference] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [supplement, setSupplement] = useState<SupplementReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const supplementInputRef = useRef<HTMLInputElement | null>(null);

  const background: Rgb = useMemo(
    () => parseHexColor(backgroundHex) ?? { r: 0.03, g: 0.04, b: 0.08 },
    [backgroundHex],
  );
  const labels = useMemo(layerLabelMap, []);
  const colors = useMemo(layerColorMap, []);

  const options: CompositeOptions = useMemo(
    () => pixelOptions(tiePolicy, allowApproximate),
    [tiePolicy, allowApproximate],
  );

  // Compose once per input change. The drawn canvas, statistics, reference
  // comparison, and PNG export all read the same outcome.image.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const result = runCompose(state, {
        visibility,
        tiePolicy,
        allowApproximateLegacy: allowApproximate,
        referenceEnabled: compareReference,
      });
      setOutcome(result);
      drawImage(canvas, result.image, { view, background, scale: zoom });
      setBusy(false);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [state, visibility, view, background, zoom, tiePolicy, allowApproximate, compareReference]);

  const loadGenerated = useCallback((kind: AssetKind) => {
    setState(makeGeneratedState(kind));
    setAllowApproximate(false);
    setSelected(null);
    setSupplement(null);
    setToast(`Loaded generated ${kind} asset`);
  }, []);

  const onUpload = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const decoded = await decodeToState(bytes);
      setState(decoded);
      setAllowApproximate(false);
      setSelected(null);
      setSupplement(null);
      setToast(`Loaded ${file.name} (${decoded.width}×${decoded.height})`);
    } catch (err) {
      setToast(`Could not load file: ${(err as Error).message}`);
    }
  }, []);

  const onSupplement = useCallback(
    async (file: File) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const decoded = await decodeToState(bytes);
        const { state: merged, report } = supplementLegacy(state, decoded);
        setState(merged);
        setSupplement(report);
        setAllowApproximate(false);
        setSelected(null);
        setToast(
          report.complete
            ? `Replaced ${report.supplied.join(', ')} with segmented samples; exact composition restored`
            : `Supplied ${report.supplied.join(', ')}; still unresolved: ${report.unresolved.join(', ')}`,
        );
      } catch (err) {
        setToast(`Supplement failed: ${(err as Error).message}`);
      }
    },
    [state],
  );

  const downloadDsc = useCallback(async () => {
    try {
      const bytes = await encodeState(state);
      downloadBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), `${slug(state.meta.name)}.dsc`);
      setToast('Saved depth asset (.dsc)');
    } catch (err) {
      setToast(`Save failed: ${(err as Error).message}`);
    }
  }, [state]);

  const downloadPng = useCallback(async () => {
    if (!outcome) return;
    try {
      const blob = await imageToPngBlob(outcome.image, view, background);
      downloadBlob(blob, `${slug(state.meta.name)}-${view}.png`);
      setToast('Saved PNG of the current view');
    } catch (err) {
      setToast(`PNG export failed: ${(err as Error).message}`);
    }
  }, [outcome, view, background, state.meta.name]);

  const selectedChain: SampleChain | null = useMemo(() => {
    if (!selected) return null;
    const { x, y } = selected;
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
    const chain = state.chains[y * state.width + x];
    const samples = chain.samples.filter(
      (s) => !s.layer || visibility[s.layer as keyof LayerVisibility] !== false,
    );
    return { samples };
  }, [selected, state, visibility]);

  const canvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = Math.floor(((e.clientX - rect.left) / rect.width) * state.width);
      const py = Math.floor(((e.clientY - rect.top) / rect.height) * state.height);
      if (px >= 0 && py >= 0 && px < state.width && py < state.height) {
        setSelected({ x: px, y: py });
      }
    },
    [state.width, state.height],
  );

  const approximatePixels = outcome?.approximatePixels ?? 0;
  const errorMessage = outcome?.error ?? null;
  const energyOk = outcome?.energyOk ?? true;
  const referenceDiff = outcome?.difference ?? null;
  const referenceOk = referenceDiff
    ? referenceDiff.maxRadiance < 2e-3 && referenceDiff.maxTransmittance < 2e-3
    : null;

  // Anomalies that affect volumetric occlusion or the actual color, aggregated
  // from the real per-pixel integration reports (no default-value masking).
  const issueCounts = outcome?.issueCounts ?? {};
  const anomalyEntries = Object.entries(issueCounts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const occlusionAnomalies = anomalyEntries.filter(([code]) => OCCLUSION_ANOMALIES.has(code));
  const colorAnomalies = anomalyEntries.filter(([code]) => COLOR_ANOMALIES.has(code));
  const otherAnomalies = anomalyEntries.filter(
    ([code]) => !OCCLUSION_ANOMALIES.has(code) && !COLOR_ANOMALIES.has(code),
  );
  const hasAnomaly = anomalyEntries.length > 0 || !!outcome?.errorCode;

  const anomalyClass = (code: string): string =>
    OCCLUSION_ANOMALIES.has(code)
      ? 'anomaly-occlusion'
      : COLOR_ANOMALIES.has(code)
        ? 'anomaly-color'
        : 'anomaly-other';

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <h1>Depth Composite</h1>
          <span className="subtitle">
            Per-pixel sample chains · point &amp; interval samples · exact depth interleaving
          </span>
        </div>
        <div className="topbar-actions">
          <button onClick={() => loadGenerated('segmented')} data-testid="load-segmented">
            Segmented asset
          </button>
          <button onClick={() => loadGenerated('legacy')} data-testid="load-legacy">
            Legacy asset
          </button>
          <button onClick={() => fileInputRef.current?.click()} data-testid="open-file">
            Open .dsc…
          </button>
          <button
            onClick={() => supplementInputRef.current?.click()}
            data-testid="supplement-file"
            title="Replace legacy whole-segment samples with segmented samples from another .dsc"
          >
            Supply segmented…
          </button>
          <button onClick={downloadDsc} data-testid="save-dsc">
            Save .dsc
          </button>
          <button onClick={downloadPng} data-testid="save-png" disabled={!outcome || !!errorMessage}>
            {approximatePixels > 0 ? 'Export approximate PNG' : 'Export PNG'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dsc,application/octet-stream"
            hidden
            data-testid="file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
              e.target.value = '';
            }}
          />
          <input
            ref={supplementInputRef}
            type="file"
            accept=".dsc,application/octet-stream"
            hidden
            data-testid="supplement-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onSupplement(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      <main className="layout">
        <aside className="panel controls">
          <section>
            <h2>Asset</h2>
            <div className="asset-card" data-testid="asset-card">
              <div className="asset-name" data-testid="asset-name">{state.meta.name}</div>
              <div className="muted mono">
                {state.width}×{state.height} · {state.meta.kind} · {state.meta.source}
              </div>
            </div>
            <div className="field">
              <span>View</span>
              <div className="segmented" data-testid="view-switcher">
                {VIEW_LABELS.map((v) => (
                  <button
                    key={v.id}
                    className={view === v.id ? 'active' : ''}
                    title={v.hint}
                    onClick={() => setView(v.id)}
                    data-testid={`view-${v.id}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Background</span>
              <input
                type="color"
                value={backgroundHex}
                onChange={(e) => setBackgroundHex(e.target.value)}
                data-testid="background-input"
              />
            </label>
            <label className="field">
              <span>Zoom ×{zoom}</span>
              <input
                type="range"
                min={1}
                max={4}
                step={1}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                data-testid="zoom-input"
              />
            </label>
          </section>

          <section>
            <h2>Depth layers</h2>
            <div className="layer-list">
              {SCENE_LAYERS.map((l) => (
                <label key={l.id} className="layer-toggle" title={l.description} data-testid={`layer-${l.id}`}>
                  <input
                    type="checkbox"
                    checked={visibility[l.id as keyof LayerVisibility] !== false}
                    onChange={(e) => setVisibility((prev) => ({ ...prev, [l.id]: e.target.checked }))}
                    data-testid={`layer-toggle-${l.id}`}
                  />
                  <span className="layer-dot" style={{ background: l.color }} />
                  <span className="layer-text">
                    <span>{l.label}</span>
                    <span className="muted small">{l.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <h2>Coincident samples</h2>
            <label className="field">
              <span>Tie policy</span>
              <select
                value={tiePolicy}
                onChange={(e) => setTiePolicy(e.target.value as TiePolicy)}
                data-testid="tie-policy"
              >
                <option value="stable-order">stable order</option>
                <option value="exchangeable-merge">exchangeable merge (average)</option>
              </select>
            </label>
            <p className="hint">
              Stable order composites coincident points in input order and is reproducible. Exchangeable merge averages them so input
              order cannot change the result; that result is marked approximate.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={allowApproximate}
                onChange={(e) => setAllowApproximate(e.target.checked)}
                data-testid="allow-approx"
              />
              <span>Allow approximate legacy preview</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={compareReference}
                onChange={(e) => setCompareReference(e.target.checked)}
                data-testid="compare-reference"
              />
              <span>Compare against ray-marched reference</span>
            </label>
          </section>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-frame">
            <canvas
              ref={canvasRef}
              onClick={canvasClick}
              data-testid="composite-canvas"
              aria-label="Composited depth image"
            />
            {busy && <div className="busy" data-testid="busy">composing…</div>}
          </div>
          <div className="canvas-caption">
            <span className="muted">
              Click the canvas to inspect a pixel's sample chain. View: <strong data-testid="current-view">{view}</strong>
              {selected && (
                <>
                  {' '}· selected ({selected.x}, {selected.y})
                </>
              )}
            </span>
            <span className="muted mono">scale ×{zoom}</span>
          </div>
        </section>

        <aside className="panel status">
          <section>
            <h2>Result</h2>
            <div className="stat-grid" data-testid="result-stats">
              <span>Approximate pixels</span>
              <strong className={approximatePixels > 0 ? 'warn' : 'ok'} data-testid="approx-pixels">
                {approximatePixels}
              </strong>
              <span>Exact result</span>
              <strong className={outcome?.exact ? 'ok' : 'warn'} data-testid="exact-flag">
                {outcome ? String(outcome.exact) : '—'}
              </strong>
              <span>Energy check</span>
              <strong className={energyOk ? 'ok' : 'bad'} data-testid="energy-check">
                {energyOk ? 'ok' : 'failed'}
              </strong>
            </div>
            <div
              className={`anomaly-banner ${hasAnomaly ? 'anomaly-banner-warn' : 'anomaly-banner-ok'}`}
              data-testid="anomaly-banner"
              data-has-anomaly={String(hasAnomaly)}
            >
              <strong data-testid="anomaly-status">
                {hasAnomaly ? 'runtime anomalies flagged' : 'runtime status: clean'}
              </strong>
              <div className="anomaly-metrics muted mono" data-testid="anomaly-metrics">
                nonMergeableTies={outcome?.nonMergeableTies ?? 0} · straightConverted=
                {outcome?.straightConverted ?? 0} · mixedConventionPixels=
                {outcome?.mixedConventionPixels ?? 0}
              </div>
              {outcome?.errorCode && (
                <div className="anomaly-group anomaly-color" data-testid="anomaly-error">
                  <span className="anomaly-group-label">fatal:</span>
                  <span className="anomaly-code">{outcome.errorCode}</span>
                </div>
              )}
              {occlusionAnomalies.length > 0 && (
                <div className="anomaly-group anomaly-occlusion" data-testid="anomaly-occlusion">
                  <span className="anomaly-group-label">volumetric occlusion:</span>
                  {occlusionAnomalies.map(([code, n]) => (
                    <span key={code} className="anomaly-code" data-issue-code={code}>
                      {code}×{n}
                    </span>
                  ))}
                </div>
              )}
              {colorAnomalies.length > 0 && (
                <div className="anomaly-group anomaly-color" data-testid="anomaly-color">
                  <span className="anomaly-group-label">actual color:</span>
                  {colorAnomalies.map(([code, n]) => (
                    <span key={code} className="anomaly-code" data-issue-code={code}>
                      {code}×{n}
                    </span>
                  ))}
                </div>
              )}
              {otherAnomalies.length > 0 && (
                <div className="anomaly-group anomaly-other" data-testid="anomaly-other">
                  <span className="anomaly-group-label">other:</span>
                  {otherAnomalies.map(([code, n]) => (
                    <span key={code} className={`anomaly-code ${anomalyClass(code)}`} data-issue-code={code}>
                      {code}×{n}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {errorMessage && (
              <div className="alert" data-testid="compose-error">
                <strong>{outcome?.errorCode ?? 'error'}</strong>
                <p>{errorMessage}</p>
              </div>
            )}
            {!errorMessage && approximatePixels > 0 && (
              <div className="alert alert-warn" data-testid="approx-warning">
                <strong>Approximate preview</strong>
                <p>
                  This legacy asset stores only whole-segment accumulated colors, which cannot be split exactly at the red slice. The
                  canvas shows a marked approximation. Use <em>Supply segmented…</em> to replace the legacy segments with real
                  per-sample data; exact export then becomes available.
                </p>
              </div>
            )}
            {supplement && (
              <div className="alert alert-info" data-testid="supplement-report">
                <strong>{supplement.complete ? 'Segmented samples supplied' : 'Partially supplied'}</strong>
                <p>
                  Replaced layers: {supplement.supplied.length > 0 ? supplement.supplied.join(', ') : 'none'}
                  {!supplement.complete && <> · unresolved: {supplement.unresolved.join(', ')}</>}
                </p>
              </div>
            )}
            {referenceDiff && (
              <div className="reference" data-testid="reference-block">
                <div className="reference-head">
                  <strong>Ray-marched reference</strong>
                  <span className={referenceOk ? 'ok' : 'bad'} data-testid="reference-verdict">
                    {referenceOk ? 'match' : 'mismatch'}
                  </span>
                </div>
                <div className="stat-grid small">
                  <span>max radiance Δ</span>
                  <strong className="mono">{referenceDiff.maxRadiance.toExponential(2)}</strong>
                  <span>mean radiance Δ</span>
                  <strong className="mono">{referenceDiff.meanRadiance.toExponential(2)}</strong>
                  <span>max transmittance Δ</span>
                  <strong className="mono">{referenceDiff.maxTransmittance.toExponential(2)}</strong>
                </div>
              </div>
            )}
          </section>
        </aside>

        <section className="panel inspector-panel">
          <h2>Single-pixel sample chain</h2>
          {selectedChain && selected ? (
            <PixelInspector
              x={selected.x}
              y={selected.y}
              chain={selectedChain}
              options={options}
              layerLabels={labels}
              layerColors={colors}
              background={background}
            />
          ) : (
            <p className="muted" data-testid="inspector-empty">
              Click a pixel on the canvas to expand its ordered samples, split spans, and transmittance state.
            </p>
          )}
        </section>
      </main>

      {toast && (
        <div className="toast" data-testid="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'depth-asset'
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

import { normalizeCurve, simplifyPoints } from '../engine/curve';
import type { Curve, LaneId, Point } from '../engine/types';
import { clamp } from '../engine/util';

export interface LaneSpec {
  id: LaneId;
  label: string;
  hint: string;
  /** CSS custom property holding this lane's colour. */
  colorVar: string;
  /** Hard limits for values in this lane. */
  domain: [number, number];
  height: number;
  format(v: number): string;
  /** Horizontal grid lines for a visible range. */
  grid(lo: number, hi: number): { v: number; label?: string; strong?: boolean }[];
  /** Whether to fill the area under the curve. */
  fill: boolean;
}

export interface LaneHost {
  getCurve(): Curve;
  /** Called continuously while editing (commit=false) and once at the end (commit=true). */
  setCurve(curve: Curve, commit: boolean): void;
  getDuration(): number;
  /** Dense measured series from the recording, drawn faintly behind the curve. */
  getGhost(): Float32Array | null;
  /** Optional "as heard" series (e.g. pitch after transpose), drawn dashed. */
  getOverlay(): Float32Array | null;
  /** Visible value range; lanes with a fixed domain return it unchanged. */
  getViewRange(): [number, number];
}

const PAD_X = 10;
const PAD_Y = 8;

function niceTimeStep(duration: number): number {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2];
  for (const s of steps) if (duration / s <= 10) return s;
  return 2;
}

/**
 * Canvas editor for one breakpoint lane. Drag points to move them, drag on
 * empty space to draw freehand, double-click to add or remove a point.
 */
export class LaneEditor {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly readout: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height: number;
  private hover = -1;
  private hoverPos: { t: number; v: number } | null = null;
  private drag: { mode: 'point'; index: number } | { mode: 'draw'; base: Curve; stroke: Point[] } | null = null;
  private frozenRange: [number, number] | null = null;
  private playhead: number | null = null;
  private colors = { line: '#fff', grid: 'rgba(255,255,255,.08)', gridStrong: 'rgba(255,255,255,.18)', text: '#888', ghost: 'rgba(255,255,255,.25)', play: '#fff' };

  constructor(
    readonly spec: LaneSpec,
    private readonly host: LaneHost,
  ) {
    this.height = spec.height;
    this.readout = document.createElement('span');
    this.readout.className = 'lane-readout';
    const head = document.createElement('div');
    head.className = 'lane-head';
    const label = document.createElement('span');
    label.className = 'lane-label';
    label.textContent = spec.label;
    label.style.setProperty('--lane', `var(${spec.colorVar})`);
    const hint = document.createElement('span');
    hint.className = 'lane-hint';
    hint.textContent = spec.hint;
    head.append(label, hint, this.readout);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lane-canvas';
    this.canvas.style.height = `${this.height}px`;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', `${spec.label} lane editor. Drag points, draw freehand, double-click to add or remove points.`);
    this.canvas.dataset.lane = spec.id;
    this.el = document.createElement('div');
    this.el.className = 'lane';
    this.el.dataset.lane = spec.id;
    this.el.append(head, this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hover = -1;
        this.hoverPos = null;
        this.updateReadout();
        this.draw();
      }
    });
    this.canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    this.canvas.addEventListener('contextmenu', (e) => {
      const i = this.hitPoint(e);
      if (i > 0 && i < this.host.getCurve().length - 1) {
        e.preventDefault();
        this.removePoint(i);
      }
    });

    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  /** Re-reads theme colours (call after a theme change). */
  refreshColors(): void {
    const cs = getComputedStyle(this.el);
    const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
    this.colors = {
      line: v(this.spec.colorVar, '#fff'),
      grid: v('--grid', 'rgba(255,255,255,.07)'),
      gridStrong: v('--grid-strong', 'rgba(255,255,255,.16)'),
      text: v('--text-faint', '#888'),
      ghost: v('--ghost', 'rgba(255,255,255,.25)'),
      play: v('--playhead', '#fff'),
    };
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = rect.width;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.refreshColors();
    this.draw();
  }

  setPlayhead(t: number | null): void {
    if (t === this.playhead) return;
    this.playhead = t;
    this.draw();
  }

  private range(): [number, number] {
    return this.frozenRange ?? this.host.getViewRange();
  }

  private toX(t: number): number {
    return PAD_X + t * (this.width - 2 * PAD_X);
  }
  private toY(v: number, r: [number, number]): number {
    const [lo, hi] = r;
    return PAD_Y + (1 - (v - lo) / (hi - lo || 1)) * (this.height - 2 * PAD_Y);
  }
  private fromEvent(e: PointerEvent | MouseEvent): { t: number; v: number; x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const [lo, hi] = this.range();
    const t = clamp((x - PAD_X) / (this.width - 2 * PAD_X), 0, 1);
    const v = clamp(lo + (1 - (y - PAD_Y) / (this.height - 2 * PAD_Y)) * (hi - lo), this.spec.domain[0], this.spec.domain[1]);
    return { t, v, x, y };
  }

  private hitPoint(e: PointerEvent | MouseEvent): number {
    const { x, y } = this.fromEvent(e);
    const curve = this.host.getCurve();
    const r = this.range();
    const radius = (e as PointerEvent).pointerType === 'touch' ? 20 : 11;
    let best = -1;
    let bestD = radius * radius;
    curve.forEach((p, i) => {
      const dx = this.toX(p.t) - x;
      const dy = this.toY(p.v, r) - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.frozenRange = this.host.getViewRange();
    const hit = this.hitPoint(e);
    if (hit >= 0) {
      this.drag = { mode: 'point', index: hit };
    } else {
      const { t, v } = this.fromEvent(e);
      this.drag = { mode: 'draw', base: this.host.getCurve().map((p) => ({ ...p })), stroke: [{ t, v }] };
    }
    this.canvas.classList.add('dragging');
  }

  private onMove(e: PointerEvent): void {
    const pos = this.fromEvent(e);
    this.hoverPos = { t: pos.t, v: pos.v };
    if (!this.drag) {
      const h = this.hitPoint(e);
      if (h !== this.hover) {
        this.hover = h;
        this.canvas.style.cursor = h >= 0 ? 'grab' : 'crosshair';
      }
      this.updateReadout();
      this.draw();
      return;
    }
    if (this.drag.mode === 'point') {
      const curve = this.host.getCurve().map((p) => ({ ...p }));
      const i = this.drag.index;
      const last = curve.length - 1;
      let t = pos.t;
      if (i === 0) t = 0;
      else if (i === last) t = 1;
      else t = clamp(t, curve[i - 1].t + 0.002, curve[i + 1].t - 0.002);
      curve[i] = { t, v: this.round(pos.v) };
      this.hover = i;
      this.host.setCurve(curve, false);
    } else {
      this.drag.stroke.push({ t: pos.t, v: pos.v });
      this.host.setCurve(this.mergeStroke(this.drag.base, this.drag.stroke, false), false);
    }
    this.updateReadout();
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    this.canvas.classList.remove('dragging');
    if (d.mode === 'point') {
      this.host.setCurve(this.host.getCurve(), true);
    } else {
      const span = Math.max(...d.stroke.map((p) => p.t)) - Math.min(...d.stroke.map((p) => p.t));
      if (d.stroke.length > 2 && span > 0.004) this.host.setCurve(this.mergeStroke(d.base, d.stroke, true), true);
      else this.host.setCurve(d.base, false);
    }
    this.frozenRange = null;
    this.draw();
  }

  private onDouble(e: MouseEvent): void {
    const hit = this.hitPoint(e);
    const curve = this.host.getCurve();
    if (hit > 0 && hit < curve.length - 1) {
      this.removePoint(hit);
      return;
    }
    if (hit >= 0) return;
    const { t, v } = this.fromEvent(e);
    const next = normalizeCurve([...curve, { t, v: this.round(v) }]);
    this.host.setCurve(next, true);
  }

  private removePoint(i: number): void {
    const curve = this.host.getCurve().filter((_, k) => k !== i);
    this.hover = -1;
    this.host.setCurve(curve, true);
  }

  private round(v: number): number {
    return this.spec.id === 'pitch' ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000;
  }

  /** Replaces the part of `base` covered by the stroke with the stroke itself. */
  private mergeStroke(base: Curve, stroke: Point[], simplify: boolean): Curve {
    const tMin = Math.min(...stroke.map((p) => p.t));
    const tMax = Math.max(...stroke.map((p) => p.t));
    // Bin the stroke by pixel column, keeping the latest value in each column.
    const cols = Math.max(2, Math.round(this.width - 2 * PAD_X));
    const bins = new Map<number, Point>();
    for (const p of stroke) bins.set(Math.round(p.t * cols), p);
    let pts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => ({ t: p.t, v: this.round(p.v) }));
    if (simplify) {
      const [lo, hi] = this.range();
      pts = simplifyPoints(pts, 0.012, hi - lo);
    }
    const outside = base.filter((p) => p.t < tMin - 1e-4 || p.t > tMax + 1e-4);
    return normalizeCurve([...outside, ...pts]);
  }

  private updateReadout(): void {
    const curve = this.host.getCurve();
    if (this.hover >= 0 && curve[this.hover]) {
      const p = curve[this.hover];
      this.readout.textContent = `${(p.t * this.host.getDuration()).toFixed(2)} s · ${this.spec.format(p.v)}`;
    } else if (this.hoverPos) {
      this.readout.textContent = `${(this.hoverPos.t * this.host.getDuration()).toFixed(2)} s · ${this.spec.format(this.hoverPos.v)}`;
    } else this.readout.textContent = '';
  }

  draw(): void {
    const ctx = this.ctx;
    const w = this.width;
    const hgt = this.height;
    if (!w) return;
    ctx.clearRect(0, 0, w, hgt);
    const r = this.range();
    const c = this.colors;

    // Time grid.
    const dur = this.host.getDuration();
    const step = niceTimeStep(dur);
    ctx.lineWidth = 1;
    for (let s = step; s < dur - 1e-6; s += step) {
      const x = Math.round(this.toX(s / dur)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
      ctx.stroke();
    }
    // Value grid.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const g of this.spec.grid(r[0], r[1])) {
      const y = Math.round(this.toY(g.v, r)) + 0.5;
      if (y < 0 || y > hgt) continue;
      ctx.strokeStyle = g.strong ? c.gridStrong : c.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (g.label) {
        ctx.fillStyle = c.text;
        ctx.fillText(g.label, 4, y - 6);
      }
    }

    // Measured ghost.
    const ghost = this.host.getGhost();
    if (ghost && ghost.length > 1) {
      ctx.strokeStyle = c.ghost;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < ghost.length; i++) {
        const v = ghost[i];
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const x = this.toX(i / (ghost.length - 1));
        const y = this.toY(v, r);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }

    const curve = this.host.getCurve();
    // Fill.
    if (this.spec.fill && curve.length) {
      const grad = ctx.createLinearGradient(0, 0, 0, hgt);
      grad.addColorStop(0, withAlpha(c.line, 0.35));
      grad.addColorStop(1, withAlpha(c.line, 0.02));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(this.toX(curve[0].t), this.toY(r[0], r));
      for (const p of curve) ctx.lineTo(this.toX(p.t), this.toY(p.v, r));
      ctx.lineTo(this.toX(curve[curve.length - 1].t), this.toY(r[0], r));
      ctx.closePath();
      ctx.fill();
    }

    // "As heard" overlay.
    const overlay = this.host.getOverlay();
    if (overlay && overlay.length > 1) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = withAlpha(c.line, 0.75);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < overlay.length; i++) {
        const x = this.toX(i / (overlay.length - 1));
        const y = this.toY(overlay[i], r);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Curve.
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    curve.forEach((p, i) => {
      const x = this.toX(p.t);
      const y = this.toY(p.v, r);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Points.
    curve.forEach((p, i) => {
      const x = this.toX(p.t);
      const y = this.toY(p.v, r);
      const active = i === this.hover || (this.drag?.mode === 'point' && this.drag.index === i);
      ctx.beginPath();
      ctx.arc(x, y, active ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? c.line : '#0000';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      if (!active) {
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = c.line;
        ctx.fill();
      }
    });

    if (this.playhead !== null && this.playhead >= 0 && this.playhead <= 1) {
      const x = Math.round(this.toX(this.playhead)) + 0.5;
      ctx.strokeStyle = c.play;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hgt);
      ctx.stroke();
    }
  }
}

/** Applies an alpha to a CSS hex (#rgb / #rrggbb) or rgb() colour. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => s.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return c;
}

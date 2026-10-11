/**
 * A tiny drawing interface with two back ends: pdf-lib (the exported PDF) and
 * SVG (the Preview tab). Every cartographic element is drawn through this, so
 * the preview is the export, not an approximation of it.
 *
 * Coordinates are PDF points, origin bottom-left, y up.
 */

import { createElement, type ReactNode } from "react";
import { rgb, degrees } from "pdf-lib";
import type { PDFPage, PDFFont, PDFImage } from "pdf-lib";
import { pdfSafe } from "./pageLayout";

export type RGB = [number, number, number];

export interface ShapeStyle {
  fill?: RGB;
  stroke?: RGB;
  lineWidth?: number;
}

export interface LineStyle {
  color: RGB;
  width: number;
  dash?: number[];
}

export interface TextStyle {
  size: number;
  color: RGB;
  bold?: boolean;
  /** Degrees counter-clockwise about (x, y). */
  rotate?: number;
}

export interface Painter {
  rect(x: number, y: number, w: number, h: number, s: ShapeStyle): void;
  line(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void;
  circle(cx: number, cy: number, r: number, s: ShapeStyle): void;
  polygon(pts: { x: number; y: number }[], s: ShapeStyle): void;
  text(text: string, x: number, y: number, s: TextStyle): void;
  image(id: string, x: number, y: number, w: number, h: number): void;
}

// ---------------------------------------------------------------------------
// PDF back end
// ---------------------------------------------------------------------------

const toPdf = (c: RGB) => rgb(c[0], c[1], c[2]);

export class PdfPainter implements Painter {
  constructor(
    private page: PDFPage,
    private font: PDFFont,
    private fontBold: PDFFont,
    private images: Record<string, PDFImage>,
  ) {}

  rect(x: number, y: number, w: number, h: number, s: ShapeStyle) {
    this.page.drawRectangle({
      x, y, width: w, height: h,
      color: s.fill ? toPdf(s.fill) : undefined,
      borderColor: s.stroke ? toPdf(s.stroke) : undefined,
      borderWidth: s.stroke ? (s.lineWidth ?? 0.5) : 0,
    });
  }

  line(x1: number, y1: number, x2: number, y2: number, s: LineStyle) {
    this.page.drawLine({
      start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      thickness: s.width, color: toPdf(s.color),
      dashArray: s.dash,
    });
  }

  circle(cx: number, cy: number, r: number, s: ShapeStyle) {
    this.page.drawCircle({
      x: cx, y: cy, size: r,
      color: s.fill ? toPdf(s.fill) : undefined,
      borderColor: s.stroke ? toPdf(s.stroke) : undefined,
      borderWidth: s.stroke ? (s.lineWidth ?? 0.5) : 0,
    });
  }

  polygon(pts: { x: number; y: number }[], s: ShapeStyle) {
    if (pts.length < 3) return;
    // drawSvgPath uses SVG coords (y down) relative to (x, y) in PDF space.
    const minX = Math.min(...pts.map((p) => p.x));
    const maxY = Math.max(...pts.map((p) => p.y));
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${(p.x - minX).toFixed(2)} ${(maxY - p.y).toFixed(2)}`)
      .join(" ") + " Z";
    this.page.drawSvgPath(d, {
      x: minX, y: maxY,
      color: s.fill ? toPdf(s.fill) : undefined,
      borderColor: s.stroke ? toPdf(s.stroke) : undefined,
      borderWidth: s.stroke ? (s.lineWidth ?? 0.3) : 0,
    });
  }

  text(text: string, x: number, y: number, s: TextStyle) {
    this.page.drawText(pdfSafe(text), {
      x, y, size: s.size,
      font: s.bold ? this.fontBold : this.font,
      color: toPdf(s.color),
      rotate: s.rotate ? degrees(s.rotate) : undefined,
    });
  }

  image(id: string, x: number, y: number, w: number, h: number) {
    const img = this.images[id];
    if (img) this.page.drawImage(img, { x, y, width: w, height: h });
  }
}

// ---------------------------------------------------------------------------
// SVG back end (React elements)
// ---------------------------------------------------------------------------

const toCss = (c: RGB) =>
  `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

const FONT_FAMILY = "Helvetica, Arial, 'Liberation Sans', sans-serif";

export class SvgPainter implements Painter {
  readonly nodes: ReactNode[] = [];
  private key = 0;

  constructor(private pageH: number, private images: Record<string, string>) {}

  private fy(y: number) { return this.pageH - y; }

  private shape(s: ShapeStyle) {
    return {
      fill: s.fill ? toCss(s.fill) : "none",
      stroke: s.stroke ? toCss(s.stroke) : undefined,
      strokeWidth: s.stroke ? (s.lineWidth ?? 0.5) : undefined,
    };
  }

  rect(x: number, y: number, w: number, h: number, s: ShapeStyle) {
    this.nodes.push(createElement("rect", {
      key: this.key++, x, y: this.fy(y + h), width: w, height: h, ...this.shape(s),
    }));
  }

  line(x1: number, y1: number, x2: number, y2: number, s: LineStyle) {
    this.nodes.push(createElement("line", {
      key: this.key++, x1, y1: this.fy(y1), x2, y2: this.fy(y2),
      stroke: toCss(s.color), strokeWidth: s.width,
      strokeDasharray: s.dash?.join(" "),
    }));
  }

  circle(cx: number, cy: number, r: number, s: ShapeStyle) {
    this.nodes.push(createElement("circle", {
      key: this.key++, cx, cy: this.fy(cy), r, ...this.shape(s),
    }));
  }

  polygon(pts: { x: number; y: number }[], s: ShapeStyle) {
    this.nodes.push(createElement("polygon", {
      key: this.key++,
      points: pts.map((p) => `${p.x},${this.fy(p.y)}`).join(" "),
      ...this.shape({ ...s, lineWidth: s.lineWidth ?? 0.3 }),
    }));
  }

  text(text: string, x: number, y: number, s: TextStyle) {
    const sy = this.fy(y);
    this.nodes.push(createElement("text", {
      key: this.key++, x, y: sy,
      fontSize: s.size, fontFamily: FONT_FAMILY,
      fontWeight: s.bold ? 700 : 400,
      fill: toCss(s.color),
      transform: s.rotate ? `rotate(${-s.rotate} ${x} ${sy})` : undefined,
      style: { whiteSpace: "pre" },
    }, pdfSafe(text)));
  }

  image(id: string, x: number, y: number, w: number, h: number) {
    const href = this.images[id];
    if (!href) return;
    this.nodes.push(createElement("image", {
      key: this.key++, href, x, y: this.fy(y + h), width: w, height: h,
      preserveAspectRatio: "none",
    }));
  }
}

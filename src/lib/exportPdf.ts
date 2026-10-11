import { PDFDocument, StandardFonts } from "pdf-lib";
import type { PDFImage } from "pdf-lib";
import { drawMapPage } from "./cartography";
import type { MapPageSpec } from "./cartography";
import { PdfPainter } from "./painter";
import { pdfSafe } from "./pageLayout";

export interface RenderedPage {
  spec: MapPageSpec;
  /** JPEG data URL from renderMapImage, keyed by spec.imageId. */
  jpegUrl: string;
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.split(",")[1] ?? "";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Builds a PDF with one page per rendered map page. Layout and drawing come
 * from pageLayout.ts / cartography.ts — the same code the Preview tab renders
 * through its SVG painter, so what the preview shows is what prints.
 */
export async function buildMapPdf(pages: RenderedPage[], title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(title));
  doc.setCreator("Hunting Map Generator");
  doc.setProducer("pdf-lib");

  const font     = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const { spec, jpegUrl } of pages) {
    const images: Record<string, PDFImage> = {};
    images[spec.imageId] = await doc.embedJpg(dataUrlBytes(jpegUrl));
    const page = doc.addPage([spec.layout.pageW, spec.layout.pageH]);
    drawMapPage(new PdfPainter(page, font, fontBold, images), spec);
  }

  return doc.save();
}

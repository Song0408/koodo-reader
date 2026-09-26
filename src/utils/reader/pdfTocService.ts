/**
 * 法学 PDF 动态目录服务层
 *
 * 复用 kookit 内置 pdf.js：rendition.getChapterDoc()[i].text 上暴露了
 * getTextContent() / getDimension() / getPage()，重活发生在 pdf.js 自带
 * worker 线程，主线程只做正则解析（毫秒级），满足不卡顿主线程的约束。
 *
 * 缓存：解析结果按「书籍 key + 文件指纹」持久化到 ConfigService，
 * 指纹不匹配（文件内容变化）时自动失效重新解析。
 */
import {
  PdfTextLine,
  PdfTocChapter,
  extractPageLines,
  parseTocFromLines,
  flattenPdfToc,
} from "./pdfTocParser";

export const PDF_TOC_CACHE_NAME = "pdfTocFallback";

/**
 * 解析器算法版本：解析/过滤逻辑变化时 +1，旧缓存自动失效重新解析
 * v1 → v2：新增印刷目次抑制（行尾页码、目次块、目次锚点、同名去重）
 */
export const PDF_TOC_PARSER_VERSION = 2;

/** 缓存条目 */
export interface PdfTocCache {
  fingerprint: string;
  version: number;
  chapters: PdfTocChapter[];
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const fnv1a = (bytes: Uint8Array, seed: number): number => {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
};

/**
 * 文件指纹：双种子 FNV-1a，采样首/中/尾各 64KB（窗口内每 64 字节取 1）
 * 注意：必须在 BookHelper.getRendition() 之前计算——
 * pdf.js 会把 ArrayBuffer transfer 到 worker 导致其 detach（byteLength 变 0）
 */
export const computePdfFingerprint = (buffer: ArrayBuffer | null): string => {
  if (!buffer || buffer.byteLength === 0) {
    return "unknown";
  }
  const view = new Uint8Array(buffer);
  const length = view.length;
  const windowSize = Math.min(65536, length);
  const sample = (start: number): Uint8Array => {
    const bytes: number[] = [];
    const end = Math.min(start + windowSize, length);
    for (let i = start; i < end; i += 64) {
      bytes.push(view[i]);
    }
    return new Uint8Array(bytes);
  };
  const first = sample(0);
  const middle = sample(Math.max(0, Math.floor(length / 2) - windowSize / 2));
  const last = sample(Math.max(0, length - windowSize));
  const combined = new Uint8Array(first.length + middle.length + last.length);
  combined.set(first, 0);
  combined.set(middle, first.length);
  combined.set(last, first.length + middle.length);
  const hashA = fnv1a(combined, FNV_OFFSET);
  const hashB = fnv1a(combined, 0x9e3779b9);
  return `fnv1a:${hashA.toString(16)}:${hashB.toString(16)}:${length}`;
};

/**
 * 从 chapterDocs（rendition.getChapterDoc() 的返回值）解析标题树
 * 每页一次 await，让出主线程；单页解析失败静默跳过
 */
export const generateTocFromChapterDocs = async (
  chapterDocs: any[]
): Promise<PdfTocChapter[] | null> => {
  if (!Array.isArray(chapterDocs) || chapterDocs.length < 2) return null;
  const lines: PdfTextLine[] = [];
  for (let i = 0; i < chapterDocs.length; i++) {
    const section = chapterDocs[i] && chapterDocs[i].text;
    if (!section || typeof section.getTextContent !== "function") continue;
    try {
      const textContent = await section.getTextContent();
      if (!textContent || !Array.isArray(textContent.items)) continue;
      let dimension: { width: number; height: number } | null = null;
      try {
        dimension = await section.getDimension();
      } catch (error) {
        dimension = null;
      }
      if (!dimension) continue;
      let viewport = null;
      try {
        const page = await section.getPage();
        viewport = page ? page.getViewport({ scale: 1 }) : null;
      } catch (error) {
        viewport = null;
      }
      const pageLines = extractPageLines(
        i + 1,
        textContent.items,
        textContent.styles || {},
        viewport,
        dimension
      );
      lines.push(...pageLines);
    } catch (error) {
      // 单页失败不影响整体
      continue;
    }
  }
  return parseTocFromLines(lines);
};

export const flattenToc = flattenPdfToc;

/**
 * 判断 chapters 是否为 kookit 的「页码兜底」目录：
 * PDF 无 outline 时 getChapter() 返回每页一个 label 为 "0","1"... 的伪章节
 */
export const isPageFallbackChapters = (chapters: any[]): boolean => {
  if (!Array.isArray(chapters) || chapters.length === 0) return true;
  return chapters.every(
    (chapter) => chapter && typeof chapter.label === "string" && /^\d*$/.test(chapter.label)
  );
};

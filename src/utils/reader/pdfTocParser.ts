/**
 * 法学 PDF 动态目录解析器（纯函数，无副作用，可单独单测）
 *
 * 输入：pdf.js getTextContent() 的原始 items + 页面尺寸/viewport
 * 输出：带页码与垂直位置的标题节点树
 *
 * 坐标说明：
 * - item.transform[4],[5] 为 PDF 用户空间坐标（原点左下，y 向上）
 * - 通过 viewport.transform 做 6 元素矩阵复合转成设备坐标（y 向下），
 *   同时天然处理页面旋转；viewport 不可用时降级为 pageH - y
 */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  fontName?: string;
}

export interface PdfTextStyles {
  [fontName: string]: { fontFamily?: string; ascent?: number; descent?: number };
}

export interface PdfViewportLike {
  width: number;
  height: number;
  transform?: number[];
}

export interface PdfDimension {
  width: number;
  height: number;
}

export interface PdfTextLine {
  page: number;
  text: string;
  /** 行顶相对页面顶部的比例 0~1（用于跳转的垂直补偿） */
  yRatio: number;
  fontSize: number;
  startX: number;
  endX: number;
  isBold: boolean;
}

export interface PdfTocNode {
  label: string;
  page: number;
  yRatio: number;
  level: number;
}

export interface PdfTocChapter {
  label: string;
  id: string;
  href: string;
  index: number;
  subitems: PdfTocChapter[];
  pdfToc: boolean;
  pdfPage: number;
  pdfYRatio: number;
}

interface ItemPlacement {
  str: string;
  x: number;
  y: number;
  fontSize: number;
  width: number;
  isBold: boolean;
}

const CN_NUM = "一二三四五六七八九十百";
const MAX_TITLE_LENGTH = 40;
const HEADER_RATIO = 0.04;
const FOOTER_RATIO = 0.96;

const LEVEL1_REGEX = new RegExp(`^[${CN_NUM}]+[、.．:：]\\s*`);
const LEVEL2_REGEX = new RegExp(`^[（(][${CN_NUM}]+[)）]\\s*`);
const LEVEL3_REGEX = /^[0-9]{1,2}(?:[、.．]|[.][0-9]{1,2}[、.．]?)\s*\D/;
const SPECIAL_TITLE_REGEX =
  /^(引言|导论|导言|绪论|结语|结论|余论|参考文献|注释体例|注释|摘要|关键词|致谢|Abstract|Key\s*words?|Keywords?)(?:[：:，,\s]|$)/i;
/** 论文自带的印刷目录行（含引导点或点后页码），跳过避免重复 */
const PRINTED_TOC_REGEX = /…{2,}|…|\.{3,}\s*\d*$|\.\s*\.\s*\.\s*\d*$/;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const isBoldFont = (fontFamily?: string) => {
  if (!fontFamily) return false;
  return /bold|black|heavy|黑|楷/i.test(fontFamily);
};

/**
 * 把单个 text item 映射到设备坐标
 */
const placeItem = (
  item: PdfTextItem,
  styles: PdfTextStyles,
  viewport: PdfViewportLike | null,
  dimension: PdfDimension
): ItemPlacement | null => {
  if (!item || typeof item.str !== "string" || !item.transform) return null;
  const tx = item.transform[4];
  const ty = item.transform[5];
  let x: number;
  let y: number;
  if (viewport && viewport.transform && viewport.transform.length >= 6) {
    const [a, b, c, d, e, f] = viewport.transform;
    x = a * tx + c * ty + e;
    y = b * tx + d * ty + f;
  } else {
    // 降级：手动翻转 y 轴（仅适用于无旋转页面）
    x = tx;
    y = dimension.height - ty;
  }
  const fontSize = item.height || Math.abs(item.transform[3]) || 10;
  return {
    str: item.str,
    x,
    y,
    fontSize,
    width: item.width || fontSize * item.str.length * 0.5,
    isBold: isBoldFont(styles?.[item.fontName || ""]?.fontFamily),
  };
};

/**
 * 按基线 y 坐标聚类成行（容差随字号自适应）
 */
const clusterItems = (placements: ItemPlacement[]): ItemPlacement[][] => {
  const sorted = [...placements].sort((p, q) => p.y - q.y);
  const clusters: ItemPlacement[][] = [];
  let current: ItemPlacement[] = [];
  let currentY = 0;
  let currentSize = 10;
  for (const p of sorted) {
    if (current.length === 0) {
      current = [p];
      currentY = p.y;
      currentSize = p.fontSize;
      continue;
    }
    const tolerance = Math.max(2, currentSize * 0.4);
    if (Math.abs(p.y - currentY) <= tolerance) {
      current.push(p);
      currentSize = (currentSize * (current.length - 1) + p.fontSize) / current.length;
    } else {
      clusters.push(current);
      current = [p];
      currentY = p.y;
      currentSize = p.fontSize;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
};

interface LineSpan {
  startX: number;
  endX: number;
}

const computeSpan = (cluster: ItemPlacement[]): LineSpan => {
  let startX = Infinity;
  let endX = -Infinity;
  for (const p of cluster) {
    startX = Math.min(startX, p.x);
    endX = Math.max(endX, p.x + p.width);
  }
  return { startX: startX === Infinity ? 0 : startX, endX: endX === -Infinity ? 0 : endX };
};

/**
 * 双栏检测：统计多元素行中「行内大间隙」的占比。
 * 左右栏同一基线的 items 聚成一行后，行内会出现栏间沟（gap > 18% 页宽）；
 * 横跨整页的标题/图表行内部无大间隙，天然不受影响。
 */
const detectTwoColumn = (clusters: ItemPlacement[][], pageWidth: number): boolean => {
  if (clusters.length < 4) return false;
  let splitCount = 0;
  let multiCount = 0;
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    multiCount++;
    if (findColumnGap(cluster, pageWidth) !== null) splitCount++;
  }
  return multiCount >= 3 && splitCount >= 3 && splitCount >= multiCount * 0.25;
};

/**
 * 找出行内的栏间沟：返回 { splitX } 或 null（无沟则该行不可拆）
 */
const findColumnGap = (
  cluster: ItemPlacement[],
  pageWidth: number
): { splitX: number } | null => {
  if (cluster.length < 2) return null;
  const sorted = [...cluster].sort((p, q) => p.x - q.x);
  let maxGap = 0;
  let splitX = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
    if (gap > maxGap) {
      maxGap = gap;
      splitX = (sorted[i - 1].x + sorted[i - 1].width + sorted[i].x) / 2;
    }
  }
  return maxGap > pageWidth * 0.18 ? { splitX } : null;
};

const makeLine = (
  cluster: ItemPlacement[],
  page: number,
  pageHeight: number
): PdfTextLine | null => {
  const ordered = [...cluster].sort((p, q) => p.x - q.x);
  const text = ordered
    .map((p) => p.str)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 2) return null;
  const baselineY = ordered[0].y;
  const fontSize = Math.max(...ordered.map((p) => p.fontSize));
  // 基线 → 行顶（设备坐标 y 向下，ascent 约 0.85 em）
  const yRatio = clamp((baselineY - fontSize * 0.85) / pageHeight, 0, 1);
  if (yRatio < HEADER_RATIO || yRatio > FOOTER_RATIO) return null;
  // 纯页码 / 纯数字行剔除
  if (/^[\d\s·•—-]+$/.test(text)) return null;
  const span = computeSpan(ordered);
  return {
    page,
    text,
    yRatio,
    fontSize,
    startX: span.startX,
    endX: span.endX,
    isBold: ordered.some((p) => p.isBold),
  };
};

/**
 * 单页：原始 items → 行列表（含双栏拆分与阅读顺序排序）
 */
export const extractPageLines = (
  page: number,
  items: PdfTextItem[],
  styles: PdfTextStyles,
  viewport: PdfViewportLike | null,
  dimension: PdfDimension
): PdfTextLine[] => {
  if (!items || items.length === 0 || !dimension) return [];
  const placements = items
    .map((item) => placeItem(item, styles, viewport, dimension))
    .filter((p): p is ItemPlacement => p !== null && p.str.trim() !== "");
  if (placements.length === 0) return [];

  const pageWidth = viewport ? viewport.width : dimension.width;
  const pageHeight = viewport ? viewport.height : dimension.height;
  const clusters = clusterItems(placements);

  const twoColumn = detectTwoColumn(clusters, pageWidth);

  const leftLines: PdfTextLine[] = [];
  const rightLines: PdfTextLine[] = [];
  for (const cluster of clusters) {
    if (!twoColumn) {
      const line = makeLine(cluster, page, pageHeight);
      if (line) leftLines.push(line);
      continue;
    }
    // 双栏：仅拆存在栏间沟的行（在沟中点切开），
    // 横跨整页的标题行无沟，保持完整
    const gap = findColumnGap(cluster, pageWidth);
    if (!gap) {
      const line = makeLine(cluster, page, pageHeight);
      if (line) leftLines.push(line);
      continue;
    }
    const left = cluster.filter((p) => p.x + p.width * 0.5 < gap.splitX);
    const right = cluster.filter((p) => p.x + p.width * 0.5 >= gap.splitX);
    if (left.length > 0) {
      const line = makeLine(left, page, pageHeight);
      if (line) leftLines.push(line);
    }
    if (right.length > 0) {
      const line = makeLine(right, page, pageHeight);
      if (line) rightLines.push(line);
    }
  }
  // 阅读顺序：横跨行 + 左栏（按 y），随后右栏（按 y）
  return [...leftLines, ...rightLines];
};

/** 字符数加权的中位字号（估计正文字号） */
const weightedMedianFontSize = (lines: PdfTextLine[]): number => {
  const weighted: number[] = [];
  for (const line of lines) {
    if (line.text.length < 10) continue;
    const weight = Math.min(5, Math.floor(line.text.length / 10));
    for (let i = 0; i < weight; i++) weighted.push(line.fontSize);
  }
  if (weighted.length === 0) return 0;
  weighted.sort((a, b) => a - b);
  return weighted[Math.floor(weighted.length / 2)];
};

const detectLevel = (text: string): number => {
  if (LEVEL2_REGEX.test(text)) return 2;
  if (LEVEL1_REGEX.test(text)) return 1;
  if (SPECIAL_TITLE_REGEX.test(text)) return 1;
  if (LEVEL3_REGEX.test(text)) return 3;
  return 0;
};

/**
 * 剥掉行尾的目次页码（含引导点/空格），返回剩余标题部分；
 * 行尾不是页码（正常正文标题）时返回 null。
 * 例如「一、引言 …12」→「一、引言」；「（一）概述 3」→「（一）概述」
 */
const stripTrailingPageNumber = (text: string): string | null => {
  const match = text.match(/^(.*?)[\s.·•‧∙⋅…　]*\d{1,4}$/);
  if (!match) return null;
  const base = match[1].trim();
  return base.length >= 2 ? base : null;
};

interface HeadingCandidate {
  lineIndex: number;
  level: number;
  text: string;
  line: PdfTextLine;
}

/** 目次锚点：中文期刊首页常见「目次 / 目录 / Contents」标识 */
const TOC_ANCHOR_REGEX = /^(目次|目\s*次|目录|目\s*录|Contents?|Table\s+of\s+Contents)$/i;
/** 锚点下方被判定为目次的纵向范围上限（占页高比例） */
const TOC_ANCHOR_MAX_RATIO = 0.3;
/** 结束目次范围的行长阈值：出现正文长行即认为目次块结束 */
const TOC_ANCHOR_STOP_LENGTH = 25;

/**
 * 目次锚点抑制：以「目次」行为起点，向下收集连续的标题候选行，
 * 遇到正文长行（≥25 字）或超出纵向上限即结束；候选 ≥3 行则整段判为目次。
 * 该规则不依赖页码与标题文字，能覆盖「目次不带页码」的期刊排版。
 */
const collectAnchoredTocLines = (
  lines: PdfTextLine[],
  candidates: HeadingCandidate[]
): number[] => {
  const result: number[] = [];
  const candidateAt = new Map<number, HeadingCandidate>();
  candidates.forEach((cand) => candidateAt.set(cand.lineIndex, cand));
  for (let i = 0; i < lines.length; i++) {
    const anchor = lines[i];
    if (!TOC_ANCHOR_REGEX.test(anchor.text.trim())) continue;
    const hits: number[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.page !== anchor.page) break;
      const delta = line.yRatio - anchor.yRatio;
      if (delta < 0 || delta > TOC_ANCHOR_MAX_RATIO) break;
      // 正文长行出现 → 目次块结束
      if (line.text.trim().length >= TOC_ANCHOR_STOP_LENGTH) break;
      if (candidateAt.has(j)) hits.push(j);
    }
    if (hits.length >= 3) result.push(...hits);
  }
  return result;
};

/**
 * 标题匹配：行文本 → 标题节点（含误报抑制）
 *
 * 印刷目次（作者下方、摘要上方的「目次」块）抑制策略（四条互补）：
 * A. 锚点：以「目次 / 目录 / Contents」字样为锚，其下方连续的短标题行整段跳过
 *    （中文期刊目次常不带页码，只能靠锚点识别）；
 * B. 块级：同页连续 ≥3 个标题候选中过半带行尾页码 → 整块视为目次；
 * C. 行级：行尾带页码（如「一、引言 …12」）→ 目次条目，跳过；
 * D. 兜底：目次条目与正文标题逐字重复时，保留最后一次出现（正文在目次之后）。
 */
export const matchHeadings = (lines: PdfTextLine[]): PdfTocNode[] => {
  if (lines.length === 0) return [];
  const medianFontSize = weightedMedianFontSize(lines);

  // Pass 1: 收集标题候选
  const candidates: HeadingCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text.trim();
    if (text.length < 2 || text.length > MAX_TITLE_LENGTH) continue;
    // 句读过滤：标题不应含句号/分号/问叹号
    if (/[。；;！!？?]/.test(text)) continue;
    // 论文自带的印刷目录行跳过（点线引导等强特征）
    if (PRINTED_TOC_REGEX.test(text)) continue;
    const level = detectLevel(text);
    if (level === 0) continue;
    // 字号门限：标题字号应不显著小于正文字号
    if (medianFontSize > 0 && line.fontSize < medianFontSize * 0.82) continue;
    candidates.push({ lineIndex: i, level, text, line });
  }

  // Pass 2: 印刷目次块抑制——三种证据互补
  const printedTocSkip = new Set<number>();
  // 证据一：目次锚点（「目次/目录/Contents」字样下方连续的短标题行）
  collectAnchoredTocLines(lines, candidates).forEach((idx) =>
    printedTocSkip.add(idx)
  );
  // 证据二：连续候选行（同页且严格相邻）中过半带行尾页码 → 整块跳过
  let run: HeadingCandidate[] = [];
  const flushRun = () => {
    if (run.length >= 3) {
      const withPageNum = run.filter(
        (cand) => stripTrailingPageNumber(cand.text) !== null
      ).length;
      if (withPageNum >= Math.ceil(run.length / 2)) {
        run.forEach((cand) => printedTocSkip.add(cand.lineIndex));
      }
    }
    run = [];
  };
  for (const cand of candidates) {
    // 严格连续：同页且行索引相邻（间隔放宽会把正文标题卷进目次 run）
    if (
      run.length > 0 &&
      cand.lineIndex === run[run.length - 1].lineIndex + 1 &&
      cand.line.page === run[run.length - 1].line.page
    ) {
      run.push(cand);
    } else {
      flushRun();
      run = [cand];
    }
  }
  flushRun();

  // Pass 3: 构建节点（跳过目次块与带行尾页码的目次条目）
  const nodes: PdfTocNode[] = [];
  for (const cand of candidates) {
    if (printedTocSkip.has(cand.lineIndex)) continue;
    const base = stripTrailingPageNumber(cand.text);
    if (base !== null && detectLevel(base) > 0) continue;
    nodes.push({
      label: cand.text,
      page: cand.line.page,
      yRatio: cand.line.yRatio,
      level: cand.level,
    });
  }

  // Pass 4: 同名标题去重，保留最后一次出现（正文标题在目次之后）
  const lastIndexOfLabel = new Map<string, number>();
  nodes.forEach((node, idx) => {
    lastIndexOfLabel.set(node.label, idx);
  });
  return nodes.filter((node, idx) => lastIndexOfLabel.get(node.label) === idx);
};

/**
 * 节点列表 → 两级（最多三级）树
 */
export const buildTocTree = (nodes: PdfTocNode[]): PdfTocChapter[] => {
  const chapters: PdfTocChapter[] = [];
  let lastL1: PdfTocChapter | null = null;
  let lastL2: PdfTocChapter | null = null;
  nodes.forEach((node, idx) => {
    const chapter: PdfTocChapter = {
      label: node.label,
      id: `pdf-toc-${idx}`,
      href: `pdf-toc-${idx}`,
      index: node.page - 1,
      subitems: [],
      pdfToc: true,
      pdfPage: node.page,
      pdfYRatio: node.yRatio,
    };
    if (node.level === 1 || !lastL1) {
      chapters.push(chapter);
      lastL1 = chapter;
      lastL2 = null;
    } else if (node.level === 2 || !lastL2) {
      lastL1.subitems.push(chapter);
      lastL2 = chapter;
    } else {
      lastL2.subitems.push(chapter);
    }
  });
  return chapters;
};

/**
 * 汇总入口：全部页面行 → 标题树；解析失败返回 null
 */
export const parseTocFromLines = (
  lines: PdfTextLine[]
): PdfTocChapter[] | null => {
  const nodes = matchHeadings(lines);
  const level1Count = nodes.filter((node) => node.level === 1).length;
  if (nodes.length < 3 || (level1Count < 2 && nodes.length < 5)) return null;
  if (nodes.length > 300) return null;
  return buildTocTree(nodes);
};

export const flattenPdfToc = (chapters: PdfTocChapter[]): PdfTocChapter[] => {
  const flat: PdfTocChapter[] = [];
  const walk = (items: PdfTocChapter[]) => {
    for (const item of items) {
      flat.push(item);
      if (item.subitems && item.subitems.length > 0) walk(item.subitems);
    }
  };
  walk(chapters);
  return flat;
};

import Note from "../../models/Note";
import DatabaseService from "../storage/databaseService";
import {
  ConfigService,
  NoteSyncManager,
} from "../../assets/lib/kookit-extra-browser.min";
import { getIframeDoc } from "./docUtil";

export interface DigestParams {
  currentBook: any;
  htmlBook: any;
  chapterDocIndex: number;
  chapter: string;
  color: string;
  t: (key: string) => string;
  onNoteClick?: (event: Event) => void;
  onSuccess?: () => void;
}

export async function createHighlight(params: DigestParams): Promise<void> {
  const {
    currentBook,
    htmlBook,
    chapterDocIndex,
    chapter,
    color,
    onNoteClick,
    onSuccess,
  } = params;

  if (!htmlBook) return;

  let bookKey = currentBook.key;
  let bookLocation = ConfigService.getObjectConfig(
    bookKey,
    "recordLocation",
    {}
  );
  let cfi = JSON.stringify(bookLocation);

  if (
    currentBook.format === "PDF" &&
    !ConfigService.getAllListConfig("convertPDFBooks").includes(currentBook.key)
  ) {
    let pdfLocation = htmlBook.rendition.getPositionByChapter(chapterDocIndex);
    cfi = JSON.stringify(pdfLocation);
  }

  let percentage = bookLocation.percentage ? bookLocation.percentage : "0";
  let docs = getIframeDoc(currentBook.format, currentBook.key);
  let text = "";
  for (let i = 0; i < docs.length; i++) {
    let doc = docs[i];
    if (!doc) continue;
    text = doc.getSelection()?.toString() || "";
    if (text) break;
  }
  if (!text) return;

  text = text.replace(/\s\s/g, "");
  text = text.replace(/\r/g, "");
  text = text.replace(/\n/g, "");
  text = text.replace(/\t/g, "");
  text = text.replace(/\f/g, "");

  let range = JSON.stringify(
    await htmlBook.rendition.getHighlightCoords(chapterDocIndex)
  );

  let highlight = new Note(
    bookKey,
    chapter,
    chapterDocIndex,
    text,
    cfi,
    range,
    "",
    percentage,
    color,
    []
  );

  // 乐观更新：先绘制高亮（即时视觉反馈），再持久化到数据库。
  // 原顺序是"先落库后绘制"，而网页版落库需要全量读取并回写整张笔记表，
  // 导致选中变色后需等待 1~2 秒才能看到高亮效果，读者会怀疑操作是否成功。
  await htmlBook.rendition.createOneNote(highlight, onNoteClick ?? (() => {}));

  // 笔记数据即将变更，递增全局版本号，使翻页时的章节缓存失效
  (window as any).__notesVersion = ((window as any).__notesVersion || 0) + 1;

  try {
    await DatabaseService.saveRecord(highlight, "notes");
  } catch (error) {
    console.error("Failed to persist highlight:", error);
  }
  // onSuccess 内含刷新侧栏笔记列表(handleFetchNotes)，需在落库完成后调用，
  // 否则列表中读不到刚创建的高亮
  onSuccess?.();
  let noteSyncManager = new NoteSyncManager(
    DatabaseService,
    ConfigService,
    window.electronAPI?.fs,
    window.electronAPI?.path
  );
  noteSyncManager.syncNote(highlight, bookKey);
}

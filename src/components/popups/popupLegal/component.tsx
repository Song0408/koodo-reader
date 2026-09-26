import React from "react";
import "./popupLegal.css";
import {
  PopupLegalProps,
  PopupLegalState,
} from "./interface";
import { analyzeLegalText } from "../../../utils/request/legal";
import Parser from "html-react-parser";
import DOMPurify from "dompurify";
import { marked } from "marked";
import toast from "react-hot-toast";
import { openExternalUrl } from "../../../utils/common";

declare var window: any;

const STAGE_STEPS = ["解析论证结构", "北大法宝验证", "生成攻防分析"];

class PopupLegal extends React.Component<PopupLegalProps, PopupLegalState> {
  abortController: AbortController | null = null;
  markdownAccumulator: string = "";
  updateInterval: ReturnType<typeof setInterval> | null = null;
  contentRef: React.RefObject<HTMLDivElement>;

  constructor(props: PopupLegalProps) {
    super(props);
    this.state = {
      status: "idle",
      stage: 0,
      stageLabel: "",
      extraction: null,
      normSummary: null,
      markdown: "",
      errorMessage: "",
    };
    this.contentRef = React.createRef();
  }

  componentDidMount() {
    if (this.props.quoteText && this.props.quoteText.trim().length >= 20) {
      this.handleAnalyze(this.props.quoteText, "selection");
    }
  }

  componentWillUnmount() {
    this.abortController?.abort();
    if (this.updateInterval) clearInterval(this.updateInterval);
  }

  /** 批量刷新流式 Markdown（150ms 一拍，避免逐 token setState 卡顿） */
  startUpdateInterval() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    this.updateInterval = setInterval(() => {
      if (this.markdownAccumulator) {
        this.setState({ markdown: this.markdownAccumulator });
      }
    }, 150);
  }

  stopUpdateInterval() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    if (this.markdownAccumulator) {
      this.setState({ markdown: this.markdownAccumulator });
    }
  }

  handleAnalyze = async (text: string, mode: "selection" | "chapter") => {
    const cleanText = text.trim();
    if (cleanText.length < 20) {
      toast("选中文本过短，无法进行论证分析");
      return;
    }
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.markdownAccumulator = "";
    this.setState({
      status: "running",
      stage: 0,
      stageLabel: "",
      extraction: null,
      normSummary: null,
      markdown: "",
      errorMessage: "",
    });
    this.startUpdateInterval();

    try {
      await analyzeLegalText(
        cleanText,
        mode,
        (event) => {
          switch (event.type) {
            case "stage":
              this.setState({
                stage: event.stage,
                stageLabel: event.label,
              });
              break;
            case "extraction":
              this.setState({
                extraction: {
                  core_claim: event.core_claim,
                  norms: event.norms,
                  doctrines: event.doctrines,
                },
              });
              break;
            case "norms":
              this.setState({
                normSummary: {
                  verified: event.verified || [],
                  failed: event.failed || [],
                  pkulawError: event.pkulawError || null,
                },
              });
              break;
            case "token":
              this.markdownAccumulator += event.delta || "";
              break;
            case "append":
              this.markdownAccumulator += event.text || "";
              break;
            case "error":
              throw new Error(event.message || "分析失败");
            default:
              break;
          }
        },
        this.abortController.signal
      );
      this.setState({ status: "done" });
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      this.setState({
        status: "error",
        errorMessage:
          err?.message?.includes("Failed to fetch") || err?.name === "TypeError"
            ? "无法连接本地桥接服务（localhost:3310）。请确认已在 bridge/ 目录运行 npm start"
            : err?.message || "分析失败",
      });
    } finally {
      this.stopUpdateInterval();
    }
  };

  /** 分析当前章节全文（kookit 的 chapterText） */
  handleAnalyzeChapter = async () => {
    try {
      const text = await this.props.htmlBook?.rendition?.chapterText();
      if (!text || text.trim().length < 20) {
        toast("当前章节文本过短或无法提取");
        return;
      }
      this.handleAnalyze(text, "chapter");
    } catch {
      toast("当前格式暂不支持章节分析，请使用划词分析");
    }
  };

  handleCopy = () => {
    if (!this.state.markdown) return;
    navigator.clipboard.writeText(this.state.markdown).then(() => {
      toast.success(this.props.t("Copied"));
    });
  };

  /** 结果中的链接交给系统浏览器打开（Electron 渲染进程内 a 标签默认无效） */
  handleContentClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "A") {
      e.preventDefault();
      const href = target.getAttribute("href");
      if (href && href.startsWith("http")) openExternalUrl(href);
    }
  };

  renderStageSteps() {
    const { status, stage } = this.state;
    if (status !== "running") return null;
    return (
      <div className="legal-stage-steps">
        {STAGE_STEPS.map((label, i) => {
          const step = i + 1;
          const isCurrent = step === stage;
          const isDone = step < stage;
          return (
            <div key={label} className="legal-stage-step">
              <span
                className={
                  isCurrent
                    ? "icon-loading legal-stage-icon legal-stage-icon-running"
                    : isDone
                      ? "icon-success legal-stage-icon legal-stage-icon-done"
                      : "icon-clock legal-stage-icon legal-stage-icon-wait"
                }
              ></span>
              <span
                className={
                  isCurrent
                    ? "legal-stage-label legal-stage-label-current"
                    : isDone
                      ? "legal-stage-label legal-stage-label-done"
                      : "legal-stage-label"
                }
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  renderExtraction() {
    const { extraction, normSummary, status } = this.state;
    if (!extraction || status === "error") return null;
    const verifiedCount = normSummary ? normSummary.verified.length : 0;
    const failedCount = normSummary ? normSummary.failed.length : 0;
    // 作者本段是否真的引用了法条——决定「无需验证」还是「验证失败」
    const extractedNorms = extraction.norms || [];
    const nothingToVerify = extractedNorms.length === 0;
    const pkulawError = normSummary?.pkulawError || null;
    return (
      <div className="legal-extraction-box">
        <div className="legal-extraction-title">核心主张</div>
        <div className="legal-extraction-claim">{extraction.core_claim}</div>
        {normSummary && (
          <div className="legal-extraction-meta">
            {normSummary && (
              <span>
                规范验证：
                {nothingToVerify ? (
                  <span className="legal-muted">
                    本段未引用具体法条（无需验证）
                  </span>
                ) : pkulawError ? (
                  <span className="legal-warn">验证失败（检查积分/网络）</span>
                ) : verifiedCount > 0 ? (
                  <span className="legal-ok">
                    {verifiedCount} 条已通过北大法宝验证
                  </span>
                ) : (
                  <span className="legal-warn">
                    {extractedNorms.length} 条已提取但未在北大法宝命中
                  </span>
                )}
                {failedCount > 0 && `，${failedCount} 条未命中`}
              </span>
            )}
            {extraction.doctrines && extraction.doctrines.length > 0 && (
              <span>｜涉及学说：{extraction.doctrines.length} 项</span>
            )}
          </div>
        )}
        {normSummary?.pkulawError && (
          <div className="legal-pkulaw-error">
            北大法宝调用异常（可能积分不足）：{normSummary.pkulawError.slice(0, 80)}
          </div>
        )}
      </div>
    );
  }

  render() {
    const { status, markdown, errorMessage } = this.state;
    return (
      <div className="popup-legal-container">
        <div className="popup-legal-header">
          <span className="icon-idea popup-legal-title-icon"></span>
          <span className="popup-legal-title">攻防分析</span>
          <span className="popup-legal-actions">
            {status === "done" && (
              <span
                className="popup-legal-action-button"
                title="复制 Markdown"
                onClick={this.handleCopy}
              >
                <span className="icon-copy-line"></span>
              </span>
            )}
            <span
              className="popup-legal-action-button"
              title="分析当前章节"
              onClick={this.handleAnalyzeChapter}
            >
              <span className="icon-bookshelf-line"></span>
            </span>
          </span>
        </div>

        {status === "idle" && (
          <div className="legal-hint">
            在正文中选中一段论述后，点击划词菜单中的「攻防分析」按钮；或点击右上角图标分析当前章节。
          </div>
        )}

        {this.renderStageSteps()}
        {this.renderExtraction()}

        {status === "error" && (
          <div className="legal-error-box">{errorMessage}</div>
        )}

        {markdown && (
          <div
            className="popup-legal-content"
            ref={this.contentRef}
            onClick={this.handleContentClick}
          >
            {Parser(
              DOMPurify.sanitize(
                marked.parse(markdown) + "<address></address>" || " "
              )
            )}
          </div>
        )}
      </div>
    );
  }
}

export default PopupLegal;

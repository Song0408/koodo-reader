/**
 * 法学论文攻防分析 - 桥接服务请求封装
 *
 * 桥接服务（bridge/server.js）监听 localhost:3310：
 *   POST /api/analyze  {text, mode} → SSE 流式回传事件
 *   GET  /api/health              → 服务与密钥配置状态
 *
 * 事件类型见 bridge/analyzer.js 头部注释：
 *   stage / extraction / norms / token / append / done / error
 */
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";

export const DEFAULT_LEGAL_BRIDGE_URL = "http://localhost:3310";

export const getLegalBridgeUrl = () => {
  try {
    return (
      ConfigService.getReaderConfig("legalBridgeUrl") ||
      DEFAULT_LEGAL_BRIDGE_URL
    );
  } catch {
    return DEFAULT_LEGAL_BRIDGE_URL;
  }
};

export interface LegalAnalyzeEvent {
  type: string;
  [key: string]: any;
}

/**
 * 发起攻防分析，流式回调事件。
 * @param text 选中的论述文本（或章节全文）
 * @param mode "selection" | "chapter"
 * @param onEvent 每个 SSE 事件的回调
 * @param signal AbortSignal，面板关闭时中断
 */
export const analyzeLegalText = async (
  text: string,
  mode: "selection" | "chapter",
  onEvent: (event: LegalAnalyzeEvent) => void,
  signal?: AbortSignal
) => {
  const res = await fetch(`${getLegalBridgeUrl()}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode }),
    signal,
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch {}
    throw new Error(`桥接服务返回 ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("当前环境不支持流式响应");
  const decoder = new TextDecoder();
  let buf = "";

  // 逐块解析 SSE：事件以空行分隔，行格式 "data: {json}"
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const rawEvent = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
  }
};

/** 健康检查：返回 {ok, llmConfigured, pkulawConfigured}，失败抛错 */
export const checkLegalBridgeHealth = async () => {
  const res = await fetch(`${getLegalBridgeUrl()}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

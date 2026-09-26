/**
 * 北大法宝 MCP 客户端（streamableHttp / JSON-RPC 2.0）
 *
 * 协议要点（2026-09-26 实测验证）：
 * - 服务支持无状态直调：不需要 initialize 握手，直接 POST tools/call 即可
 * - 响应格式不统一：mcp-law-search-service 返回纯 JSON，
 *   law_recognition 返回 SSE 包装（"event: message\ndata: {...}"）——两种都要解析
 * - 计费：tools/list 免费；tools/call 扣积分（关键词检索约 25 分，语义检索约 125 分）
 *   积分为 0 时网关返回 {"code":"90001","message":"Unclassified Authentication Failure"...}
 */
const { fetch: undiciFetch, ProxyAgent } = require("undici");

const GATEWAY = "https://apim-gateway.pkulaw.com";

const SERVICES = {
  lawSearch: `${GATEWAY}/mcp-law-search-service`, // get_article / search_article
  lawRecognition: `${GATEWAY}/law_recognition`, // law_recognition（语义，贵）
  caseSearch: `${GATEWAY}/mcp-case-search-service`, // search_case
};

class PkulawClient {
  /**
   * @param {object} opts
   * @param {string} opts.token 36 位 Bearer Token
   * @param {string} [opts.proxy] 可选 HTTP 代理，如 http://127.0.0.1:7890；空串表示直连
   * @param {number} [opts.timeoutMs] 单次请求超时
   */
  constructor(opts = {}) {
    if (!opts.token) {
      throw new Error("[pkulaw] config.pkulaw.token 未配置");
    }
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs || 30000;
    this.dispatcher = opts.proxy
      ? new ProxyAgent({ uri: opts.proxy })
      : undefined;
    this._reqId = 0;
  }

  /**
   * 调用 MCP 工具
   * @param {keyof typeof SERVICES} service
   * @param {string} tool 工具名，如 get_article / search_case / law_recognition
   * @param {object} args 工具入参
   * @returns {Promise<any>} 工具返回的 text 字段反序列化结果（若为 JSON）
   */
  async callTool(service, tool, args) {
    const url = SERVICES[service];
    if (!url) throw new Error(`[pkulaw] 未知服务: ${service}`);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++this._reqId,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });

    let res;
    try {
      res = await undiciFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`[pkulaw] 网络请求失败（${service}/${tool}）: ${err.message}`);
    }

    const raw = await res.text();

    // 网关层错误（如积分不足 90001）
    if (!res.ok) {
      throw new Error(`[pkulaw] HTTP ${res.status}: ${raw.slice(0, 200)}`);
    }

    const payload = this._parsePayload(raw);
    if (payload.error) {
      const desc =
        (payload.error.description || payload.error.message || "").slice(0, 200);
      throw new Error(`[pkulaw] ${service}/${tool} 调用被拒: ${desc}`);
    }

    // MCP 标准结果：result.content[].text
    const content = payload.result && payload.result.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error(`[pkulaw] ${service}/${tool} 返回空内容`);
    }
    const text = content.map((c) => c.text || "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** 兼容纯 JSON 与 SSE 两种响应封装 */
  _parsePayload(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }
    // SSE: "event: message\ndata: {...}"
    const dataLines = trimmed
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) {
      throw new Error(`[pkulaw] 无法解析的响应格式: ${trimmed.slice(0, 120)}`);
    }
    return JSON.parse(dataLines[dataLines.length - 1]);
  }

  // ---------- 业务封装 ----------

  /** 获取法条原文（关键词级，约 25 积分） */
  async getArticle(title, number) {
    return this.callTool("lawSearch", "get_article", { title, number });
  }

  /** 语义法条识别（约 125 积分，默认流程不用，仅在标题模糊时手动启用） */
  async recognizeLaws(text) {
    return this.callTool("lawRecognition", "law_recognition", { text });
  }

  /** 类案检索（约 125 积分），query 为争议焦点描述 */
  async searchCases(query, size = 3) {
    return this.callTool("caseSearch", "search_case", {
      text: query,
      size,
    });
  }
}

module.exports = { PkulawClient, SERVICES };

/**
 * 三阶段分析编排器
 *
 * 阶段一  LLM 结构化抽取：核心主张 + 引用规范清单（JSON，低温度）
 * 阶段二  北大法宝 MCP 验证：逐条 get_article 验原文与效力；search_case 检对立案例
 * 阶段三  LLM 四维综合：只喂已验证材料，SSE 流式输出 Markdown
 * 后置    引文校验：输出中出现的《X法》第N条若不在已验证集合 → 追加警示块
 *
 * 事件协议（onEvent(type, payload)）：
 *   stage      {stage: 1|2|3, label}     阶段切换
 *   extraction {core_claim, norms, doctrines}   阶段一完成
 *   norms      {verified: [...], failed: [...], pkulawError?}  阶段二完成
 *   token      {delta}                   阶段三流式增量
 *   append     {text}                    后置校验追加的警示块
 *   done       {}                        全部完成
 *   error      {message}                 致命错误（未 done 即终止）
 */
const { PkulawClient } = require("./pkulawClient");
const {
  EXTRACT_SYSTEM,
  extractUser,
  SYNTHESIS_SYSTEM,
  synthesisUser,
  unverifiedWarning,
} = require("./prompt");

class Analyzer {
  constructor(config) {
    this.config = config;
    this.llm = config.llm;
    this.pkulaw = new PkulawClient(config.pkulaw || {});
    this.limits = config.limits || {};
  }

  async analyze({ text, mode = "selection" }, onEvent) {
    const emit = onEvent || (() => {});
    const input = String(text || "").trim().slice(0, this.limits.maxInputChars || 6000);
    if (input.length < 20) {
      throw new Error("选中文本过短（少于 20 字），无法进行论证分析");
    }

    // ---------- 阶段一：抽取 ----------
    emit("stage", { stage: 1, label: "解析论证结构" });
    const extraction = await this._extract(input, mode);
    emit("extraction", {
      core_claim: extraction.core_claim,
      norms: extraction.norms,
      doctrines: extraction.doctrines,
    });

    // ---------- 阶段二：北大法宝验证 ----------
    emit("stage", { stage: 2, label: "北大法宝验证规范依据" });
    const normResult = await this._verifyNorms(extraction.norms || []);
    const caseResult = await this._searchOpposingCases(extraction.opposing_keywords, extraction.core_claim);
    emit("norms", normResult);

    // ---------- 阶段三：综合 ----------
    emit("stage", { stage: 3, label: "生成攻防分析" });
    let markdown = "";
    await this._streamSynthesis(
      input,
      extraction,
      normResult.verified,
      caseResult.cases,
      (delta) => {
        markdown += delta;
        emit("token", { delta });
      }
    );

    // ---------- 后置：引文校验 ----------
    const unverified = this._findUnverifiedCitations(markdown, normResult.verified);
    if (unverified.length > 0) {
      const warning = unverifiedWarning(unverified);
      markdown += warning;
      emit("append", { text: warning });
    }

    emit("done", {});
    return { markdown, extraction, verified: normResult.verified };
  }

  // ============ 阶段一 ============

  async _extract(text, mode) {
    const raw = await this._callLLM(
      [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: extractUser(text, mode) },
      ],
      { json: true }
    );
    return this._parseJsonLoose(raw);
  }

  // ============ 阶段二 ============

  async _verifyNorms(norms) {
    const maxNorms = this.limits.maxNorms || 6;
    const result = { verified: [], failed: [], pkulawError: null };

    const targets = (norms || []).filter((n) => n && n.title).slice(0, maxNorms);
    if (targets.length === 0) return result;

    // 串行调用，控制积分消耗节奏；单条失败不中断整体
    for (const norm of targets) {
      try {
        const article = await this.pkulaw.getArticle(norm.title, norm.number || "第一条");
        if (article && (article.article || article.content || article.text)) {
          result.verified.push({
            title: article.title || norm.title,
            number: article.doc_no || norm.number,
            excerpt: String(
              article.article || article.content || article.text
            ).slice(0, 160),
            url: article.url || article.link || "",
            gid: article.gid || "",
            quoted_by_author: norm.quote || "",
          });
        } else {
          result.failed.push({ title: norm.title, number: norm.number, reason: "数据库未返回原文" });
        }
      } catch (err) {
        const msg = err.message || "";
        result.failed.push({ title: norm.title, number: norm.number, reason: msg.slice(0, 120) });
        // 积分耗尽 / 认证失败：立即停止后续扣费调用
        if (msg.includes("90001") || msg.includes("积分") || msg.includes("Authentication")) {
          result.pkulawError = msg.slice(0, 200);
          break;
        }
      }
    }
    return result;
  }

  async _searchOpposingCases(keywords, coreClaim) {
    const query = keywords || coreClaim || "";
    if (!query) return { cases: [] };
    const size = (this.config.pkulaw && this.config.pkulaw.caseResultSize) || 3;
    try {
      const res = await this.pkulaw.searchCases(query.slice(0, 60), size);
      const list = Array.isArray(res) ? res : res.cases || res.data || [];
      const cases = list.slice(0, size).map((c) => ({
        title: c.title || c.case_name || "",
        case_number: c.case_number || c.caseNumber || c.anhao || "",
        court: c.courthouse_name || c.court || "",
        gist: (c.judge_reason || c.reason || c.gist || "").slice(0, 200),
        url: c.url || c.link || c.pkulaw_url || "",
      }));
      return { cases };
    } catch (err) {
      // 案例检索失败不致命：综合阶段会如实写「未检索到」
      return { cases: [], error: (err.message || "").slice(0, 120) };
    }
  }

  // ============ 阶段三 ============

  async _streamSynthesis(text, extraction, verifiedNorms, verifiedCases, onToken) {
    const messages = [
      { role: "system", content: SYNTHESIS_SYSTEM },
      {
        role: "user",
        content: synthesisUser(text, extraction, verifiedNorms, verifiedCases),
      },
    ];
    await this._streamLLM(messages, onToken);
  }

  // ============ 后置校验 ============

  /**
   * 扫描最终 Markdown 中的《X法》第N条引文，不在已验证集合 → 返回未验证列表。
   * 集合匹配做了短名归一（“《民法典》”可命中“《中华人民共和国民法典》”）。
   */
  _findUnverifiedCitations(markdown, verified) {
    const verifiedSet = new Set();
    for (const v of verified || []) {
      verifiedSet.add(this._normTitleKey(v.title));
    }
    const seen = new Map();
    const re = /《([^》]{2,30}?)》\s*第([一二三四五六七八九十百零〇\d]+条(?:之[一二三四五六七八九十]+)?)/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
      const key = this._normTitleKey(m[1]);
      if (!verifiedSet.has(key) && !seen.has(key + m[2])) {
        seen.set(key + m[2], { title: m[1], number: `第${m[2]}` });
      }
    }
    return [...seen.values()];
  }

  _normTitleKey(title) {
    return String(title || "")
      .replace(/^中华人民共和国/, "")
      .replace(/[（《》法司法解释条例]/g, "")
      .trim();
  }

  // ============ LLM 基础封装（OpenAI 兼容） ============

  async _callLLM(messages, { json = false } = {}) {
    const res = await this._fetchLLM({
      model: this.llm.model,
      messages,
      temperature: json ? 0.1 : this.llm.temperature || 0.3,
      stream: false,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      throw new Error(`[llm] ${res.status} ${JSON.stringify(body.error || body).slice(0, 200)}`);
    }
    return body.choices[0].message.content;
  }

  async _streamLLM(messages, onToken) {
    const res = await this._fetchLLM({
      model: this.llm.model,
      messages,
      temperature: this.llm.temperature || 0.3,
      stream: true,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[llm] ${res.status} ${text.slice(0, 200)}`);
    }
    for await (const chunk of this._iterSse(res.body)) {
      if (chunk === "[DONE]") break;
      try {
        const obj = JSON.parse(chunk);
        const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (delta && delta.content) onToken(delta.content);
      } catch {
        /* 忽略心跳/非 JSON 行 */
      }
    }
  }

  async _fetchLLM(payload) {
    if (!this.llm.apiKey || /你的|待填入|xxxx/i.test(this.llm.apiKey)) {
      throw new Error("[llm] bridge/config.json 中 llm.apiKey 未配置");
    }
    const url = this.llm.baseUrl.replace(/\/$/, "") + "/chat/completions";
    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.llm.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.llm.timeoutMs || 120000),
    });
  }

  /** 解析 SSE 流为 data 行字符串迭代器 */
  async *_iterSse(body) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }

  /** 容错 JSON 解析：剥掉 ```json 围栏、截取首尾大括号 */
  _parseJsonLoose(raw) {
    let s = String(raw).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("[llm] 阶段一未返回 JSON");
    return JSON.parse(s.slice(start, end + 1));
  }
}

module.exports = { Analyzer };

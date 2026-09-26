/**
 * Koodo Reader「法学论文攻防分析」本地桥接服务
 *
 * 职责：
 *  - 接收 Koodo 前端（Electron 渲染进程）的 POST /api/analyze
 *  - 编排 Analyzer 三阶段流水线（LLM 抽取 → 北大法宝 MCP 验证 → LLM 综合）
 *  - 以 SSE（text/event-stream）把阶段进度与 Markdown 增量流式回传
 *
 * 运行：
 *   1) cp .env.example .env 并填入 DEEPSEEK_API_KEY 与 PKULAW_TOKEN
 *   2) cp config.example.json config.json（非敏感配置：端口/模型/限额）
 *   3) npm install && npm start
 */
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Analyzer } = require("./analyzer");

// ---------- 配置加载 ----------
const configPath = path.join(__dirname, "config.json");
if (!fs.existsSync(configPath)) {
  console.error(
    "[bridge] 未找到 config.json。请执行: cp config.example.json config.json"
  );
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// ---------- 密钥注入：环境变量（.env）优先，覆盖 config.json ----------
config.llm = config.llm || {};
config.pkulaw = config.pkulaw || {};
if (process.env.DEEPSEEK_API_KEY) {
  config.llm.apiKey = process.env.DEEPSEEK_API_KEY;
}
if (process.env.PKULAW_TOKEN) {
  config.pkulaw.token = process.env.PKULAW_TOKEN;
}
if (!process.env.DEEPSEEK_API_KEY && !process.env.PKULAW_TOKEN) {
  console.warn(
    "[bridge] .env 中未检测到 DEEPSEEK_API_KEY / PKULAW_TOKEN，请检查 bridge/.env"
  );
}

const PORT = config.port || 3310;
const analyzer = new Analyzer(config);

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- CORS（Electron 生产模式 webSecurity 开启，必须显式放行） ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- 健康检查 ----------
const isPlaceholder = (s) => !s || /你的|待填入|xxxx/i.test(s);

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "koodo-legal-bridge",
    llmConfigured: !isPlaceholder(config.llm && config.llm.apiKey),
    pkulawConfigured: !isPlaceholder(config.pkulaw && config.pkulaw.token),
    time: new Date().toISOString(),
  });
});

// ---------- 分析主接口（SSE） ----------
app.post("/api/analyze", async (req, res) => {
  const { text, mode } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "缺少 text 字段" });
  }

  // SSE 头：禁用 nginx 式缓冲语义，让 fetch 流式读取
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };
  // 防止客户端断开后继续扣费调用。
  // 注意：必须监听 res 的 close（连接断开/响应结束），
  // 不能监听 req 的 close——Node ≥13 中请求体被读完就会触发，会误杀正常事件。
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  try {
    await analyzer.analyze(
      { text, mode },
      (type, payload) => {
        if (!closed) send(type, payload);
      }
    );
    if (!closed) res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error("[bridge] analyze 失败:", err.message);
    if (!closed) send("error", { message: (err.message || "分析失败").slice(0, 300) });
  } finally {
    res.end();
  }
});

const isSecretConfigured = (s) => Boolean(s) && !/你的|待填入|xxxx/i.test(s);

app.listen(PORT, () => {
  console.log(`[bridge] 法学攻防分析桥接服务已启动: http://localhost:${PORT}`);
  console.log(
    `[bridge] LLM: ${config.llm.model || "?"} @ ${config.llm.baseUrl || "?"} (${
      isSecretConfigured(config.llm.apiKey) ? "已配置" : "未配置! 请在 bridge/.env 填写 DEEPSEEK_API_KEY"
    })`
  );
  console.log(
    `[bridge] 北大法宝 MCP: ${
      isSecretConfigured(config.pkulaw.token) ? "已配置" : "未配置! 请在 bridge/.env 填写 PKULAW_TOKEN"
    }${config.pkulaw.proxy ? ` (经代理 ${config.pkulaw.proxy})` : " (直连)"}`
  );
});

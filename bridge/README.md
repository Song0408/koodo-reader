# 法学论文攻防分析 - 本地桥接服务

Koodo Reader 前端与（LLM + 北大法宝 MCP）之间的本地中间层。

## 架构

```
Koodo 前端 (Electron 渲染进程)
    │  fetch POST /api/analyze {text, mode}   ← SSE 流式回传
    ▼
本服务 (Express, localhost:3310)
    ├── 阶段一  LLM 结构化抽取（OpenAI 兼容 /chat/completions，低温度 JSON）
    ├── 阶段二  北大法宝 MCP 验证（JSON-RPC 直连 apim-gateway.pkulaw.com）
    │            · get_article  逐条验证法条原文与效力（约 25 积分/次）
    │            · search_case  检索对立裁判案例（约 125 积分/次）
    └── 阶段三  LLM 四维综合（流式）+ 后置引文校验（未验证条目打警示）
```

## 启动

```bash
cd bridge
cp .env.example .env         # 填入 DEEPSEEK_API_KEY 与 PKULAW_TOKEN（密钥只存 .env，不进 git）
cp config.example.json config.json   # 非敏感配置：端口/模型/限额
npm install
npm start                            # 监听 http://localhost:3310
```

密钥读取优先级：环境变量（.env）> config.json（已留空）。

## 接口

### GET /api/health
返回服务状态与两项密钥是否已配置。

### POST /api/analyze
请求体：`{"text": "选中的论文段落", "mode": "selection" | "chapter"}`

响应为 SSE 流，每个事件是 `data: {"type": "...", ...}`：

| type | 载荷 | 说明 |
|---|---|---|
| stage | {stage, label} | 阶段切换（1 抽取 / 2 验证 / 3 综合） |
| extraction | {core_claim, norms, doctrines} | 阶段一完成 |
| norms | {verified[], failed[], pkulawError?} | 阶段二完成 |
| token | {delta} | Markdown 流式增量 |
| append | {text} | 后置校验追加的未验证引文警示 |
| error | {message} | 致命错误 |
| [DONE] | — | 流结束标记 |

## 配置说明（config.json）

| 字段 | 说明 |
|---|---|
| llm.baseUrl / apiKey / model | 任意 OpenAI 兼容服务（默认 DeepSeek） |
| pkulaw.token | 北大法宝 36 位 Token（充值：https://mcp.pkulaw.com/console/points） |
| pkulaw.proxy | 可选 HTTP 代理；空串直连 |
| pkulaw.useSemanticRecognition | 是否启用语义法条识别（贵，约 125 积分/次），默认关 |
| pkulaw.caseResultSize | 对立案例检索条数，默认 3 |
| limits.maxNorms | 单次分析最多验证的规范条数（控积分），默认 6 |

## 积分成本预估

单次攻防分析 ≈ maxNorms × 25（法条验证）+ 125（案例检索）≈ 100~275 积分。
积分余额为 0 时网关返回 90001，服务会把它作为 pkulawError 下发并在面板如实提示。

## 协议备注（实测 2026-09-26）

- 北大法宝 MCP 支持无状态直调（无需 initialize 握手）
- mcp-law-search-service 返回纯 JSON；law_recognition 返回 SSE 包装——pkulawClient 已兼容两种
- tools/list 免费不扣积分

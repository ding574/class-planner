// 班级事务工作台 · 网页版后端
// 零第三方依赖，只用 Node 内置模块（需要 Node 18+，内置 fetch）
//
// 场景定义在 scenarios.js，这里负责：并行调度、合成、访问控制、限流。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, findScenario, publicScenarios } from './scenarios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_BRIEF = 6000;
const CALL_TIMEOUT = 240_000;

// 分享给别人用时的控制项
const HOST = process.env.HOST || '127.0.0.1'; // 0.0.0.0 才能被局域网访问
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // 不设则无需口令
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20); // 每个 IP 每小时次数
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2); // 同时生成上限

// ── 工具函数 ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 30000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── 访问控制与限流（给别人用时防止 key 被刷）───────────────────────
const rateState = new Map(); // ip -> { count, resetAt }
let running = 0;

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function takeRate(ip) {
  const now = Date.now();
  let entry = rateState.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 3600_000 };
    rateState.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return urls;
}

// ── 模型调用 ──────────────────────────────────────────────────────
async function callModel(messages, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`模型接口返回 ${res.status}：${detail}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('模型没有返回内容');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── 提示词 ────────────────────────────────────────────────────────
function dimensionMessages(scenario, dim, brief) {
  return [
    {
      role: 'system',
      content: `你是班级事务「${scenario.title}」场景中的${dim.label}。只输出 markdown 正文，不寒暄、不写“已保存为文件”之类的话。`,
    },
    {
      role: 'user',
      content: `【${scenario.title}】

事项简报：
${brief}

你负责「${dim.label}」：${dim.focus}

要求：具体、可执行；能用表格就用表格；不确定的信息标「待确认」，不要编造。`,
    },
  ];
}

function mergeMessages(scenario, brief, sections, failures) {
  const parts = Object.entries(sections)
    .map(([key, text]) => {
      const dim = scenario.dimensions.find((d) => d.key === key);
      return `【${dim ? dim.label : key}】\n${text}`;
    })
    .join('\n\n');
  const missing = failures.length
    ? `\n注意：以下部分生成失败，请根据其他部分补全并标注：${failures.join('、')}\n`
    : '';
  return [
    { role: 'system', content: `你是「${scenario.title}」的总负责人。只输出 markdown 正文，不写寒暄。` },
    {
      role: 'user',
      content: `你是「${scenario.title}」的总负责人。请把下面 ${Object.keys(sections).length} 份材料合并成一份可以直接使用的工作成果，输出 markdown 正文。

要求：
1. 结构统一为：${scenario.outline}。
2. 消除重复，统一数字与口径，前后一致。
3. 材料之间如有冲突或不一致，不要擅自改掉关键事实，集中写进「待确认事项」，注明各自口径与建议处理。
4. 不要保留“同文已存为文件”“已保存”这类与成果无关的表述。
5. 语言简洁，表格优先，能直接发给辅导员、班委或同学使用。
${missing}
事项简报：
${brief}

${parts}`,
    },
  ];
}

// ── 演示模式 ──────────────────────────────────────────────────────
async function runMock(scenario, send) {
  for (const dim of scenario.dimensions) {
    send({ type: 'agent', key: dim.key, status: 'running' });
    await sleep(320 + Math.random() * 320);
    send({ type: 'agent', key: dim.key, status: 'done' });
  }
  send({ type: 'agent', key: 'merge', status: 'running' });
  await sleep(520);
  send({ type: 'agent', key: 'merge', status: 'done' });
  send({ type: 'final', text: scenario.mock });
}

// ── 真实流水线：多路并行 → 合成 ───────────────────────────────────
async function runPipeline(scenario, brief, send) {
  const settled = await Promise.allSettled(
    scenario.dimensions.map(async (dim) => {
      send({ type: 'agent', key: dim.key, status: 'running' });
      const text = await callModel(dimensionMessages(scenario, dim, brief), 3200);
      send({ type: 'agent', key: dim.key, status: 'done', text });
      return { key: dim.key, text };
    }),
  );

  const sections = {};
  const failures = [];
  settled.forEach((result, index) => {
    const dim = scenario.dimensions[index];
    if (result.status === 'fulfilled') {
      sections[result.value.key] = result.value.text;
    } else {
      failures.push(dim.label);
      send({ type: 'agent', key: dim.key, status: 'error' });
      console.error(`[${dim.label}] 失败：`, result.reason?.message || result.reason);
    }
  });

  if (Object.keys(sections).length === 0) {
    throw new Error('所有智能体都失败了，请检查密钥、网络或 BASE_URL 配置');
  }

  send({ type: 'agent', key: 'merge', status: 'running' });
  const merged = await callModel(mergeMessages(scenario, brief, sections, failures), 5000);
  send({ type: 'agent', key: 'merge', status: 'done' });
  send({ type: 'final', text: merged });
}

// ── HTTP 服务 ────────────────────────────────────────────────────
async function handlePlan(req, res) {
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) {
    return json(res, 401, { error: '需要访问口令', needCode: true });
  }

  let scenario = null;
  let brief = '';
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw.replace(/^\uFEFF/, ''));
    scenario = findScenario(String(body.scenarioId || 'activity'));
    brief = String(body.brief || '').trim();
  } catch {
    return json(res, 400, { error: '请求格式不对' });
  }
  if (!scenario) return json(res, 400, { error: '不认识这个场景' });
  if (brief.length < 5) return json(res, 400, { error: '事项描述太短了，至少写 5 个字' });
  if (brief.length > MAX_BRIEF) brief = brief.slice(0, MAX_BRIEF);

  const ip = clientIp(req);
  if (!takeRate(ip)) return json(res, 429, { error: `这个小时生成次数用完了（上限 ${RATE_LIMIT} 次），过会儿再来` });
  if (running >= MAX_CONCURRENT) return json(res, 503, { error: '当前有人在生成，稍等一分钟再来' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
  };

  send({
    type: 'start',
    mock: !API_KEY,
    scenario: { id: scenario.id, title: scenario.title },
    agents: [
      ...scenario.dimensions.map((d) => ({ key: d.key, label: d.label })),
      { key: 'merge', label: '合成成果' },
    ],
  });

  running += 1;
  try {
    if (!API_KEY) await runMock(scenario, send);
    else await runPipeline(scenario, brief, send);
  } catch (err) {
    console.error('[pipeline]', err);
    send({ type: 'error', message: err?.message || String(err) });
  } finally {
    running -= 1;
  }
  res.end();
}

async function serveStatic(res, relPath) {
  try {
    const file = path.join(__dirname, relPath);
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: '文件不存在' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, 'public/index.html');
    }
    if (req.method === 'GET' && url.pathname === '/md.js') {
      return serveStatic(res, 'public/md.js');
    }
    if (req.method === 'GET' && url.pathname === '/scenarios') {
      return json(res, 200, { scenarios: publicScenarios() });
    }
    if (req.method === 'GET' && url.pathname === '/config') {
      return json(res, 200, { needCode: Boolean(ACCESS_CODE), mock: !API_KEY, rateLimit: RATE_LIMIT });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, mock: !API_KEY, model: MODEL, scenarios: SCENARIOS.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      return handlePlan(req, res);
    }
    return json(res, 404, { error: '页面不存在' });
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  端口 ${PORT} 已被占用，可能已经有一个服务在跑了。`);
    console.log(`  直接打开：http://127.0.0.1:${PORT}`);
    console.log('  想换个端口：先执行 set PORT=8788 再启动。');
    console.log('');
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  班级事务工作台已启动');
  console.log(`  地址：http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') {
    const urls = lanUrls(PORT);
    if (urls.length) {
      console.log('  局域网（同一 Wi-Fi 的同学可访问）：');
      for (const u of urls) console.log(`    ${u}`);
    }
  }
  console.log(`  模式：${API_KEY ? `真实生成（${MODEL}）` : '演示模式（未设置 DEEPSEEK_API_KEY）'}`);
  console.log(`  场景：${SCENARIOS.length} 个（活动、评优、收集、通知、纪要、班会、述职、简报、通用）`);
  console.log(`  口令：${ACCESS_CODE ? '已开启' : '未设置（建议开放给他人时设置 ACCESS_CODE）'}`);
  console.log(`  限流：每 IP 每小时 ${RATE_LIMIT} 次，同时最多 ${MAX_CONCURRENT} 个生成`);
  console.log('  停止：Ctrl + C');
  console.log('');
});

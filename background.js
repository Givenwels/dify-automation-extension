// 本地 DSL 预检用的 YAML 解析器（导入前先拦住语法/结构错误）
try { importScripts('vendor/js-yaml.min.js'); } catch (e) { /* 加载失败时跳过预检 */ }

// ===== 配置 =====
const DEFAULTS = {
  llmBase: 'https://openrouter.ai/api/v1',
  llmKey: '',
  model: 'xiaomi/mimo-v2.5',
  fastModel: 'deepseek/deepseek-chat-v3.1', // 快聊模式专用：非推理模型，秒回
  customPrompt: '',
  difyBase: '',
  difyToken: '',   // 旧版 Dify 的 localStorage token；新版为空，走 Cookie 登录态
  difyRefresh: '',
  difyTabId: 0,    // 用于页面转发兜底的 Dify 标签页
  difyRelay: false, // Cookie 直连失败时，改由 Dify 页面代发请求
};

const MAX_ITERATIONS = 24;
const TOOL_RESULT_LIMIT = 9000;
const NO_DIFY_MSG = '没连上 Dify：请打开并登录 Dify（自建地址或 cloud.dify.ai），刷新一下 Dify 页面（登录凭证每小时轮换），再点「检测」';

async function getSettings() {
  const s = Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS)));
  // 之前保存过的空值不能盖掉新默认值
  if (!s.llmBase) s.llmBase = DEFAULTS.llmBase;
  if (!s.model) s.model = DEFAULTS.model;
  if (!s.llmKey) s.llmKey = DEFAULTS.llmKey;
  if (!s.fastModel) s.fastModel = DEFAULTS.fastModel;
  return s;
}
async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeBase = (b) => (b || '').trim().replace(/\/+$/, '');

// 点击图标：打开侧边栏 + 自动跳到 Dify 标签页（没开就新开一个）
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) { /* 面板可能已开 */ }
  const s = await getSettings();
  if (!s.difyBase) return;
  const tabs = await chrome.tabs.query({ url: s.difyBase + '/*' });
  let target = tabs[0];
  if (!target) {
    target = await chrome.tabs.create({ url: s.difyBase });
  }
  chrome.tabs.update(target.id, { active: true });
  if (target.windowId) {
    try { await chrome.windows.update(target.windowId, { focused: true }); } catch (e) { /* 窗口没了 */ }
  }
});

// ===== Dify 检测 =====
// Dify 接口返回特征（/setup 各版本都有 step 字段，最稳；/features 新旧版字段不同，都认）
function looksDifyFeatures(j) {
  if (!j || typeof j !== 'object') return false;
  if ('step' in j) return true; // /setup
  if ('install_mode' in j || 'features' in j || 'version' in j) return true; // 旧版 /features
  if ('docs_processing' in j && 'annotation_quota_limit' in j) return true; // 新版 /features
  if ('deployment_edition' in j && 'is_allow_register' in j) return true; // /system-features
  return false;
}

// 必须通过 Dify 接口验证才算 Dify（其他站点 localStorage 里也可能有同名 console_token，
// 比如 DeepSeek 开放平台，误认会把请求全打到错误域名上）。
// 新版 Dify 强制校验 X-CSRF-Token（值来自 __Host-csrf_token/csrf_token Cookie），缺了就 401。
// 新版 Dify 用 Cookie 登录态，旧版仍有 console_token，取出仅作鉴权备用。
function probeDifyPage() {
  const lsRaw = localStorage.getItem('console_token');
  let bearer = '';
  if (lsRaw) {
    try { bearer = JSON.parse(lsRaw)?.token || lsRaw; } catch { bearer = lsRaw; }
  }
  const raw = document.cookie.split('; ').find((c) => c.startsWith('__Host-csrf_token=') || c.startsWith('csrf_token=')) || '';
  const csrf = raw.includes('=') ? decodeURIComponent(raw.split('=').slice(1).join('=')) : '';
  const headers = {};
  if (bearer && String(bearer).length > 20) headers.Authorization = 'Bearer ' + bearer;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const looksDify = (j) => {
    if (!j || typeof j !== 'object') return false;
    if ('step' in j) return true; // /setup，所有版本都有
    if ('install_mode' in j || 'features' in j || 'version' in j) return true; // 旧版 /features
    if ('docs_processing' in j && 'annotation_quota_limit' in j) return true; // 新版 /features
    if ('deployment_edition' in j && 'is_allow_register' in j) return true; // /system-features
    return false;
  };
  const probe = (path) =>
    fetch(location.origin + path, { credentials: 'include', cache: 'no-store', headers, signal: AbortSignal.timeout(15000) }).then((r) =>
      r.json().catch(() => null).then((j) => ({ status: r.status, ok: r.ok, j: r.ok ? j : null }))
    );
  const hit = { isDify: true, origin: location.origin, bearer: bearer && String(bearer).length > 20 ? String(bearer) : '' };
  return (async () => {
    let last = { status: 0, j: null };
    for (const path of ['/console/api/setup', '/console/api/features', '/console/api/system-features']) {
      try {
        const res = await probe(path);
        last = res;
        if (res.j && looksDify(res.j)) return hit;
      } catch (e) { /* 试下一个 */ }
    }
    return { isDify: false, status: last.status, snippet: last.j ? JSON.stringify(last.j).slice(0, 150) : '' };
  })();
}

async function detectDify() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const origins = [];
  for (const t of tabs) {
    try {
      const o = new URL(t.url).origin;
      if (!origins.includes(o)) origins.push(o);
    } catch (e) { /* 忽略坏 URL */ }
  }
  // 域名里带 dify 的排前面，先测最可能的
  origins.sort((a, b) => (b.includes('dify') ? 1 : 0) - (a.includes('dify') ? 1 : 0));
  const detail = [];
  for (const origin of origins) {
    // 第一层：后台带 Cookie + CSRF 直接探测——与后续真实请求同一条路径，最可信
    try {
      const cks = await chrome.cookies.getAll({ url: origin + '/console/api/features' });
      const cfind = (names) => {
        for (const n of names) {
          const c = cks.find((x) => x.name === n);
          if (c) return c.value;
        }
        return '';
      };
      const csrf = cfind(['__Host-csrf_token', 'csrf_token']);
      const headers = csrf ? { 'X-CSRF-Token': csrf } : {};
      const probe = (path) =>
        fetch(origin + path, { credentials: 'include', cache: 'no-store', headers, signal: AbortSignal.timeout(15000) }).then((r) =>
          r.json().catch(() => null).then((j) => ({ status: r.status, j: r.ok ? j : null }))
        );
      let ok = false, lastStatus = 0, snippet = '';
      for (const path of ['/console/api/setup', '/console/api/features', '/console/api/system-features']) {
        try {
          const res = await probe(path);
          lastStatus = res.status;
          if (res.j && looksDifyFeatures(res.j)) { ok = true; break; }
          if (res.j && !snippet) snippet = JSON.stringify(res.j).slice(0, 120);
        } catch (e) { /* 试下一个 */ }
      }
      if (ok) {
        const tab = tabs.find((t) => { try { return new URL(t.url).origin === origin; } catch { return false; } });
        await saveSettings({ difyBase: origin, difyToken: '', difyRefresh: '', difyTabId: tab ? tab.id : 0, difyRelay: false });
        return { ok: true, base: origin };
      }
      detail.push(origin + ' 接口探测 HTTP ' + lastStatus + (snippet ? ' 响应:' + snippet : '(非Dify)'));
    } catch (e) {
      detail.push(origin + ' 接口探测失败');
    }
    // 第二层：注入页面探测（旧版 token / 页面转发通道）
    const tab = tabs.find((t) => { try { return new URL(t.url).origin === origin; } catch { return false; } });
    if (!tab) continue;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: probeDifyPage,
      });
      const pr = res?.result;
      if (pr && pr.isDify) {
        await saveSettings({
          difyBase: pr.origin,
          difyToken: pr.bearer || '',
          difyRefresh: '',
          difyTabId: tab.id,
          difyRelay: !pr.bearer, // 后台 Cookie 直连不通，后续改走页面转发
        });
        return { ok: true, base: pr.origin };
      }
      detail.push(origin + ' 页面探测 HTTP ' + (pr ? pr.status : '?'));
    } catch (e) {
      detail.push(origin + ' 页面注入失败');
    }
  }
  return { ok: false, detail: detail.slice(0, 3).join('；') };
}

// 读取 Dify 域下的 CSRF Cookie（新版 Cookie 鉴权写请求必须带 X-CSRF-Token）
async function csrfHeaders(s) {
  try {
    const cookies = await chrome.cookies.getAll({ url: s.difyBase });
    const find = (names) => {
      for (const n of names) {
        const c = cookies.find((x) => x.name === n);
        if (c) return c.value;
      }
      return '';
    };
    const csrf = find(['__Host-csrf_token', 'csrf_token']);
    return csrf ? { 'X-CSRF-Token': csrf } : {};
  } catch (e) {
    return {};
  }
}

// 找到可用的 Dify 标签页（页面转发兜底用）
async function findDifyTab(s) {
  if (s.difyTabId) {
    try {
      const t = await chrome.tabs.get(s.difyTabId);
      if (t && (t.url || '').startsWith(s.difyBase)) return t.id;
    } catch (e) { /* 标签页没了，重新找 */ }
  }
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const hit = tabs.find((t) => (t.url || '').startsWith(s.difyBase));
  if (!hit) throw new Error('Dify 页面被关掉了：重新打开 Dify 再点「检测」');
  await saveSettings({ difyTabId: hit.id });
  s.difyTabId = hit.id;
  return hit.id;
}

// 兜底通道：把请求交给 Dify 页面自己发（同源 + 自动带 Cookie，最贴近浏览器里的真实登录态）
async function relayFetch(s, path, method, body) {
  const tabId = await findDifyTab(s);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (p, m, b, csrfHeaderName) => {
      const raw = (document.cookie.split('; ').find((c) => c.startsWith('__Host-csrf_token=') || c.startsWith('csrf_token=')) || '');
      const csrf = raw.includes('=') ? decodeURIComponent(raw.split('=').slice(1).join('=')) : '';
      const headers = {};
      if (b !== null) headers['Content-Type'] = 'application/json';
      if (csrf) headers[csrfHeaderName] = csrf;
      try {
        const r = await fetch(location.origin + p, {
          method: m,
          credentials: 'include',
          headers,
          body: b === null ? undefined : JSON.stringify(b),
        });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: String(e) };
      }
    },
    args: [path, method, body === undefined ? null : body, 'X-CSRF-Token'],
  });
  const out = res?.result;
  if (!out) throw new Error('Dify 页面转发失败');
  if (out.status === 0) throw new Error('Dify 页面网络异常: ' + out.text.slice(0, 200));
  if (out.status === 401 || out.status === 403) {
    throw new Error('Dify 登录已过期：去 Dify 页面刷新一下登录，再回来点「检测」');
  }
  if (out.status >= 400) {
    let msg = out.text.slice(0, 300);
    try { const j = JSON.parse(out.text); msg = j.error || j.message || msg; } catch { /* 原样 */ }
    throw new Error('HTTP ' + out.status + ': ' + msg);
  }
  return out.text;
}

function parseJsonLoose(text) {
  const t = (text || '').trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 500) }; }
}

// 旧版 token 模式的续期
async function tryRefresh(s) {
  if (!s.difyBase || !s.difyRefresh) return false;
  try {
    const res = await fetch(normalizeBase(s.difyBase) + '/console/api/refresh-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.difyRefresh }),
    });
    const data = await res.json().catch(() => ({}));
    const t = data?.data?.access_token || data?.access_token || data?.data?.token;
    const rt = data?.data?.refresh_token || data?.refresh_token;
    if (res.ok && t) {
      await saveSettings(rt ? { difyToken: t, difyRefresh: rt } : { difyToken: t });
      return true;
    }
  } catch (e) { /* 刷新失败走重检测 */ }
  return false;
}

async function recoverToken(s) {
  if (await tryRefresh(s)) { s.difyToken = (await getSettings()).difyToken; return true; }
  const r = await detectDify();
  if (r.ok) { s.difyToken = (await getSettings()).difyToken; return true; }
  return false;
}

// Cookie 模式的会话续期：CSRF/访问令牌约每小时轮换，学 Dify 页面调 refresh-token 换新
async function recoverCookieSession(s) {
  if (!s.difyBase) return false;
  const tryRefresh = async (body) => {
    try {
      const res = await fetch(normalizeBase(s.difyBase) + '/console/api/refresh-token', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  };
  if (await tryRefresh('{}')) return true;
  try {
    const cks = await chrome.cookies.getAll({ url: s.difyBase });
    const rt = cks.find((c) => c.name === '__Host-refresh_token' || c.name === 'refresh_token');
    if (rt && (await tryRefresh(JSON.stringify({ refresh_token: rt.value })))) return true;
  } catch (e) { /* 刷新失败 */ }
  return false;
}

async function ensureDify(s) {
  if (!s.difyBase && !(await detectDify()).ok) throw new Error(NO_DIFY_MSG);
}

// ===== Dify API 调用（三层：旧版 token / Cookie 直连 / 页面转发）=====
// 每个请求都带 30s 超时 + 可选的外部中断信号（点「停止」立刻掐断）
async function difyFetch(s, path, { method = 'GET', body, retry = true, signal } = {}) {
  await ensureDify(s);
  if (s.difyRelay && !s.difyToken) {
    return parseJsonLoose(await relayFetch(s, path, method, body));
  }
  const headers = {};
  // 有 body 才声明 JSON，否则无 body 的 POST（如 publish）会被 Flask 400 拒掉
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (s.difyToken) headers.Authorization = 'Bearer ' + s.difyToken;
  Object.assign(headers, await csrfHeaders(s));
  const timeout = AbortSignal.timeout(30000);
  const res = await fetch(normalizeBase(s.difyBase) + path, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 403) {
    if (retry && s.difyToken && (await recoverToken(s))) {
      return difyFetch(s, path, { method, body, retry: false, signal });
    }
    if (retry && !s.difyToken) {
      if (await recoverCookieSession(s)) {
        return difyFetch(s, path, { method, body, retry: false, signal });
      }
      try {
        const text = await relayFetch(s, path, method, body);
        await saveSettings({ difyRelay: true });
        s.difyRelay = true;
        return parseJsonLoose(text);
      } catch (e) {
        throw new Error('Dify 登录已过期：请刷新 Dify 页面（会换新登录凭证），然后重试');
      }
    }
    throw new Error('Dify 登录已过期：去 Dify 页面刷新一下登录，再回来点「检测」');
  }
  const text = await res.text();
  const data = parseJsonLoose(text);
  if (!res.ok) {
    const msg = data?.error || data?.message || data?.raw || text.slice(0, 300);
    throw new Error('HTTP ' + res.status + ': ' + msg);
  }
  return data;
}

// SSE 事件归类（流式和整段转发共用）
function handleWorkflowEvent(evt, st) {
  const d = evt.data || evt;
  if ((evt.event === 'node_finished' || d?.status) && d.status === 'failed') {
    st.nodeFails.push({ node: d.title || d.node_id, error: String(d.error || '').slice(0, 300) });
  } else if (d?.status === 'succeeded') {
    st.okNodes++;
  }
  if (evt.event === 'workflow_finished') {
    st.outputs = d.outputs ?? null;
    if (d.status === 'failed') st.nodeFails.push({ node: 'workflow', error: String(d.error || '') });
  }
  if (evt.event === 'error') st.errorEvt = String(evt.message || evt.error || '未知错误').slice(0, 300);
}

function summarizeRun(st) {
  return {
    success: st.nodeFails.length === 0 && !st.errorEvt,
    nodes_succeeded: st.okNodes,
    node_failures: st.nodeFails,
    outputs: st.outputs,
    ...(st.errorEvt ? { error: st.errorEvt } : {}),
  };
}

function parseSseText(full) {
  const st = { nodeFails: [], outputs: null, errorEvt: null, okNodes: 0 };
  for (const line of String(full).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try { handleWorkflowEvent(JSON.parse(t.slice(5).trim()), st); } catch { /* 跳过坏行 */ }
  }
  return summarizeRun(st);
}

// 草稿运行（SSE）
async function difyRunStream(s, path, body, signal, onProgress) {
  await ensureDify(s);
  if (s.difyRelay && !s.difyToken) {
    return parseSseText(await relayFetch(s, path, 'POST', body));
  }
  const runOnce = async () => {
    const headers = { 'Content-Type': 'application/json' };
    if (s.difyToken) headers.Authorization = 'Bearer ' + s.difyToken;
    Object.assign(headers, await csrfHeaders(s));
    const timeout = AbortSignal.timeout(120000);
    return fetch(normalizeBase(s.difyBase) + path, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  };
  let res = await runOnce();
  if ((res.status === 401 || res.status === 403) && !s.difyToken && (await recoverCookieSession(s))) {
    res = await runOnce();
  }
  if ((res.status === 401 || res.status === 403) && !s.difyToken) {
    try {
      return parseSseText(await relayFetch(s, path, 'POST', body));
    } catch (e) {
      throw new Error('Dify 登录已过期：请刷新 Dify 页面（会换新登录凭证），然后重试');
    }
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 300));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const st = { nodeFails: [], outputs: null, errorEvt: null, okNodes: 0 };
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim());
        const d = evt.data || evt;
        if (onProgress) {
          if (evt.event === 'node_started') onProgress('运行节点「' + (d.title || '') + '」…');
          else if (evt.event === 'node_finished') onProgress('节点「' + (d.title || '') + '」' + (d.status === 'failed' ? '失败 ✗' : '完成 ✓'));
          else if (evt.event === 'workflow_started') onProgress('工作流开始运行…');
        }
        handleWorkflowEvent(evt, st);
      } catch (e) { /* 跳过坏行 */ }
    }
  }
  return summarizeRun(st);
}

// graph 组装：已有节点位置原样保留，新节点自动跟在上游节点右侧（画布可读、不叠罗汉）
function buildGraph(submitted, current) {
  const oldById = new Map(((current?.graph || {}).nodes || []).map((n) => [n.id, n]));
  const edgesSub = submitted.edges || [];
  const parentOf = {};
  edgesSub.forEach((e) => { if (e && e.target && e.source) parentOf[e.target] = e.source; });
  // 第一遍：建节点，新节点先给网格占位
  const items = (submitted.nodes || []).map((n, i) => {
    const old = oldById.get(n.id) || {};
    return {
      raw: n,
      old,
      isNew: !old.id,
      position: n.position || old.position || { x: 80 + (i % 4) * 300, y: 80 + Math.floor(i / 4) * 180 },
    };
  });
  // 第二遍：没有显式位置的新节点，放到上游节点右侧
  const posById = new Map(items.map((x) => [x.raw.id, x.position]));
  for (const item of items) {
    if (item.raw.position || item.old.position) continue;
    const srcId = parentOf[item.raw.id];
    const src = srcId ? posById.get(srcId) : null;
    if (src) {
      const siblings = items.filter((x) => parentOf[x.raw.id] === srcId && x.isNew);
      item.position = { x: src.x + 320, y: src.y + siblings.indexOf(item) * 60 };
    }
  }
  const nodes = items.map((x) => ({
    id: x.raw.id,
    type: 'custom',
    data: x.raw.data || {},
    position: x.position,
    positionAbsolute: { ...x.position },
    selected: false,
    sourcePosition: 'right',
    targetPosition: 'left',
    width: x.raw.width || x.old.width || 244,
    height: x.raw.height || x.old.height || 120,
  }));
  const typeById = new Map(nodes.map((n) => [n.id, n.data?.type || '']));
  const edges = (submitted.edges || []).map((e, i) => ({
    id: e.id || 'edge_' + i + '_' + e.source,
    source: e.source,
    sourceHandle: e.sourceHandle || 'source',
    target: e.target,
    targetHandle: e.targetHandle || 'target',
    type: 'custom',
    zIndex: e.zIndex ?? 0,
    data: { isInIteration: false, sourceType: typeById.get(e.source) || '', targetType: typeById.get(e.target) || '' },
  }));
  return { nodes, edges };
}

// 上下文接线自检修复：AI 最容易漏配「知识库检索 → LLM 上下文」，这里用代码强制补齐
function autoFixContextWiring(graph) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const fixes = [];
  const kbNodes = nodes.filter((n) => n.data && n.data.type === 'knowledge-retrieval');
  if (!kbNodes.length) return { graph, fixes };
  const startNode = nodes.find((n) => n.data && n.data.type === 'start');
  const llms = nodes.filter((n) => n.data && n.data.type === 'llm');
  for (const kb of kbNodes) {
    // 补 query_variable_selector（用户问题来源）
    if (startNode && (!Array.isArray(kb.data.query_variable_selector) || kb.data.query_variable_selector.length === 0)) {
      const firstVar = (startNode.data.variables || [])[0];
      if (firstVar) {
        kb.data.query_variable_selector = [startNode.id, firstVar.variable];
        fixes.push('知识库节点 ' + kb.id + ' 的 query_variable_selector 指向 start.' + firstVar.variable);
      }
    }
    // prompt 引用了知识库变量但没连线 → 补边
    for (const llm of llms) {
      const refs = (llm.data.prompt_template || []).some(
        (p) => typeof p.text === 'string' && p.text.includes('{{#' + kb.id + '.')
      );
      if (refs && !edges.some((e) => e.source === kb.id && e.target === llm.id)) {
        edges.push({
          id: 'edge_' + kb.id + '_' + llm.id,
          source: kb.id,
          sourceHandle: 'source',
          target: llm.id,
          targetHandle: 'target',
          type: 'custom',
          zIndex: 0,
          data: { isInIteration: false, sourceType: 'knowledge-retrieval', targetType: 'llm' },
        });
        fixes.push('补连线：' + kb.id + ' → ' + llm.id);
      }
    }
    // 直接下游的 LLM：context 没开/没指向 → 强制指向知识库输出
    const downstream = edges.filter((e) => e.source === kb.id).map((e) => e.target);
    for (const llm of llms) {
      if (!downstream.includes(llm.id)) continue;
      llm.data = llm.data || {};
      llm.data.context = llm.data.context || {};
      const ctx = llm.data.context;
      if (ctx.enabled !== true || !Array.isArray(ctx.variable_selector) || ctx.variable_selector.length === 0) {
        llm.data.context = { enabled: true, variable_selector: [kb.id, 'result'] };
        fixes.push('LLM ' + llm.id + ' 的上下文已指向知识库 ' + kb.id + '.result');
      }
      // prompt 里没引用 {{#context#}} → 注入到 system
      const tpl = llm.data.prompt_template || [];
      const hasCtxVar = tpl.some((p) => typeof p.text === 'string' && p.text.includes('{{#context#}}'));
      if (llm.data.context.enabled === true && !hasCtxVar && tpl.length) {
        const sys = tpl.find((p) => p.role === 'system') || tpl[0];
        sys.text = (sys.text || '') + '\n\n请根据以下参考资料回答用户问题：\n{{#context#}}';
        fixes.push('LLM ' + llm.id + ' 的 prompt 已注入 {{#context#}}');
      }
    }
  }
  return { graph, fixes };
}

// 模型配置自检：核对每个 LLM 节点的 provider+name 是否真实存在，能修则修，修不了把可用列表回给 AI
async function autoFixModelConfig(graph, s, signal) {
  const fixes = [];
  const llms = (graph.nodes || []).filter((n) => n.data && n.data.type === 'llm' && n.data.model && n.data.model.name);
  if (!llms.length) return { fixes };
  let models = [];
  try {
    const d = await difyFetch(s, '/console/api/workspaces/current/models/model-types/llm', { signal });
    for (const p of d.data || []) {
      for (const m of p.models || []) {
        if (m.model) models.push({ model: m.model, provider: p.provider });
      }
    }
  } catch (e) {
    return { fixes };
  }
  if (!models.length) return { fixes };
  const norm = (v) => String(v || '').toLowerCase().replace(/[\s_-]/g, '');
  const exact = (provider, name) => models.find((x) => x.provider === provider && x.model === name);
  for (const n of llms) {
    const mdl = n.data.model;
    if (exact(mdl.provider, mdl.name)) continue;
    const sameName = models.filter((x) => x.model === mdl.name);
    if (sameName.length) {
      fixes.push('LLM ' + n.id + ' 的 provider 从 "' + mdl.provider + '" 修正为 "' + sameName[0].provider + '"（模型 ' + mdl.name + ' 实际属于它）');
      mdl.provider = sameName[0].provider;
      continue;
    }
    const sameProv = models.filter((x) => x.provider === mdl.provider);
    const close = sameProv.find((x) => norm(x.model) === norm(mdl.name));
    // 用户默认模型：Dify 里 OpenRouter 供应商下配置的小米 MiMo
    const pref = models.find((x) => x.provider.toLowerCase().includes('openrouter') && x.model.toLowerCase().includes('mimo'))
      || models.find((x) => x.model.toLowerCase().includes('mimo'));
    if (close) {
      fixes.push('LLM ' + n.id + ' 的模型名从 "' + mdl.name + '" 修正为 "' + close.model + '"');
      mdl.name = close.model;
    } else if (pref) {
      fixes.push('LLM ' + n.id + ' 的模型 "' + mdl.provider + '/' + mdl.name + '" 不存在，已改为默认的 ' + pref.provider + '/' + pref.model);
      mdl.provider = pref.provider;
      mdl.name = pref.model;
    } else if (sameProv.length) {
      fixes.push('警告：LLM ' + n.id + ' 的模型 ' + mdl.provider + '/' + mdl.name + ' 不存在，该供应商可用模型：' + sameProv.map((x) => x.model).join(', '));
    } else {
      fixes.push('警告：LLM ' + n.id + ' 的 provider "' + mdl.provider + '" 不可用，可用 provider：' + [...new Set(models.map((x) => x.provider))].join(', '));
    }
  }
  return { fixes };
}

function condenseDraft(draft) {
  const graph = draft.graph || {};
  return {
    app_mode: draft.app_mode,
    features: draft.features,
    nodes: (graph.nodes || []).map((n) => ({ id: n.id, type: n.data?.type, title: n.data?.title, data: n.data })),
    edges: (graph.edges || []).map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle })),
  };
}

// DSL 本地预检：把导入后才会暴露的问题提前到提交前（AI 生成复杂 DSL 最容易犯的错全在这查）
function validateDsl(yamlText) {
  const errors = [], warnings = [];
  let doc;
  try {
    doc = jsyaml.load(yamlText);
  } catch (e) {
    return { errors: ['YAML 语法错误: ' + String(e.message || e).slice(0, 300)], warnings };
  }
  if (!doc || typeof doc !== 'object') return { errors: ['DSL 为空或不是对象'], warnings };
  const app = doc.app || {};
  if (!app.name) errors.push('缺少 app.name');
  if (app.mode !== 'workflow' && app.mode !== 'advanced-chat') {
    warnings.push('app.mode 为 "' + (app.mode || '空') + '"，应为 workflow 或 advanced-chat');
  }
  const graph = (doc.workflow || {}).graph || {};
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  if (!nodes.length) return { errors: ['workflow.graph.nodes 为空'], warnings };
  const ids = new Set(nodes.map((n) => n.id));
  const types = nodes.map((n) => n.data && n.data.type);
  if (!types.includes('start')) errors.push('缺少 start 开始节点');
  if (app.mode === 'advanced-chat' && !types.includes('answer')) errors.push('对话型应用缺少 answer 结尾节点');
  if ((app.mode || 'workflow') === 'workflow' && !types.includes('end')) errors.push('缺少 end 结束节点');
  for (const e of edges) {
    if (!ids.has(e.source)) errors.push('连线 ' + (e.id || '?') + ' 的 source "' + e.source + '" 不是任何节点 id');
    if (!ids.has(e.target)) errors.push('连线 ' + (e.id || '?') + ' 的 target "' + e.target + '" 不是任何节点 id');
  }
  const skipRef = (id) => ['sys', 'env', 'conversation'].includes(id);
  for (const n of nodes) {
    const texts = [];
    const pt = n.data && n.data.prompt_template;
    if (Array.isArray(pt)) for (const p of pt) if (p && typeof p.text === 'string') texts.push(p.text);
    if (typeof (n.data && n.data.answer) === 'string') texts.push(n.data.answer);
    for (const t of texts) {
      const re = /\{\{#([^#.]+)\.([^#}]+)#\}\}/g;
      let m;
      while ((m = re.exec(t))) {
        if (!skipRef(m[1]) && !ids.has(m[1])) warnings.push('节点 ' + n.id + ' 引用了不存在的节点 ' + m[1] + '（字段 ' + m[2] + '）');
      }
    }
    if (n.data && n.data.type === 'if-else') {
      const outs = edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle);
      for (const h of ['true', 'false']) {
        if (!outs.includes(h)) warnings.push('if-else 节点 ' + n.id + ' 缺少 ' + h + ' 分支连线');
      }
    }
    if (n.data && n.data.type === 'question-classifier') {
      const outs = edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle);
      for (const c of n.data.classes || []) {
        if (!outs.includes(String(c.id))) warnings.push('问题分类器 ' + n.id + ' 的类别「' + (c.name || c.id) + '」没有连线');
      }
    }
    if (n.data && n.data.type === 'tool' && (!n.data.provider_id || !n.data.tool_name)) {
      errors.push('tool 节点 ' + n.id + ' 缺少 provider_id/tool_name（必须用 list_tools 返回的真实值，禁止编造）');
    }
    if (n.data && n.data.type === 'llm' && (!Array.isArray(n.data.prompt_template) || n.data.prompt_template.length === 0)) {
      errors.push('LLM 节点 ' + n.id + ' 缺少 prompt_template');
    }
  }
  // 环检测：工作流不允许循环引用
  const adj = {};
  for (const e of edges) (adj[e.source] = adj[e.source] || []).push(e.target);
  const state = {};
  let hasCycle = false;
  const dfs = (u) => {
    state[u] = 1;
    for (const v of adj[u] || []) {
      if (state[v] === 1) { hasCycle = true; return; }
      if (!state[v]) dfs(v);
      if (hasCycle) return;
    }
    state[u] = 2;
  };
  for (const n of nodes) {
    if (hasCycle) break;
    if (!state[n.id]) dfs(n.id);
  }
  if (hasCycle) errors.push('图中存在环：工作流不允许循环引用，批量/重试逻辑请用 code 循环实现');
  // 可达性：从 start 出发到不了的都是孤岛
  const startN = nodes.find((n) => n.data && n.data.type === 'start');
  if (startN) {
    const reach = new Set();
    const q = [startN.id];
    while (q.length) {
      const u = q.pop();
      if (reach.has(u)) continue;
      reach.add(u);
      for (const v of adj[u] || []) q.push(v);
    }
    for (const n of nodes) {
      if (!reach.has(n.id)) warnings.push('节点 ' + n.id + ' 从 start 不可达（孤岛节点）');
    }
  }
  // 节点 id 字符集：{{#引用#}} 只认字母/数字/下划线
  for (const n of nodes) {
    if (!/^[A-Za-z0-9_]{1,50}$/.test(String(n.id))) warnings.push('节点 id "' + n.id + '" 含字母/数字/下划线以外的字符，{{#引用#}} 插值可能失效');
  }
  // LLM 节点必须带 context 对象（disabled 也要有），if-else 必须有条件定义
  for (const n of nodes) {
    if (n.data && n.data.type === 'llm' && !n.data.context) {
      errors.push('LLM 节点 ' + n.id + ' 缺少 context 对象（不接知识库也要有：context:{enabled:false, variable_selector:[]}）');
    }
    if (n.data && n.data.type === 'if-else' && !n.data.cases && !n.data.conditions) {
      errors.push('if-else 节点 ' + n.id + ' 缺少 cases/conditions 条件定义');
    }
  }
  return { errors, warnings };
}

// ===== 工具实现 =====
async function executeTool(name, args, s, signal, onProgress) {
  const base = normalizeBase(s.difyBase);
  switch (name) {
    case 'list_models': {
      // 新版返回 {data: [{provider, label, models: [{model, ...}]}]}，按 provider 展开成 model+provider 对
      const d = await difyFetch(s, '/console/api/workspaces/current/models/model-types/llm', { signal });
      const list = [];
      for (const p of d.data || []) {
        for (const m of p.models || []) {
          if (m.model) list.push({ model: m.model, provider: p.provider, status: m.status || p.status });
        }
      }
      if (!list.length) {
        return {
          models: [],
          guidance: '工作区没有任何可用 LLM：请先让用户在 Dify「设置 → 模型供应商」安装模型插件并填入 API Key（例如 DeepSeek 官方插件，或 OpenRouter 插件），配置完成后重新调用 list_models 确认。模型可用之前，禁止创建含 LLM 节点的工作流，也不要反复重试。',
        };
      }
      return { models: list.slice(0, 80) };
    }
    case 'list_apps': {
      const d = await difyFetch(s, '/console/api/apps?page=1&limit=30', { signal });
      return { apps: (d.data || []).map((a) => ({ id: a.id, name: a.name, mode: a.mode })) };
    }
    case 'list_knowledge_bases': {
      const d = await difyFetch(s, '/console/api/datasets?page=1&limit=30', { signal });
      return { knowledge_bases: (d.data || []).map((k) => ({ id: k.id, name: k.name, embedding_available: k.embedding_available !== false })) };
    }
    case 'list_tools': {
      // 已安装的工具插件（builtin/api/workflow/mcp 四类），tool 节点接线的数据源
      const d = await difyFetch(s, '/console/api/workspaces/current/tool-providers', { signal });
      const providers = (d.data || []).map((p) => ({
        provider_id: p.id || p.name,
        type: p.type,
        label: p.label?.zh_Hans || p.label?.en_US || p.label || p.name,
        is_authorized: p.is_team_authorization !== false,
        tools: (p.tools || []).map((t) => ({
          provider_id: t.provider_id || p.id || p.name,
          tool_name: t.name || t.tool_name,
          label: t.label?.zh_Hans || t.label?.en_US || t.label || t.tool_name,
          description: String(t.description || '').slice(0, 120),
        })),
      }));
      const total = providers.reduce((n, p) => n + p.tools.length, 0);
      if (!total) {
        return {
          providers: providers.map((p) => ({ provider_id: p.provider_id, type: p.type, label: p.label })),
          guidance: '工作区还没有安装任何工具插件。工作流需要联网搜索/网页抓取/通知等能力时，请引导用户去 Dify「工具 → 安装插件」安装对应工具；也可以在「工具 → MCP」添加 MCP 服务器。装好后重新调用 list_tools。',
        };
      }
      return { providers };
    }
    case 'create_workflow': {
      // 防重复：同名应用已存在就直接复用（AI 遇错重试常造成重复创建）
      try {
        const la = await difyFetch(s, '/console/api/apps?page=1&limit=30', { signal });
        const name = String(args.name || '').trim();
        const existing = (la.data || []).find((a) => a.name === name && (a.mode === 'workflow' || a.mode === 'advanced-chat'));
        if (existing) {
          return {
            reused_existing: true,
            app_id: existing.id,
            name: existing.name,
            app_url: base + '/app/' + existing.id + '/workflow',
            hint: '同名应用已存在，直接复用它做修改；如确实要新建，请换一个名字',
          };
        }
      } catch (e) { /* 查不到列表就继续走创建 */ }
      const yaml = String(args.dsl_yaml || '');
      if (!yaml.trim()) throw new Error('dsl_yaml 不能为空');
      const modeMatch = yaml.match(/mode:\s*(workflow|advanced-chat)/);
      // 本地预检：语法/结构错误直接退回给 AI 修，不浪费导入也不产生垃圾应用
      if (typeof jsyaml !== 'undefined') {
        const v = validateDsl(yaml);
        if (v.errors.length) {
          return {
            dsl_rejected: true,
            errors: v.errors.slice(0, 8),
            warnings: v.warnings.slice(0, 8),
            hint: '修复以上问题后重新调用 create_workflow（应用名保持不变）',
          };
        }
      }
      let d;
      try {
        d = await difyFetch(s, '/console/api/apps/imports', {
          method: 'POST',
          body: { mode: 'yaml-content', yaml_content: yaml },
          signal,
        });
      } catch (e) {
        const blank = await difyFetch(s, '/console/api/apps', {
          method: 'POST',
          body: { name: args.name || '未命名工作流', mode: modeMatch ? modeMatch[1] : 'workflow', icon: '🤖', icon_background: '#FFEAD5' },
          signal,
        });
        return {
          import_failed: String(e.message || e).slice(0, 400),
          fallback: '已创建空白应用，请用 update_workflow_draft 写入 graph',
          app_id: blank.id,
          app_url: base + '/app/' + blank.id + '/workflow',
        };
      }
      const importWarnings = (d && d.warnings) || [];
      let appId = d.app_id;
      let status = d.import_status || d.status;
      if (!appId && d.import_id) {
        for (let i = 0; i < 10 && !appId; i++) {
          await sleep(1000);
          const st = await difyFetch(s, '/console/api/apps/imports/' + d.import_id + '/status', { signal });
          status = st.status || st.import_status;
          appId = st.app_id;
          if (st.warnings) importWarnings.push(...st.warnings);
        }
      }
      if (!appId) return { import_status: status || 'unknown', import_warnings: importWarnings, hint: '未拿到 app_id，请用 list_apps 查最新应用' };
      // 导入成功后自检：模型配置 + 上下文接线，有问题直接修复写回
      try {
        const cur = await difyFetch(s, '/console/api/apps/' + appId + '/workflows/draft', { signal });
        const mf = await autoFixModelConfig(cur.graph || {}, s, signal);
        const { graph, fixes } = autoFixContextWiring(cur.graph || {});
        const allFixes = [...(mf.fixes || []), ...fixes];
        if (allFixes.length) {
          await difyFetch(s, '/console/api/apps/' + appId + '/workflows/draft', {
            method: 'POST',
            body: { graph, features: cur.features || {}, conversation_variables: cur.conversation_variables || [] },
            signal,
          });
        }
        return {
          app_id: appId,
          import_status: status,
          app_url: base + '/app/' + appId + '/workflow',
          ...(importWarnings.length ? { import_warnings: importWarnings } : {}),
          ...(allFixes.length ? { context_auto_fixed: allFixes } : { context_check: '通过' }),
        };
      } catch (e) {
        return {
          app_id: appId,
          import_status: status,
          app_url: base + '/app/' + appId + '/workflow',
          note: '导入后自检未完成(不影响导入): ' + String(e.message || e).slice(0, 120),
        };
      }
    }
    case 'get_workflow_draft': {
      const d = await difyFetch(s, '/console/api/apps/' + args.app_id + '/workflows/draft', { signal });
      return condenseDraft(d);
    }
    case 'update_workflow_draft': {
      // 新版契约：POST /workflows/draft（extra=forbid）。带 hash 防并发冲突，409 自动刷新重提一次
      const doSync = async () => {
        const cur = await difyFetch(s, '/console/api/apps/' + args.app_id + '/workflows/draft', { signal });
        const built = buildGraph(args.graph || {}, cur);
        const mf = await autoFixModelConfig(built, s, signal);
        const { graph, fixes } = autoFixContextWiring(built);
        const body = {
          graph,
          features: args.features || cur.features || {},
          conversation_variables: cur.conversation_variables || [],
        };
        const h = cur.hash || cur.unique_hash;
        if (h) body.hash = h;
        await difyFetch(s, '/console/api/apps/' + args.app_id + '/workflows/draft', { method: 'POST', body, signal });
        return { nodes: graph.nodes.length, edges: graph.edges.length, fixes: [...(mf.fixes || []), ...fixes] };
      };
      let result;
      try {
        result = await doSync();
      } catch (e) {
        if (String(e.message || e).includes('409')) {
          result = await doSync();
          result.conflict_retried = true;
        } else {
          throw e;
        }
      }
      return {
        ok: true,
        nodes: result.nodes,
        edges: result.edges,
        ...(result.fixes.length ? { context_auto_fixed: result.fixes } : {}),
        ...(result.conflict_retried ? { note: '画布有并发改动，已自动刷新并重提成功' } : {}),
      };
    }
    case 'run_workflow': {
      // 应用类型自动识别：chatflow（advanced-chat）要走专用端点，否则 404
      let mode = args.mode;
      try {
        const app = await difyFetch(s, '/console/api/apps/' + args.app_id, { signal });
        if (app && app.mode) mode = app.mode;
      } catch (e) { /* 查不到就按传入值跑 */ }
      if (mode !== 'advanced-chat' && mode !== 'workflow') {
        return { error: '该应用类型是 "' + mode + '"，不是工作流（workflow/advanced-chat），无法用画布草稿运行' };
      }
      const isChat = mode === 'advanced-chat';
      const path = '/console/api/apps/' + args.app_id + (isChat ? '/advanced-chat/workflows/draft/run' : '/workflows/draft/run');
      const body = isChat ? { query: args.query || '', inputs: args.inputs || {} } : { inputs: args.inputs || {} };
      const run = () => difyRunStream(s, path, body, signal, onProgress);
      let r = await run();
      // 模型没配/不存在 → 自动修模型配置并重跑一次
      const failText = JSON.stringify(r.node_failures || '') + (r.error || '');
      if (!r.success && /model/i.test(failText)) {
        try {
          const cur = await difyFetch(s, '/console/api/apps/' + args.app_id + '/workflows/draft', { signal });
          const mf = await autoFixModelConfig(cur.graph || {}, s, signal);
          const fixed = autoFixContextWiring(cur.graph || {});
          if ((mf.fixes || []).length || (fixed.fixes || []).length) {
            await difyFetch(s, '/console/api/apps/' + args.app_id + '/workflows/draft', {
              method: 'POST',
              body: { graph: fixed.graph, features: cur.features || {}, conversation_variables: cur.conversation_variables || [] },
              signal,
            });
            const r2 = await run();
            return { ...r2, auto_repaired: [...(mf.fixes || []), ...(fixed.fixes || [])] };
          }
          return { ...r, hint: '模型仍不可用。诊断：' + (mf.fixes || []).join('；') };
        } catch (e) { /* 修复失败就原样返回 */ }
      }
      return r;
    }
    case 'publish_workflow': {
      // 发布需要合法 JSON body（空 {} 即可），否则 Flask 400/415
      await difyFetch(s, '/console/api/apps/' + args.app_id + '/workflows/publish', { method: 'POST', body: {}, signal });
      return { ok: true, app_url: base + '/app/' + args.app_id + '/workflow' };
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

// ===== 工具定义（OpenAI function calling 格式）=====
const TOOLS = [
  { type: 'function', function: { name: 'list_models', description: '列出 Dify 工作区可用的 LLM（provider 与 model 名）。配置任何 LLM 节点前必须先调用确认', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_apps', description: '列出工作区应用（id/name/mode）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'list_knowledge_bases', description: '列出工作区知识库（id/name）。知识库检索节点的 dataset_ids 必须使用返回的真实 id，禁止编造', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'create_workflow', description: '用整份 DSL YAML 创建新工作流应用（新建首选）。返回 app_id 和打开链接；导入失败会自动建空白应用，再用 update_workflow_draft 写 graph', parameters: { type: 'object', properties: { name: { type: 'string', description: '应用名' }, dsl_yaml: { type: 'string', description: '完整 DSL YAML' } }, required: ['name', 'dsl_yaml'] } } },
  { type: 'function', function: { name: 'get_workflow_draft', description: '读取工作流画布当前 graph（含每个节点完整 data 和全部 edges）', parameters: { type: 'object', properties: { app_id: { type: 'string' } }, required: ['app_id'] } } },
  { type: 'function', function: { name: 'update_workflow_draft', description: '整体写回画布。graph.nodes/edges 必须是修改后的完整集合；node 只需 {id, data}，position 自动沿用旧节点', parameters: { type: 'object', properties: { app_id: { type: 'string' }, graph: { type: 'object', properties: { nodes: { type: 'array' }, edges: { type: 'array' } }, required: ['nodes', 'edges'] } }, required: ['app_id', 'graph'] } } },
  { type: 'function', function: { name: 'run_workflow', description: '草稿运行工作流做测试，返回各节点成败与最终 outputs', parameters: { type: 'object', properties: { app_id: { type: 'string' }, inputs: { type: 'object', description: '开始节点变量，如 {"query": "测试文本"}' }, mode: { type: 'string', enum: ['workflow', 'advanced-chat'], description: '默认 workflow；对话型传 advanced-chat 并给 query' }, query: { type: 'string', description: 'advanced-chat 时的用户消息' } }, required: ['app_id'] } } },
  { type: 'function', function: { name: 'publish_workflow', description: '发布工作流为正式版本', parameters: { type: 'object', properties: { app_id: { type: 'string' } }, required: ['app_id'] } } },
];

// ===== 系统提示词（绑定 Workflow Engineer 行为）=====
const SYSTEM_PROMPT = `你是一名专业的 AI Workflow Engineer，运行在用户的 Chrome 扩展里，通过 Dify Console API 直接在用户的 Dify 上创建、修改、测试工作流。你不教操作，你直接做完。

核心目标：用户只描述"我想做什么 AI 应用"，你负责：需求理解 → Workflow 设计 → 节点选择 → 参数配置 → 创建 → 测试验证 → 交付报告。

工作原则：
1. 先理解业务目标再动手，不为复杂而增加节点
2. 用户已给出节点清单或明确流程结构时，**严格照用户的节点和顺序搭建**，不自增不自删节点（发现缺 start/end 这类必需节点除外，且要说明原因）；用户的思路就是设计稿，你的工作是接线和补参数。未给出结构时：简单任务直接执行，复杂任务先给设计方案确认
3. 新建首选 create_workflow 整包 DSL 导入；修改用 get_workflow_draft → 改 graph → update_workflow_draft
4. 创建后必须 run_workflow 验证，失败不停止：读 error → 修 → 重试（同一错误最多 3 次，仍失败则如实报告原因）
5. 所有 LLM 节点 Prompt 必须专业：角色+任务+规则+输出格式，不写"分析一下"这类空话
6. 配置 LLM 节点前必须先 list_models；节点的 model.provider 与 model.name 必须成对、原样使用返回值，禁止自己编（写错会报"模型不存在/不兼容"）
7. 知识库检索节点的 dataset_ids 必须使用 list_knowledge_bases 返回的真实 id，禁止编造
8. 用户未指定模型时，LLM 节点默认使用 list_models 里 provider 含 "openrouter" 且 model 含 "mimo" 的那一项（用户已在 Dify 的 OpenRouter 供应商下配置好小米 MiMo 2.5），原样使用其 provider 和 model 字段；扩展校验发现模型无效时也会自动兜底到它

节点衔接与上下文规范（最易错，逐条遵守）：
1. 连线(edge)只决定执行顺序；数据流动靠变量引用。下游拿上游数据必须显式引用，且只能引用有连线关系的上游节点：
   - prompt 文本里用 {{#节点id.字段#}}
   - 结构化入参用选择器 [节点id, "字段"]（value_selector / query_variable_selector / context.variable_selector）
2. 各节点输出字段：start→用户定义的变量名；llm→text；knowledge-retrieval→result；code→outputs 里自己定义的字段；http-request→body、status_code；template-transform→output；agent→text
3. LLM 节点接知识库三件套（缺一不可）：
   - knowledge-retrieval 节点：dataset_ids 填真实知识库 id，query_variable_selector 指向用户问题来源（如 [start_1, "query"]）
   - LLM 节点 data.context 设为 {enabled: true, variable_selector: [知识库节点id, "result"]}
   - LLM 的 prompt 里用 {{#context#}} 注入检索内容，并写清"根据以下资料回答"
4. code 节点 data 必须齐全：code_language("python3"/"javascript")、code（可运行代码，从 def main(...) 入参取输入）、outputs（输出字段 schema）、variables（输入选择器 [{variable, value_selector}]）
5. if-else：conditions 的 variable_selector 指向要判断的变量；true/false 分支的 edge.sourceHandle 分别是 "true"/"false"，两个分支都要连出去，不允许悬空
6. end 节点 outputs 的 value_selector 必须指向真实存在的上游字段；所有节点必须从 start 可达，不允许孤岛节点
7. 上下文接线由扩展自动校验补全（写回后结果里会列 context_auto_fixed），但你设计时就应按第 3 条规范来，别依赖补救

可用工具（共 9 个）：
- list_models() → 可用模型清单
- list_apps() → 应用列表
- list_knowledge_bases() → 知识库列表（id/name）
- list_tools() → 已安装的工具插件和工具清单（builtin/api/workflow/mcp 四类，含真实 provider_id 和 tool_name）
- create_workflow(name, dsl_yaml) → 整包 DSL 导入创建应用
- get_workflow_draft(app_id) → 读画布当前 graph
- update_workflow_draft(app_id, graph:{nodes,edges}) → 整体写回画布，用于增量修改
- run_workflow(app_id, inputs, mode?, query?) → 草稿运行测试
- publish_workflow(app_id) → 发布

DSL 关键规范：
- 顶层：app{description,icon,icon_background,mode,name,use_icon_as_answer_icon} + kind: app + version: 0.1.5 + workflow{graph:{nodes,edges},features,conversation_variables:[],environment_variables:[]}
- mode: workflow（任务型，结尾 end 节点）或 advanced-chat（对话型，结尾 answer 节点，用户输入用 sys.query）
- 必须有 start 和 end/answer，edges 连通所有节点；edge 需 id/source/target + sourceHandle/targetHandle（默认 source/target；if-else 分支 sourceHandle 是 true/false）
- 节点格式：{id, type: 'custom', data: {type, title, ...配置}, position: {x, y}}；data.type 可选 start/llm/knowledge-retrieval/code/http-request/if-else/agent/template-transform/variable-assigner/end/answer
- 变量引用 {{#节点id.字段#}}；LLM 输出字段是 text；end 节点 outputs:[{variable, value_selector:[节点id, 字段]}]；answer 节点 answer: '{{#llm_1.text#}}'
- start 变量类型全集：text-input|paragraph|select|number|url|file|file-list|json|checkbox；多轮对话型常用 sys.query，可以不定义 start 变量
- 节点 id 只能用字母/数字/下划线（1-50 位），禁止连字符——{{#节点id.字段#}} 插值只认这种 id
- if-else data（新版结构）：{type:'if-else', title, cases:[{id:'true', case_id:'true', logical_operator: and, conditions:[{variable_selector:[节点id,字段], comparison_operator:'contains', value:'目标', varType:'string'}]}, {id:'false', case_id:'false', logical_operator: and, conditions:[]}]}；分支 edge 的 sourceHandle = case id（'true'/'false'）
- 条件操作符：contains / not contains / is / is not / empty / not empty / start with / end with / = / ≠ / > / < / ≥ / ≤

常用节点 data 结构速查（缺字段=导入后节点废掉）：
- question-classifier（语义分类路由）：{type:'question-classifier', title, model:{provider,name,mode:'chat',completion_params:{temperature:0}}, query_variable_selector:['sys','query'], classes:[{id:'1',name:'售后'},{id:'2',name:'咨询'}], instruction:'分类规则', vision:{enabled:false}}；每个类一条分支 edge，sourceHandle=class id（'1'/'2'），都要连出去
- parameter-extractor（严格字段提取）：{type:'parameter-extractor', title, instruction:'提取规则', model:{...同llm, temperature:0.1}, parameters:[{name:'字段名', description:'说明', required:false, type:'string'}], query:[节点id,字段], reasoning_mode:'prompt', vision:{enabled:false}}
- code：code_language:'python3'；code 必须 def main(入参) 并 return dict，键与 outputs 一致；variables:[{variable:'入参名', value_selector:[节点id,字段]}]；outputs:{结果字段:{type:'string'|'number'|'object'|'array[string]'}}
- template-transform：variables:[{variable:'x', value_selector:[节点id,字段]}]，template 用 Jinja 语法 {{ x }} / {% for r in rows %}；输出字段是 output
- variable-aggregator（汇合互斥分支）：{type:'variable-aggregator', title, output_type:'string', variables:[[节点id,字段],[节点id,字段]]}，接在 if-else 各分支之后、end 之前
- http-request：{type:'http-request', title, method:'post', url:'https://...', headers:'Content-Type: application/json', body:{type:'json', data:[{key:'text', type:'string', value:'{{#节点id.字段#}}'}]}, authorization:{type:'no-auth'}, timeout:{connect:10, read:60, write:20}}；输出字段 body / status_code
- 对话型 LLM 多轮记忆：data.memory:{query_prompt_template:'{{#sys.query#}}', window:{enabled:false, size:50}}
- tool 节点的 provider_id / plugin_unique_identifier 等标识一律禁止编造。工作流需要联网搜索/抓取/通知等能力时：先 list_tools 查已安装的工具，tool 节点的 provider_id、tool_name、provider_type 全部用返回的真实值；输出字段保守用 text。要的能力没装 → 引导用户去 Dify「工具」安装对应插件（或添加 MCP 服务器），装好后再接线

场景选型：语义分类路由→question-classifier；确定性条件判断→if-else；从文本抽严格字段→parameter-extractor 或 code；解析/清洗/校验/批处理等确定性逻辑→code；自然语言生成/总结→llm；固定格式输出→template-transform；合并互斥分支→variable-aggregator；多轮对话→advanced-chat+memory+answer；批量处理数组优先用 code 循环（iteration 容器结构复杂易错）

最小可导入骨架（改 name/prompt/provider 即可扩展）：
\`\`\`yaml
app:
  description: 一句话描述
  icon: 🤖
  icon_background: '#FFEAD5'
  mode: workflow
  name: 应用名
  use_icon_as_answer_icon: false
kind: app
version: 0.1.5
workflow:
  conversation_variables: []
  environment_variables: []
  features:
    file_upload:
      image: {enabled: false, number_limits: 3, transfer_methods: [local_file, remote_url]}
  graph:
    edges:
    - {id: e1, source: start_1, sourceHandle: source, target: llm_1, targetHandle: target, type: custom, zIndex: 0}
    - {id: e2, source: llm_1, sourceHandle: source, target: end_1, targetHandle: target, type: custom, zIndex: 0}
    nodes:
    - {id: start_1, type: custom, position: {x: 80, y: 280}, data: {type: start, title: 开始, variables: [{variable: query, label: query, type: text-input, required: true, max_length: 2000, options: []}]}}
    - {id: llm_1, type: custom, position: {x: 380, y: 280}, data: {type: llm, title: LLM, model: {provider: <用list_models确认>, name: <model名>, mode: chat, completion_params: {temperature: 0.7}}, prompt_template: [{role: system, text: 系统Prompt}, {role: user, text: '{{#start_1.query#}}'}], context: {enabled: false, variable_selector: []}, vision: {enabled: false}}}
    - {id: end_1, type: custom, position: {x: 680, y: 280}, data: {type: end, title: 结束, outputs: [{variable: result, value_selector: [llm_1, text]}]}}
  hash: ''
\`\`\`

执行模式：
- 新建：list_models 确认模型 → 写整份 DSL → create_workflow → run_workflow 测试 → publish → 报告
- 修改：get_workflow_draft → 修改 graph → update_workflow_draft → run_workflow 验证 → 报告改动
- 复用：要把已有工作流（如出题/校验流程）整段搬进新应用，先 get_workflow_draft 读源画布，把那部分节点和 edges 并入新 graph（节点 id 加前缀避免冲突，内部变量引用同步改），再写回新应用
- 完成后交付：应用名、打开链接、测试输入与实际输出`;

// ===== LLM 调用（流式：思维链和回答边生成边推给面板）=====
async function callLLM(messages, s, signal, onDelta, opts = {}) {
  const body = { model: opts.model || s.model, messages, stream: true, temperature: opts.temperature ?? 0.3 };
  if (opts.tools) body.tools = opts.tools;
  if (opts.reasoningOff && normalizeBase(s.llmBase).includes('openrouter')) body.reasoning = { enabled: false };
  const res = await fetch(normalizeBase(s.llmBase) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.llmKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error('LLM 调用失败 HTTP ' + res.status + ': ' + JSON.stringify(data).slice(0, 300));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '';
  const toolCalls = [];
  const feed = (delta) => {
    if (!delta) return;
    if (delta.reasoning && onDelta) onDelta('reasoning', delta.reasoning);
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta('content', delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        feed(j.choices && j.choices[0] && j.choices[0].delta);
      } catch (e) { /* 跳过坏行 */ }
    }
  }
  const calls = toolCalls.filter(Boolean);
  return { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) };
}

// ===== Agent 主循环 =====
async function runAgent(port, s, userMsg, history, st) {
  // 注入工作区已有应用清单，让"二次校验""出题"这类指代能直接落到具体 app_id
  let appsInfo = '';
  try {
    const d = await difyFetch(s, '/console/api/apps?page=1&limit=30', { signal: st.controller.signal });
    const rows = (d.data || []).slice(0, 30).map((a) => '- ' + a.name + '（' + a.mode + '，app_id: ' + a.id + '）');
    if (rows.length) {
      appsInfo = '\n\n## 当前工作区已有应用\n' + rows.join('\n')
        + '\n用户提到以上任何名字（如"二次校验""出题""客服"）时，默认是要修改对应应用：用其 app_id 走 get_workflow_draft → update_workflow_draft 流程，禁止新建同名应用。';
    }
  } catch (e) { /* 拿不到清单就不注入 */ }
  const system = (s.customPrompt
    ? SYSTEM_PROMPT + '\n\n## 用户自定义规则（优先级最高，与上面冲突时以这里为准）\n' + s.customPrompt
    : SYSTEM_PROMPT) + appsInfo;
  const messages = [
    { role: 'system', content: system },
    ...history.slice(-12),
    { role: 'user', content: userMsg },
  ];
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (st.cancelled) { port.postMessage({ type: 'stopped' }); return; }
    const lastChance = i === MAX_ITERATIONS - 1;
    if (lastChance) {
      messages.push({ role: 'user', content: '[系统] 已达执行步数上限。请立刻输出最终总结：做了什么、应用名和链接、测试结果（引用最后一条工具结果里的 outputs），未尽事项一句话带过。不要再调用任何工具。' });
    }
    port.postMessage({ type: 'status', text: '思考中… (' + (i + 1) + ')，点「停止」可中断' });
    let msg;
    try {
      msg = await callLLM(messages, s, st.controller.signal, (kind, text) => {
        if (kind === 'reasoning') port.postMessage({ type: 'reasoning', text });
        else if (kind === 'content') port.postMessage({ type: 'assistant_delta', text });
      }, lastChance ? { temperature: 0.3 } : { tools: TOOLS });
    } catch (e) {
      if (st.cancelled) { port.postMessage({ type: 'stopped' }); return; }
      throw e;
    }
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        if (st.cancelled) { port.postMessage({ type: 'stopped' }); return; }
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* 空参数 */ }
        port.postMessage({ type: 'tool', name: tc.function.name, args });
        let result;
        try {
          result = await executeTool(tc.function.name, args, s, st.controller.signal, (text) => {
            port.postMessage({ type: 'status', text });
          });
        } catch (e) {
          if (st.cancelled) { port.postMessage({ type: 'stopped' }); return; }
          result = { error: String(e.message || e) };
        }
        if (st.cancelled) { port.postMessage({ type: 'stopped' }); return; }
        const str = JSON.stringify(result);
        port.postMessage({
          type: 'tool_result',
          name: tc.function.name,
          ok: !result.error,
          summary: str.length > 300 ? str.slice(0, 300) + '…' : str,
          app_url: result.app_url,
        });
        // 工作流测试跑成功：结果立刻单独成卡，不等最终总结
        if (tc.function.name === 'run_workflow' && result.success && result.outputs) {
          port.postMessage({ type: 'run_result', outputs: result.outputs });
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: str.length > TOOL_RESULT_LIMIT ? str.slice(0, TOOL_RESULT_LIMIT) + '…(已截断)' : str,
        });
      }
      continue;
    }
    port.postMessage({ type: 'assistant', content: msg.content || '(空回复)' });
    return;
  }
  port.postMessage({ type: 'error', text: '达到最大执行步数已停止，可继续对话让它接着做' });
}

// 快聊模式：单轮对话，用非推理快模型 + 关推理 + 45s 强制超时，不执行操作
async function callChatLLM(s, userMsg, history, signal, onDelta) {
  const messages = [
    { role: 'system', content: '你是 Dify 自动化插件附带的快聊助手，帮用户梳理工作流需求和方案，回答简洁直接。你没有工具、看不到用户 Dify 里的实际应用和画布，凡涉及"我的某个工作流/应用具体是什么、改成什么样"的问题，提醒用户切回「干活」模式再问，那边能读画布真实回答。' },
    ...history.slice(-10),
    { role: 'user', content: userMsg },
  ];
  const timeout = AbortSignal.timeout(45000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // 快聊模型按接口自动匹配：OpenRouter→快聊模型设置；DeepSeek 官方→v4-flash（她的 Key 没有旧 chat）
  const base = normalizeBase(s.llmBase);
  let fastModel = s.fastModel || s.model;
  if (base.includes('api.deepseek.com')) fastModel = 'deepseek-v4-flash';
  const msg = await callLLM(messages, s, sig, onDelta, {
    temperature: 0.5,
    reasoningOff: true,
    model: fastModel,
  });
  if (!msg.content) throw new Error('LLM 返回为空，重试一次或切回干活模式');
  return msg.content;
}

// ===== 消息入口 =====
const runStates = new WeakMap(); // port -> { cancelled, controller }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'agent') return;
  port.onMessage.addListener(async (m) => {
    if (m.type === 'stop') {
      const st = runStates.get(port);
      if (st) {
        st.cancelled = true;
        try { st.controller.abort(); } catch { /* 已结束 */ }
      }
      return;
    }
    if (m.type === 'detect') {
      const r = await detectDify();
      if (!r.ok) await saveSettings({ difyBase: '', difyToken: '', difyTabId: 0, difyRelay: false });
      port.postMessage({ type: 'dify_status', ok: r.ok, base: r.ok ? r.base : '', detail: r.detail || '' });
      return;
    }
    if (m.type === 'fetch_models') {
      try {
        const s = await getSettings();
        const base = normalizeBase(m.base || s.llmBase);
        const key = (m.key || s.llmKey || '').trim();
        const res = await fetch(base + '/models', key ? { headers: { Authorization: 'Bearer ' + key } } : {});
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + JSON.stringify(data).slice(0, 200));
        const all = (data.data || []).map((x) => ({
          id: x.id,
          tools: (x.supported_parameters || []).includes('tools'),
        }));
        const withTools = all.filter((x) => x.tools).map((x) => x.id);
        port.postMessage({
          type: 'models',
          models: withTools.sort(),
          total: all.length,
          error: withTools.length === 0 ? '该接口没查到支持工具调用的模型' : undefined,
        });
      } catch (e) {
        port.postMessage({ type: 'models', models: [], error: String(e.message || e) });
      }
      return;
    }
    if (m.type !== 'run') return;
    try {
      let s = await getSettings();
      if (!s.llmKey) {
        port.postMessage({ type: 'error', text: '先点右上角 ⚙ 检查 LLM API Key' });
        return;
      }
      if (!s.difyBase) {
        port.postMessage({ type: 'status', text: '正在从已打开的标签页检测 Dify…' });
        const r = await detectDify();
        if (r.ok) {
          s = await getSettings();
          port.postMessage({ type: 'dify_status', ok: true, base: r.base });
        } else {
          port.postMessage({
            type: 'error',
            text: NO_DIFY_MSG + (r.detail ? '。本次检测结果 → ' + r.detail : ''),
          });
          return;
        }
      }
      // 快聊模式：不碰 Dify，单轮快答
      if (m.mode === 'chat') {
        const st = { cancelled: false, controller: new AbortController() };
        runStates.set(port, st);
        try {
          const content = await callChatLLM(s, m.message, m.history || [], st.controller.signal, (kind, text) => {
            if (kind === 'content') port.postMessage({ type: 'assistant_delta', text });
          });
          port.postMessage({ type: 'assistant', content });
        } catch (e) {
          if (st.cancelled) port.postMessage({ type: 'stopped' });
          else port.postMessage({ type: 'error', text: String(e.message || e) });
        } finally {
          runStates.delete(port);
        }
        return;
      }
      const st = { cancelled: false, controller: new AbortController() };
      runStates.set(port, st);
      try {
        await runAgent(port, s, m.message, m.history || [], st);
      } finally {
        runStates.delete(port);
      }
    } catch (e) {
      port.postMessage({ type: 'error', text: String(e.message || e) });
    }
  });
});

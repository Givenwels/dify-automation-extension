const $ = (sel) => document.querySelector(sel);
const chat = $('#chat');
const input = $('#input');
const sendBtn = $('#send');
const statusEl = $('#status');
const difyStatusEl = $('#difyStatus');

const port = chrome.runtime.connect({ name: 'agent' });
let history = [];
let running = false;
let lastToolEl = null;
let curThinkEl = null;
let curAssistantEl = null;

function scroll() { chat.scrollTop = chat.scrollHeight; }
function el(cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}
function setStatus(t) { statusEl.textContent = t || ''; }

function renderDifyStatus(ok, base, detail) {
  difyStatusEl.classList.toggle('ok', ok);
  difyStatusEl.textContent = ok
    ? 'Dify 已连接：' + base
    : 'Dify 未连接' + (detail ? '（' + detail + '）' : '（打开并登录 Dify 后点「检测」）');
}

function addUser(t) { chat.appendChild(el('msg user', t)); scroll(); }
function addAssistant(t) { chat.appendChild(el('msg assistant', t)); scroll(); }
function addError(t) { chat.appendChild(el('msg error', t)); scroll(); }

function addTool(name, args) {
  const wrap = el('tool');
  const head = el('tool-head', '🔧 ' + name + '（点开看详情）');
  const body = el('tool-body', JSON.stringify(args, null, 2).slice(0, 20000));
  head.onclick = () => body.classList.toggle('open');
  wrap.appendChild(head);
  wrap.appendChild(body);
  chat.appendChild(wrap);
  scroll();
  return wrap;
}

function addToolResult(target, res) {
  if (!target) return;
  const line = el('tool-res', (res.ok ? '✅ ' : '❌ ') + (res.summary || ''));
  if (res.app_url) {
    line.appendChild(document.createElement('br'));
    const a = document.createElement('a');
    a.href = res.app_url;
    a.target = '_blank';
    a.textContent = '在 Dify 打开 ↗';
    line.appendChild(a);
  }
  target.appendChild(line);
  scroll();
}

function setRunning(v) {
  running = v;
  sendBtn.disabled = false;
  sendBtn.textContent = v ? '停止' : '发送';
  if (v) setStatus('启动…');
}

port.onMessage.addListener((m) => {
  if (m.type === 'status') {
    setStatus(m.text);
  } else if (m.type === 'reasoning') {
    // 实时思维链：AI 每想一句就追加显示
    if (!curThinkEl) {
      curThinkEl = el('tool');
      const head = el('tool-head', '💭 思考中…');
      const body = el('tool-body', '');
      body.classList.add('open');
      head.onclick = () => body.classList.toggle('open');
      curThinkEl.appendChild(head);
      curThinkEl.appendChild(body);
      curThinkEl._head = head;
      curThinkEl._body = body;
      chat.appendChild(curThinkEl);
    }
    curThinkEl._body.textContent += m.text;
    curThinkEl._head.textContent = '💭 思考中… ' + curThinkEl._body.textContent.length + ' 字';
    scroll();
  } else if (m.type === 'assistant_delta') {
    if (!curAssistantEl) {
      curAssistantEl = el('msg assistant', '');
      chat.appendChild(curAssistantEl);
    }
    curAssistantEl.textContent += m.text;
    scroll();
  } else if (m.type === 'assistant') {
    history.push({ role: 'assistant', content: m.content });
    if (curAssistantEl) curAssistantEl.textContent = m.content;
    else addAssistant(m.content);
    curAssistantEl = null;
    curThinkEl = null;
    saveHistory();
    setStatus('');
    setRunning(false);
  } else if (m.type === 'run_result') {
    if (curThinkEl) {
      curThinkEl._head.textContent = '💭 思考过程（点开可看全文）';
      curThinkEl = null;
    }
    const card = el('msg result', '✅ 工作流运行结果\n' + JSON.stringify(m.outputs, null, 2));
    chat.appendChild(card);
    lastToolEl = null;
    scroll();
  } else if (m.type === 'tool') {
    if (curThinkEl) {
      curThinkEl._head.textContent = '💭 思考过程（点开可看全文）';
      curThinkEl = null;
    }
    lastToolEl = addTool(m.name, m.args);
  } else if (m.type === 'tool_result') {
    addToolResult(lastToolEl, m);
  } else if (m.type === 'dify_status') {
    renderDifyStatus(m.ok, m.base, m.detail);
  } else if (m.type === 'stopped') {
    curThinkEl = null;
    curAssistantEl = null;
    setStatus('');
    setRunning(false);
    chat.appendChild(el('msg assistant', '⏹ 已停止本轮任务'));
    scroll();
  } else if (m.type === 'models') {
    const list = $('#modelList');
    list.innerHTML = '';
    for (const id of m.models) {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    }
    $('#modelHint').textContent = m.error
      ? '拉取失败：' + m.error
      : '共 ' + m.total + ' 个模型，其中 ' + m.models.length + ' 个支持工具调用（已列出，只有这些能驱动本插件）';
  } else if (m.type === 'error') {
    addError(m.text);
    curThinkEl = null;
    curAssistantEl = null;
    setStatus('');
    setRunning(false);
  }
});

// ===== 对话持久化：面板关了再开，对话还在 =====
function saveHistory() {
  try { chrome.storage.local.set({ chatHistory: history.slice(-40) }); } catch (e) { /* 存不下就算了 */ }
}
function restoreHistory() {
  chrome.storage.local.get('chatHistory').then((s) => {
    if (Array.isArray(s.chatHistory) && s.chatHistory.length) {
      history = s.chatHistory;
      for (const h of history) {
        if (h.role === 'user') addUser(h.content);
        else if (h.role === 'assistant') addAssistant(h.content);
      }
      scroll();
    }
  });
}

// ===== 模式切换：干活（全功能）/ 快聊（关思考，快）=====
let chatMode = 'work';
const modeBtns = document.querySelectorAll('.modeBtn');

function setMode(m) {
  chatMode = m;
  chrome.storage.local.set({ chatMode: m });
  modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  input.placeholder = m === 'chat'
    ? '快聊模式：聊需求、理思路，关掉思考速度快；不会执行操作'
    : '干活模式：描述你要的 AI 应用，自动在 Dify 上搭建并测试';
  // 切到快聊 = 不想让它继续动了：自动中断正在跑的创建任务
  if (m === 'chat' && running) {
    port.postMessage({ type: 'stop' });
    setStatus('已切到快聊，正在中断创建任务…');
  }
}

modeBtns.forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode);
});
chrome.storage.local.get('chatMode').then((s) => {
  if (s.chatMode) setMode(s.chatMode);
});

async function send() {
  const text = input.value.trim();
  if (!text || running) return;
  input.value = '';
  history.push({ role: 'user', content: text });
  addUser(text);
  saveHistory();
  setRunning(true);
  if (chatMode === 'chat') setStatus('快聊生成中…');
  port.postMessage({ type: 'run', message: text, history: history.slice(0, -1), mode: chatMode });
}

sendBtn.onclick = () => {
  if (running) {
    setStatus('停止中…');
    port.postMessage({ type: 'stop' });
    // 兜底：5 秒内后台没回话就本地强制复位，不让界面卡死
    setTimeout(() => {
      if (running) {
        curThinkEl = null;
        curAssistantEl = null;
        setRunning(false);
        setStatus('');
        chat.appendChild(el('msg assistant', '⏹ 已强制停止（后台若仍在收尾，结果会被丢弃）'));
        scroll();
      }
    }, 5000);
    return;
  }
  send();
};
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !running) {
    e.preventDefault();
    send();
  }
});

$('#newChat').onclick = () => {
  history = [];
  lastToolEl = null;
  curThinkEl = null;
  curAssistantEl = null;
  chat.innerHTML = '';
  setStatus('');
  chrome.storage.local.remove('chatHistory');
};
restoreHistory();

// ===== Dify 连接状态 =====
function detect() {
  difyStatusEl.textContent = 'Dify：检测中…';
  difyStatusEl.classList.remove('ok');
  port.postMessage({ type: 'detect' });
}
$('#detectBtn').onclick = detect;

chrome.storage.local.get(['difyBase', 'difyToken']).then(() => {
  // 每次打开都重新验证，避免沿用失效或误判的旧连接
  detect();
});

// ===== 设置（只剩 LLM）=====
const FIELDS = ['llmBase', 'llmKey', 'model', 'fastModel', 'customPrompt'];
$('#gear').onclick = () => $('#settings').classList.toggle('open');

chrome.storage.local.get([...FIELDS, 'modelKeys']).then((s) => {
  const preset = PRESETS.find((p) => p.model === s.model);
  const keys = { ...(preset ? { [preset.model]: preset.key } : {}), ...(s.modelKeys || {}) };
  for (const f of FIELDS) {
    if (s[f]) $('#' + f).value = s[f];
  }
  // 没存过 Key 但当前模型有对应 Key 时，自动带上
  if (!s.llmKey && keys[s.model]) {
    $('#llmKey').value = keys[s.model];
    chrome.storage.local.set({ llmKey: keys[s.model] });
  }
});

$('#fetchModels').onclick = () => {
  $('#modelHint').textContent = '拉取中…';
  port.postMessage({ type: 'fetch_models', base: $('#llmBase').value.trim(), key: $('#llmKey').value.trim() });
};

// 预设模型：每个按钮 = 接口地址 + 模型 + 专属 Key，一键切全套
const PRESETS = [
  { label: 'MiMo 2.5', base: 'https://openrouter.ai/api/v1', model: 'xiaomi/mimo-v2.5', key: '' },
  { label: 'MiMo 2.5 Pro', base: 'https://openrouter.ai/api/v1', model: 'xiaomi/mimo-v2.5-pro', key: '' },
  { label: 'DS V4 Flash', base: 'https://api.deepseek.com', model: 'deepseek-v4-flash', key: '' },
];

const chipsWrap = $('#presetChips');
PRESETS.forEach((p) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = p.label;
  b.title = p.model;
  b.onclick = async () => {
    $('#llmBase').value = p.base;
    $('#model').value = p.model;
    $('#llmKey').value = p.key;
    await chrome.storage.local.set({ llmBase: p.base, model: p.model, llmKey: p.key });
    $('#modelHint').textContent = '已切换为 ' + p.label + '（' + p.model + '，已保存立即生效）';
  };
  chipsWrap.appendChild(b);
});

$('#verLabel').textContent = '当前版本 v' + chrome.runtime.getManifest().version + '（改完代码必须在这里核对版本，变了才是刷新成功）';

$('#saveBtn').onclick = async () => {
  const patch = {};
  for (const f of FIELDS) patch[f] = $('#' + f).value.trim();
  await chrome.storage.local.set(patch);
  // 记住「模型 → Key」对应关系，之后切换按钮时自动带出
  if (patch.model && patch.llmKey) {
    const { modelKeys } = await chrome.storage.local.get('modelKeys');
    await chrome.storage.local.set({ modelKeys: { ...(modelKeys || {}), [patch.model]: patch.llmKey } });
  }
  $('#saveBtn').textContent = '已保存 ✓';
  setTimeout(() => { $('#saveBtn').textContent = '保存'; }, 1500);
};

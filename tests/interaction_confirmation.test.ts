import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = fs.readFileSync(new URL('../internal/assets/inject/api_client.js', import.meta.url), 'utf8');
const script = source.slice(0, source.indexOf('// 自动初始化')) + source.slice(source.indexOf('window.__wx_selectors__ ='));
const form = '<button aria-label="评论，1"></button><div class="input-box"><textarea class="weui-textarea"></textarea><button aria-label="发送" role="button">发送</button></div>';
function setup(html: string, onWait = (_window: any, _ms: number) => {}) {
  const dom = new JSDOM(html, { url: 'https://channels.weixin.qq.com/web/pages/feed?oid=A' });
  const { window } = dom;
  window.WXU = { API: {}, API2: {} };
  window.scrollBy = () => {};
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 20 }];
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left:0, top:0, right:100, bottom:100, width:100, height:100 });
  vm.runInNewContext(script, { window, document: window.document, navigator: window.navigator, URL,
    MouseEvent: window.MouseEvent, Event: window.Event, InputEvent: window.InputEvent,
    HTMLTextAreaElement: window.HTMLTextAreaElement, AbortSignal, WebSocket: { OPEN:1 },
    console: { log() {}, warn() {}, error() {} }, fetch: async () => ({ ok:true }),
    setTimeout(fn: () => void, ms: number) { onWait(window, ms); fn(); return 0; }, clearTimeout() {},
  });
  const client = window.__wx_api_client;
  return { window, client, close: () => window.close(), run: (action: string) => client.executeDomAction({ action, content:'new comment' }) };
}
test('作品上报从当前 DOM 取得 ID，不能取隐藏旧作品或主页作品列表', () => {
  const f = setup('<div class="slides-item" hidden><div id="flow-feed-old"></div></div><div class="slides-item"><div id="flow-feed-12345678901234567890"></div></div>');
  try {
    assert.equal(f.client.collectClientState().work_id, '12345678901234567890');
    f.window.history.replaceState({}, '', '/web/pages/profile');
    assert.equal(f.client.collectClientState().work_id, '');
  } finally { f.close(); }
});

test('连接后作品才挂载，实时状态回执前同步作品身份，不等待三十秒心跳', async () => {
  const f = setup(''); const messages: any[] = [];
  try {
    f.client.connected = true;
    f.client.ws = { readyState:1, send: (msg: string) => messages.push(JSON.parse(msg)) };
    f.client.sendClientState();
    assert.equal(messages[0].data.work_id, '');
    messages.length = 0;
    f.window.document.body.innerHTML = '<div class="slides-item"><div id="flow-feed-12345678901234567890"></div></div>';
    const instance = f.client.commentPageInstance();
    const url = f.window.location.href;
    await f.client.handleAPICall({ id:'identity-read', key:'key:channels:dom_action',
      body: { action:'get_status', page_instance_id:instance, url } });
    assert.equal(messages[0].type, 'client_state');
    assert.equal(messages[0].data.work_id, '12345678901234567890');
    const result = messages.find(m => m.type === 'api_response').data.data;
    assert.equal(result.page_instance_id, instance);
    assert.equal(result.url, url);
    assert.equal(result.work_id, '12345678901234567890');
    assert.equal(typeof result.isLiked, 'boolean');
  } finally { f.close(); }
});
for (const action of ['do_like', 'do_follow']) {
  for (const changed of [true, false]) test(`${action} 点击后确认状态，changed=${changed}`, async () => {
    const f = setup('<div class="bottom-area"><button class="follow-btn">关注</button></div>');
    let clicks = 0;
    try {
      const btn = f.window.document.querySelector('button');
      btn.onclick = () => clicks++;
      f.window.__wx_parsers__.isLiked = () => changed && clicks > 0;
      f.window.__wx_parsers__.isFollowed = () => changed && clicks > 0;
      f.window.__wx_parsers__.getUnlikeBtn = () => btn;
      const result = await f.run(action);
      assert.equal(result.success, changed);
      assert.equal(clicks, 1);
      if (!changed) { assert.equal(result.resultUnknown, true); assert.equal(result.retryable, false); }
    } finally { f.close(); }
  });
}
for (const changed of [true, false]) test(`主页关注重新定位按钮且不重复点击，changed=${changed}`, async () => {
  const f = setup('<div class="opr-area"><button>关注</button></div>');
  let clicks = 0;
  try {
    const btn = f.window.document.querySelector('button'); btn.innerText = '关注';
    btn.onclick = () => {
      clicks++;
      if (changed) { const next = f.window.document.createElement('button'); next.innerText = '已关注'; btn.replaceWith(next); }
    };
    const result = await f.run('do_follow_on_profile');
    assert.equal(result.success, changed); assert.equal(clicks, 1);
    if (!changed) assert.equal(result.resultUnknown, true);
  } finally { f.close(); }
});

for (const markup of [
  '<button class="follow-btn"><span>已关注</span></button>',
  '<div class="followed"><span>互相关注</span></div>',
  '<div class="bg-white/5"><span>已关注</span></div>',
]) test(`关注状态识别不依赖旧版 div 文本布局：${markup}`, async () => {
  const f = setup(`<div class="slides-item"><div id="flow-feed-current"></div><div class="bottom-area">${markup}</div></div>`);
  let clicks = 0;
  try {
    f.window.document.addEventListener('click', () => clicks++);
    const status = await f.run('get_status');
    assert.equal(status.isFollowed, true);
    const result = await f.run('do_follow');
    assert.equal(result.success, true); assert.equal(result.isFollowed, true);
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('关注后按钮被替换，读取当前按钮确认而不是返回待核实', async () => {
  const f = setup('<div class="slides-item"><div id="flow-feed-current"></div><div class="bottom-area"><button class="follow-btn">+关注</button></div></div>');
  let clicks = 0;
  try {
    const button = f.window.document.querySelector('button');
    button.onclick = () => { clicks++; button.outerHTML = '<button class="follow-btn"><span>已关注</span></button>'; };
    const result = await f.run('do_follow');
    assert.equal(clicks, 1); assert.equal(result.success, true); assert.equal(result.isFollowed, true);
  } finally { f.close(); }
});

test('只读取当前播放区域的关注状态并点击对应按钮，其他作品的已关注不能串入', async () => {
  const f = setup('<div class="slides-item" hidden><div id="flow-feed-old"></div><div class="bottom-area"><div class="bg-white/5">已关注</div></div></div><div class="slides-item"><div id="flow-feed-current"></div><div class="bottom-area"><button class="follow-btn">+关注</button><div class="comment-content">已关注</div></div></div>');
  let clicks = 0;
  try {
    const button = f.window.document.querySelector('button');
    button.onclick = () => { clicks++; button.textContent = '已关注'; };
    assert.equal((await f.run('get_status')).isFollowed, false);
    const result = await f.run('do_follow');
    assert.equal(result.success, true); assert.equal(clicks, 1);
  } finally { f.close(); }
});

for (const liked of [true, false]) test(`当前作品缺少点赞控件时不读取或点击隐藏作品，旧作品已点赞=${liked}`, async () => {
  const f = setup(`<div class="slides-item" hidden><div id="flow-feed-old"></div><div class="bottom-area"><div class="click-box op-item" role="button" aria-label="${liked ? '取消推荐' : '推荐'}"><i class="feed-like-icon"></i></div></div></div><div class="slides-item"><div id="flow-feed-current"></div><div class="bottom-area"></div></div>`);
  let clicks = 0;
  try {
    f.window.document.querySelector('[role="button"]').onclick = () => clicks++;
    assert.equal((await f.run('get_status')).isLiked, false);
    const result = await f.run('do_like');
    assert.equal(result.success, false); assert.equal(clicks, 0);
  } finally { f.close(); }
});
for (const state of ['unchanged', 'cleared', 'removed']) test(`评论完成填写和发送点击即记提交成功，不依赖旧输入框：${state}`, async () => {
  const f = setup(form); let sends = 0;
  try {
    f.window.document.querySelector('[aria-label="发送"]').onclick = () => {
      sends++;
      const input = f.window.document.querySelector('textarea');
      if (state === 'cleared') input.value = '';
      if (state === 'removed') input.remove();
    };
    const result = await f.run('do_comment');
    assert.equal(sends, 1); assert.equal(result.success, true);
    assert.equal(result.isCommented, true); assert.equal(result.confirmation, 'submitted');
    assert.notEqual(result.resultUnknown, true);
  } finally { f.close(); }
});
test('导航使用可用 WebSocket 回执，HTTP 不通也不遗留等待', async () => {
  const f = setup(''); const responses: any[] = [];
  try {
    f.client.connected = true;
    f.client.ws = { readyState:1, send: (msg: string) => responses.push(JSON.parse(msg)) };
    await f.client.handleAPICall({ id:'nav', key:'key:channels:dom_action', body:{ action:'open_profile', url:f.window.location.href } });
    assert.equal(responses[0]?.type, 'api_response');
    assert.equal(responses[0]?.data.id, 'nav');
  } finally { f.close(); }
});

test('评论只打开当前作品入口并填写唯一可见的非回复输入框', async () => {
  const f = setup(`<div hidden>${form}</div><div class="slides-item" hidden><button aria-label="评论，99"></button></div><div class="slides-item"><div id="flow-feed-current"></div>${form}</div>`);
  let oldClicks = 0, sends = 0, opens = 0;
  try {
    const old = f.window.document.querySelector('[hidden]');
    old.querySelector('button').onclick = () => oldClicks++;
    const current = f.window.document.querySelector('.slides-item:not([hidden])');
    current.querySelector('.input-box').hidden = true;
    current.querySelector('[aria-label^="评论"]').onclick = () => { opens++; current.querySelector('.input-box').hidden = false; };
    current.querySelector('[aria-label="发送"]').onclick = () => {
      sends++; current.querySelector('textarea').value = '';
    };
    const result = await f.run('do_comment');
    assert.equal(result.success, true); assert.equal(opens, 1);
    assert.equal(sends, 1); assert.equal(oldClicks, 0);
    assert.equal(old.querySelector('textarea').value, '');
  } finally { f.close(); }
});

test('多个可见评论输入框不能任取第一个，也不能填写回复框', () => {
  const f = setup(form + form);
  try {
    assert.equal(f.window.__wx_parsers__.getCommentInput(), null);
    const inputs = f.window.document.querySelectorAll('textarea');
    inputs[0].placeholder = '回复 张三';
    assert.equal(f.window.__wx_parsers__.getCommentInput(), inputs[1]);
  } finally { f.close(); }
});

test('关注确认等待迟到的状态，不在2.5秒时提前跳过客户', async () => {
  let clicked = false, elapsed = 0, clicks = 0;
  const f = setup('<div class="bottom-area"><button class="follow-btn">+关注</button></div>', (w, ms) => {
    if (clicked && (elapsed += ms) >= 4000) w.document.querySelector('button').textContent = '已关注';
  });
  try {
    f.window.document.querySelector('button').onclick = () => { clicked = true; clicks++; };
    assert.equal((await f.run('do_follow')).success, true);
    assert.equal(clicks, 1);
  } finally { f.close(); }
});

test('当前播放区域内的隐藏关注控件也不能被读取或点击', async () => {
  const f = setup('<div class="bottom-area"><button class="follow-btn" hidden>已关注</button><button class="follow-btn">+关注</button></div>');
  let clicks = 0;
  try {
    const visible = f.window.document.querySelector('button:not([hidden])');
    visible.onclick = () => { clicks++; visible.textContent = '已关注'; };
    assert.equal((await f.run('get_status')).isFollowed, false);
    assert.equal((await f.run('do_follow')).success, true);
    assert.equal(clicks, 1);
  } finally { f.close(); }
});

test('评论发送后输入框正常销毁仍记已提交，保留完整风控检查', async () => {
  let sent = false, waits = 0, clicks = 0;
  const f = setup(form, (w, ms) => {
    if (sent && ms === 1000 && ++waits === 2) w.document.querySelector('textarea').remove();
  });
  try {
    f.window.document.querySelector('[aria-label="发送"]').onclick = () => {
      sent = true; clicks++; f.window.document.querySelector('textarea').value = '';
    };
    const result = await f.run('do_comment');
    assert.equal(result.success, true); assert.equal(clicks, 1); assert.ok(waits >= 5);
  } finally { f.close(); }
});

test('评论内容为空不能仅点击发送就记为成功', async () => {
  const f = setup(form); let sends = 0;
  try {
    f.window.document.querySelector('[aria-label="发送"]').onclick = () => sends++;
    const result = await f.client.executeDomAction({ action: 'do_comment', content: '   ' });
    assert.equal(result.success, false); assert.equal(result.reason, 'empty_comment');
    assert.equal(sends, 0);
  } finally { f.close(); }
});

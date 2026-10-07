const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../internal/assets/inject/api_client.js'), 'utf8');
const clientSource = source.slice(0, source.indexOf('// 自动初始化')) + source.slice(source.indexOf('window.__wx_selectors__ ='));

function setup(html, onWait = () => {}) {
  const dom = new JSDOM(html, { url: 'https://channels.weixin.qq.com/web/pages/feed' });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function() { return [{ width: 100, height: 20 }]; };
  window.scrollBy = () => {};
  let elapsed = 0;
  const stages = [];
  vm.runInNewContext(clientSource, {
    window, document: window.document,
    Event: window.Event, InputEvent: window.InputEvent, HTMLTextAreaElement: window.HTMLTextAreaElement,
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date { static now() { return elapsed; } },
    setTimeout: (fn, ms) => { elapsed += ms; onWait(window, ms); fn(); return 0; },
    clearTimeout() {},
    fetch: async (_url, init) => { stages.push(JSON.parse(init.body).msg); return {}; },
  });
  window.close = () => {};
  return {
    window, stages, elapsed: () => elapsed, close: () => dom.window.close(),
    run: () => window.__wx_api_client.executeDomAction({ action: 'do_comment', content: 'private-text', operation_id: 'test-operation' }, 'request-1'),
  };
}

test('missing input remains an explicit failure even when comment buttons disappear', async () => {
  const f = setup('<button aria-label="评论，1"></button>');
  try {
    f.window.document.querySelector('button').onclick = (event) => event.target.remove();
    const result = await f.run();
    assert.equal(result.success, false);
    assert.ok(f.stages.some((s) => s.includes('input_missing')));
    assert.ok(!f.stages.join('').includes('private-text'));
  } finally { f.close(); }
});

test('missing input can exceed 30 seconds and reports attempt and elapsed diagnostics', async () => {
  const f = setup('<button aria-label="评论，1"></button>');
  try {
    const result = await f.run();
    assert.equal(result.success, false);
    assert.ok(f.elapsed() > 30000);
    assert.equal(f.stages.filter((s) => s.includes('"stage":"attempt"')).length, 3);
    assert.ok(f.stages.some((s) => s.includes('"operation_id":"test-operation"') && s.includes('"stage":"finished"')));
  } finally { f.close(); }
});

test('an exception after the send click cannot send the comment twice', async () => {
  const f = setup('<button aria-label="评论，1"></button><div class="input-box"><textarea class="weui-textarea"></textarea><button aria-label="发送" role="button">发送</button></div>');
  let clicks = 0;
  try {
    const send = f.window.document.querySelector('[aria-label="发送"]');
    send.click = () => { clicks++; };
    const refresh = f.window.__wx_parsers__.refreshAllDom;
    f.window.__wx_parsers__.refreshAllDom = function() {
      if (clicks) throw new Error('DOM changed after send');
      return refresh.call(this);
    };
    const result = await f.run();
    assert.equal(clicks, 1);
    assert.equal(result.success, false);
    assert.equal(result.resultUnknown, true);
  } finally { f.close(); }
});

// 保留用户 DOM 中区分评论入口和发送按钮所需的结构。
const commentForm = '<div class="click-box op-item" role="button" aria-label="评论"><div class="op-text">评论</div></div>' +
  '<div class="input-box"><div class="input-area"><textarea class="weui-textarea"></textarea></div>' +
  '<div class="opr-area"><div class="extra"><div class="weui-btn weui-btn_primary weui-btn_mini">评论</div></div></div></div>';

const restrictionText = '操作太频繁，请稍后再试。检测到你\n的账号多次发布相似评论，恶意灌水\n可能被禁言处罚。';
const restrictionDialog = `<div role="alertdialog"><div>${restrictionText}</div><button>我知道了</button></div>`;

for (const delay of [0, 1, 3, 5]) {
  test(`发送后第${delay}秒出现风控弹窗，返回明确失败且只发送一次`, async () => {
    let sent = false, polls = 0, sends = 0, closes = 0;
    const f = setup(commentForm, (window, ms) => {
      if (sent && ms === 1000 && ++polls === delay) window.document.body.insertAdjacentHTML('beforeend', restrictionDialog);
    });
    try {
      f.window.close = () => closes++;
      f.window.document.querySelector('.weui-btn').onclick = () => {
        sent = true;
        sends++;
        if (delay === 0) f.window.document.body.insertAdjacentHTML('beforeend', restrictionDialog);
      };
      const result = await f.run();
      assert.equal(result.success, false);
      assert.equal(result.isCommented, false);
      assert.equal(result.reason, 'comment_restricted');
      assert.equal(result.retryable, false);
      assert.notEqual(result.resultUnknown, true);
      assert.equal(sends, 1);
      assert.equal(closes, 0);
      assert.equal(polls, Math.max(1, delay));
    } finally { f.close(); }
  });
}

for (const [name, markup, restricted] of [
  ['无弹窗', '', false],
  ['普通评论正文', `<div class="comment-item">${restrictionText}我知道了</div>`, false],
  ['隐藏弹窗', `<div style="display:none">${restrictionDialog}</div>`, false],
  ['不可见弹窗', `<div style="visibility:hidden">${restrictionDialog}</div>`, false],
  ['无布局尺寸弹窗', restrictionDialog, false],
  ['其他弹窗', '<div role="dialog">操作成功<button>我知道了</button></div>', false],
  ['无语义属性的弹窗', `<div><div>${restrictionText}</div><button>我知道了</button></div>`, true],
  ['微信弹窗样式', `<div class="weui-dialog"><div>${restrictionText}</div><a class="weui-dialog__btn">我知道了</a></div>`, true],
]) {
  test(`风控检测：${name}`, async () => {
    let sent = false, polls = 0;
    const f = setup(commentForm, (_window, ms) => { if (sent && ms === 1000) polls++; });
    try {
      f.window.document.querySelector('.weui-btn').onclick = () => {
        sent = true;
        f.window.document.body.insertAdjacentHTML('beforeend', markup);
        if (name === '无布局尺寸弹窗') f.window.document.querySelector('[role="alertdialog"]').getClientRects = () => [];
      };
      const result = await f.run();
      assert.equal(result.reason === 'comment_restricted', restricted);
      assert.equal(polls, restricted ? 1 : 5);
    } finally { f.close(); }
  });
}

test('评论流程打开操作栏入口后只点击输入框内的发送按钮', async () => {
  const f = setup(commentForm);
  const events = [];
  try {
    const doc = f.window.document;
    const input = doc.querySelector('textarea');
    doc.querySelector('.op-item').addEventListener('click', () => events.push('open'));
    doc.querySelector('.weui-btn').addEventListener('click', () => {
      assert.equal(input.value, 'private-text');
      events.push('send');
    });
    await f.run();
    assert.deepEqual(events, ['open', 'send']);
  } finally { f.close(); }
});

for (const [name, change] of [
  ['按钮缺失', (btn) => btn.remove()],
  ['原生禁用', (btn) => { btn.disabled = true; }],
  ['aria-disabled', (btn) => btn.setAttribute('aria-disabled', 'true')],
  ['禁用样式', (btn) => btn.classList.add('weui-btn_disabled')],
  ['无布局尺寸', (btn) => { btn.getClientRects = () => []; }],
  ['display:none', (btn) => { btn.style.display = 'none'; }],
  ['visibility:hidden', (btn) => { btn.style.visibility = 'hidden'; }],
  ['父容器隐藏', (btn) => { btn.parentElement.style.visibility = 'hidden'; }],
  ['父容器hidden属性', (btn) => { btn.parentElement.hidden = true; }],
  ['输入容器已移除', (btn) => btn.closest('.input-box').remove()],
]) {
  test(`发送按钮${name}时不回退点击操作栏`, async () => {
    const f = setup(commentForm);
    try {
      const doc = f.window.document;
      change(doc.querySelector('.weui-btn'));
      let opens = 0;
      doc.querySelector('.op-item').addEventListener('click', () => opens++);
      const result = await f.run();
      assert.equal(result.success, false);
      assert.equal(opens, 3, '每次重试只打开一次评论入口，不把入口当作发送按钮');
      assert.ok(!f.stages.some(s => s.includes('"stage":"send_click"')));
    } finally { f.close(); }
  });
}

test('发送按钮绑定当前输入框，不选择排在前面的其他输入框', () => {
  const f = setup(commentForm);
  try {
    const doc = f.window.document;
    const input = doc.querySelector('textarea');
    const send = doc.querySelector('.weui-btn');
    doc.body.prepend(input.closest('.input-box').cloneNode(true));
    assert.equal(f.window.__wx_parsers__.getSendBtn(input), send);
    assert.equal(f.window.__wx_parsers__.getSendBtn(null), null);
  } finally { f.close(); }
});

const disabledPanel = '<div class="comment-panel"><div class="scroll-ctn"><div class="flex h-16 flex-initial flex-shrink-0 items-center justify-center px-4"><div class="text-center text-sm text-fg-3">作者已关闭评论</div></div></div></div>';

for (const stage of ['already-open', 'after-open', 'input-poll', 'before-send']) {
  test(`closed comments return a definite reason without retry or send: ${stage}`, async () => {
    const f = setup('<button aria-label="评论，5081"></button>' + (stage === 'already-open' ? disabledPanel : ''));
    let opens = 0, sends = 0;
    try {
      const doc = f.window.document;
      doc.querySelector('button').onclick = () => {
        opens++;
        if (stage === 'after-open') doc.body.insertAdjacentHTML('beforeend', disabledPanel);
        if (stage === 'before-send') {
          doc.body.insertAdjacentHTML('beforeend', '<div class="input-box"><textarea class="weui-textarea"></textarea><button aria-label="发送" role="button">发送</button></div>');
          doc.querySelector('textarea').addEventListener('input', () => doc.body.insertAdjacentHTML('beforeend', disabledPanel), { once: true });
          doc.querySelector('[aria-label="发送"]').click = () => { sends++; };
        }
      };
      if (stage === 'input-poll') {
        f.window.__wx_parsers__.getCommentInput = () => {
          doc.body.insertAdjacentHTML('beforeend', disabledPanel);
          return null;
        };
      }
      const result = await f.run();
      assert.equal(result.success, false);
      assert.equal(result.isCommented, false);
      assert.equal(result.reason, 'comments_disabled');
      assert.equal(result.message, '作者已关闭评论');
      assert.equal(result.retryable, false);
      assert.notEqual(result.resultUnknown, true);
      assert.equal(opens, stage === 'already-open' ? 0 : 1);
      assert.equal(sends, 0);
      assert.ok(f.elapsed() < 10000, 'closed comments must return before the synchronous HTTP deadline');
      assert.equal(f.stages.filter((s) => s.includes('"stage":"attempt"')).length, 1);
    } finally { f.close(); }
  });
}

for (const decoy of [
  `<div style="display:none">${disabledPanel}</div>`,
  `<div style="visibility:hidden">${disabledPanel}</div>`,
  '<div class="comment-panel"><div class="comment-item">作者已关闭评论</div></div>',
  '<div class="author-desc text-center text-fg-3">作者已关闭评论</div>',
]) {
  test(`hidden or unrelated text must not mark comments disabled: ${decoy}`, async () => {
    const f = setup('<button aria-label="评论，1"></button>' + decoy);
    try {
      const result = await f.run();
      assert.notEqual(result.reason, 'comments_disabled');
      assert.ok(!f.stages.some((s) => s.includes('comments_disabled')));
    } finally { f.close(); }
  });
}

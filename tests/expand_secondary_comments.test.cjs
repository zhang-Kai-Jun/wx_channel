const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../internal/handlers/script.go'), 'utf8');
const start = source.indexOf('// 尝试展开二级评论');
const end = source.indexOf('// 暴露辅助函数到全局', start);
assert.ok(start >= 0 && end > start, '找到服务实际注入的展开脚本');
const expandSource = source.slice(start, end);

function replies(text = '21条回复', icon = true) {
  return `<div class="comment-item__extra"><div class="comment-reply-list"></div>
    <div class="load-more"><div class="click-box load-more__btn">
      <div class="text">${text}</div>${icon ? '<div class="weui-icon-outlined-arrow"></div>' : ''}
    </div></div></div>`;
}

function setup(html) {
  const dom = new JSDOM(html);
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get() {
      for (let node = this; node; node = node.parentElement) {
        if (node.hidden || window.getComputedStyle(node).display === 'none') return null;
      }
      return this.parentElement;
    },
  });
  window.HTMLElement.prototype.scrollIntoView = function() {};
  let now = 10000;
  const context = {
    window, document: window.document, MouseEvent: window.MouseEvent,
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date { static now() { return now; } },
  };
  vm.runInNewContext(expandSource, context);
  const clicks = [];
  window.document.addEventListener('click', event => clicks.push(event.target), true);
  return {
    document: window.document, clicks,
    run: () => context.expandSecondaryComments(),
    advance: ms => { now += ms; },
    close: () => window.close(),
  };
}

const nicknames = '<span class="comment-user-name clickable">从来不看回复</span>' +
  '<span class="reply-user-name clickable">爱自己更多</span>' +
  '<span class="comment-user-name clickable">21条回复</span>' +
  '<div class="click-box action-item">回复</div>';

test('只点击真正的展开按钮，下一轮也不兜底点击昵称或普通回复', () => {
  const f = setup(`<div class="comment-panel"><div class="comment-list">${nicknames}${replies()}</div></div>`);
  try {
    const button = f.document.querySelector('.load-more__btn');
    assert.equal(f.run(), 1);
    assert.equal(f.run(), 0);
    f.advance(300);
    assert.equal(f.run(), 0);
    assert.deepEqual(f.clicks, [button]);
  } finally { f.close(); }
});

test('没有展开按钮时不点击含回复或更多的昵称', () => {
  const f = setup(`<div class="comment-panel">${nicknames}</div>`);
  try {
    assert.equal(f.run(), 0);
    assert.deepEqual(f.clicks, []);
  } finally { f.close(); }
});

test('DOM 中的三种剩余回复数都命中，每个按钮只点击一次', () => {
  const f = setup(`<div class="comment-panel"><div class="comment-list">${
    [21, 40, 1].map(count => replies(`${count}条回复`)).join('')
  }</div></div>`);
  try {
    assert.equal(f.run(), 3);
    assert.deepEqual(f.clicks, [...f.document.querySelectorAll('.load-more__btn')]);
  } finally { f.close(); }
});

test('允许图标缺失、包装层变化和文字空白差异', () => {
  const f = setup(`<div class="comment-panel">${replies(' \n 21 条 回复 \n ', false)}</div>`);
  try {
    const button = f.document.querySelector('.load-more__btn');
    const wrapper = f.document.createElement('section');
    button.before(wrapper);
    wrapper.append(button);
    assert.equal(f.run(), 1);
    assert.deepEqual(f.clicks, [button]);
  } finally { f.close(); }
});

for (const text of ['回复', '从来不看回复', '展开更多', '收起回复', '0条回复', '21条回复查看更多']) {
  test(`不点击不符合数字回复文案的按钮：${text}`, () => {
    const f = setup(`<div class="comment-panel">${replies(text)}</div>`);
    try {
      assert.equal(f.run(), 0);
      assert.deepEqual(f.clicks, []);
    } finally { f.close(); }
  });
}

for (const html of [replies(), `<div class="comment-panel">${replies().replace('comment-item__extra', 'other')}</div>`]) {
  test('展开按钮必须同时属于评论区和评论的 extra 区域', () => {
    const f = setup(html);
    try {
      assert.equal(f.run(), 0);
      assert.deepEqual(f.clicks, []);
    } finally { f.close(); }
  });
}

for (const attrs of ['hidden', 'style="display:none"', 'style="visibility:hidden"', 'aria-hidden="true"', 'inert']) {
  test(`跳过隐藏评论面板：${attrs}`, () => {
    const f = setup(`<div class="comment-panel" ${attrs}>${replies()}</div>`);
    try {
      assert.equal(f.run(), 0);
      assert.deepEqual(f.clicks, []);
    } finally { f.close(); }
  });
}

for (const attr of ['disabled', 'aria-disabled', 'aria-busy']) {
  test(`跳过不可点击或加载中的按钮：${attr}`, () => {
    const f = setup(`<div class="comment-panel">${replies()}</div>`);
    try {
      f.document.querySelector('.load-more__btn').setAttribute(attr, 'true');
      assert.equal(f.run(), 0);
      assert.deepEqual(f.clicks, []);
    } finally { f.close(); }
  });
}

test('旧处理标记不阻止点击，剩余回复数变化后可继续加载', () => {
  const f = setup(`<div class="comment-panel">${replies()}</div>`);
  try {
    const button = f.document.querySelector('.load-more__btn');
    button.classList.add('expanded-handled');
    button.setAttribute('data-handled-text', button.innerText);
    assert.equal(f.run(), 1);
    button.querySelector('.text').textContent = '11条回复';
    assert.equal(f.run(), 1);
    assert.equal(f.run(), 0);
    assert.deepEqual(f.clicks, [button, button]);
  } finally { f.close(); }
});

test('剩余文案未变但回复列表增长时允许继续加载', () => {
  const f = setup(`<div class="comment-panel">${replies()}</div>`);
  try {
    assert.equal(f.run(), 1);
    f.document.querySelector('.comment-reply-list').innerHTML = '<div class="comment-item">新回复</div>';
    assert.equal(f.run(), 1);
    assert.equal(f.run(), 0);
    assert.equal(f.clicks.length, 2);
  } finally { f.close(); }
});

test('相同评论重建按钮时仍阻止短时间重复点击，超时允许重试', () => {
  const f = setup(`<div class="comment-panel">${replies()}</div>`);
  try {
    assert.equal(f.run(), 1);
    const button = f.document.querySelector('.load-more__btn');
    button.replaceWith(button.cloneNode(true));
    f.advance(300);
    assert.equal(f.run(), 0);
    f.advance(5000);
    assert.equal(f.run(), 1);
    assert.equal(f.clicks.length, 2);
  } finally { f.close(); }
});

test('点击失败不计为成功展开，也不会阻止下一次重试', () => {
  const f = setup(`<div class="comment-panel">${replies()}</div>`);
  try {
    const button = f.document.querySelector('.load-more__btn');
    button.scrollIntoView = () => { throw new Error('模拟点击失败'); };
    assert.equal(f.run(), 0);
    button.scrollIntoView = () => {};
    assert.equal(f.run(), 1);
    assert.deepEqual(f.clicks, [button]);
  } finally { f.close(); }
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = process.env.NAVIGATION_TEST_BASELINE === 'staged'
  ? require('node:child_process').execFileSync('git', ['show', ':internal/assets/inject/api_client.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, '../internal/assets/inject/api_client.js'), 'utf8');
const clientSource = source.slice(0, source.indexOf('// 自动初始化'));
const parserSource = source.slice(source.indexOf('window.__wx_selectors__ ='));

function profileCard(id, marker = '', title = id) {
  return `<div class="card-wrp"><div class="click-box" ml-key="finder-profile-card" id="${id}">
    <div class="object-card profile-object-card ${marker === 'live-card' ? marker : ''}">
      ${marker === 'living-tag' ? '<div class="living-tag">直播中</div>' : ''}
      <div class="profile-object-title" title="${title}">${title}</div>
    </div></div></div>`;
}

for (const action of ['open_link', 'open_profile', 'enter_video']) {
  for (const connected of [true, false]) {
    test(`${action} acknowledges before navigation, connected=${connected}`, async () => {
      const dom = new JSDOM(profileCard('video'), { url: 'https://channels.weixin.qq.com/web/pages/profile' });
      const events = [];
      const { window } = dom;
      window.WXU = { API: {}, API2: {} };
      vm.runInNewContext(clientSource + '\n' + parserSource, {
        window, document: window.document, WebSocket: { OPEN: 1 }, AbortSignal,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => { events.push('navigation-scheduled'); },
        fetch: async () => { events.push('http'); return { ok: true }; },
      });
      try {
        const client = window.__wx_api_client;
        client.connected = connected;
        client.ws = { readyState: 1, send: (message) => events.push(JSON.parse(message)) };
        await client.handleAPICall({
          id: 'nav-1', key: 'key:channels:dom_action',
          body: { action, target: 'author', url: 'https://channels.weixin.qq.com/web/pages/profile', index: 0 },
        });
        if (connected && action === 'open_link') {
          assert.equal(events[0].type, 'api_response');
          assert.equal(events[0].data.id, 'nav-1');
          assert.equal(events[0].data.data.success, true);
          assert.ok(!events.includes('http'));
        } else {
          assert.equal(events[0], 'http');
        }
        assert.equal(events[1], 'navigation-scheduled');
      } finally { window.close(); }
    });
  }
}

const live = profileCard('live', 'live-card');
const living = profileCard('living', 'living-tag');
const videoA = profileCard('video-a', '', '普通 视频A');
const videoB = profileCard('video-b', '', '直播穿搭回顾');

for (const scenario of [
  { name: '首张直播时点击第二张卡片', html: live + videoA, expected: 'video-a' },
  { name: '仅有直播状态标签也会跳过', html: living + videoA, expected: 'video-a' },
  { name: '首张普通视频仍点击首张', html: videoA + live, expected: 'video-a' },
  { name: '连续直播卡片全部跳过', html: live + living + videoA, expected: 'video-a' },
  { name: '标题含直播的普通视频可以点击', html: videoB, expected: 'video-b' },
  { name: '索引按过滤后的视频顺序取值', html: live + videoA + videoB, index: 1, expected: 'video-b' },
  { name: '作者目标也跳过直播', html: live + videoA, target: 'author', expected: 'video-a' },
  { name: '只有直播时返回失败且不兜底点击', html: live + living },
  { name: '空主页返回失败', html: '' },
  { name: '索引越界返回失败', html: live + videoA, index: 1 },
  { name: '负数索引返回失败', html: videoA, index: -1 },
  { name: '搜索页保持原有点击路径', html: `<div class="res-block"><div class="block-title"><div class="title">动态</div></div><div class="card-grid">${videoA}</div></div>`, page: 's', expected: 'video-a' },
]) {
  test(scenario.name, async () => {
    const dom = new JSDOM(scenario.html, { url: `https://channels.weixin.qq.com/web/pages/${scenario.page || 'profile'}` });
    const { window } = dom;
    const pending = [];
    const events = [];
    const responses = [];
    window.WXU = { API: {}, API2: {} };
    window.HTMLElement.prototype.scrollIntoView = function() {};
    window.document.addEventListener('click', event => events.push(event.target.id));
    vm.runInNewContext(clientSource + '\n' + parserSource, {
      window, document: window.document, WebSocket: { OPEN: 1 }, AbortSignal,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: callback => pending.push(callback),
      fetch: async (_url, options) => {
        events.push('http');
        responses.push(JSON.parse(options.body));
        return { ok: true };
      },
    });
    try {
      const cards = window.__wx_parsers__.getCardElements();
      const index = scenario.index ?? 0;
      if (!scenario.page) assert.equal(cards[index]?.id, scenario.expected);
      // 故意放入旧标题，验证主页回执来自本次真正选择的卡片。
      window.__wx_cached_cards = [{ videoTitle: '旧的直播标题' }];
      window.__wx_author_cached_cards = [{ videoTitle: '旧的作者标题' }];
      await window.__wx_api_client.handleAPICall({
        id: 'profile-nav', key: 'key:channels:dom_action',
        body: { action: 'enter_video', target: scenario.target || 'video', index },
      });
      assert.equal(responses.length, 1);
      assert.equal(responses[0].data.data.success, !!scenario.expected);
      if (!scenario.expected) assert.equal(pending.length, 0);
      while (pending.length) pending.shift()();
      assert.deepEqual(events, scenario.expected ? ['http', scenario.expected] : ['http']);
      if (scenario.expected && !scenario.page) {
        assert.equal(responses[0].data.data.videoTitle,
          window.document.getElementById(scenario.expected).querySelector('.profile-object-title').textContent.replace(/\s+/g, ''));
      }
    } finally { window.close(); }
  });
}

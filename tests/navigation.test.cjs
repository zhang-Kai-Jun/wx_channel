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

for (const action of ['open_link', 'open_profile', 'enter_video']) {
  for (const connected of [true, false]) {
    test(`${action} acknowledges before navigation, connected=${connected}`, async () => {
      const dom = new JSDOM('', { url: 'https://channels.weixin.qq.com/web/pages/profile' });
      const events = [];
      const { window } = dom;
      window.WXU = { API: {}, API2: {} };
      vm.runInNewContext(clientSource, {
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

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

function setup(pagePath, html) {
  const dom = new JSDOM(html, { url: 'https://channels.weixin.qq.com/web/pages/' + pagePath, runScripts: 'outside-only' });
  const w = dom.window;
  w.console = { log() {}, warn() {}, error() {} };
  w.setTimeout = w.setInterval = () => 1;
  w.fetch = async () => ({ ok: true, json: async () => ({}) });
  for (const file of ['lib/mitt.umd.js','eventbus.js','utils.js','core.js','feed.js','profile.js','search.js','home.js']) {
    w.eval(fs.readFileSync(path.join(__dirname,'../internal/assets/inject',file),'utf8'));
  }
  return dom;
}

test('collection scripts initialize together without the downloader', async () => {
  const dom = setup('feed','<header class="home-header"><div class="pointer-events-auto flex-initial flex-shrink-0 pl-4"><div class="flex items-center"></div></div></header>');
  try {
    const w = dom.window;
    assert.equal(await w.__insert_tools_to_feed_toolbar(), true);
    assert.ok(w.document.querySelector('#wx-feed-comment-icon'));
    assert.ok(w.document.querySelector('#wx-feed-comment-snapshot-icon'));
    assert.equal(w.document.querySelector('#wx-feed-download-icon'), null);
    assert.equal(typeof w.WXU.set_feed,'function');
    assert.equal(typeof w.insert_channel_tools,'function');
    assert.equal(w.WXU.decrypt_video,undefined);
  } finally { dom.window.close(); }
});

test('search results still open and close without the batch download component', () => {
  const dom = setup('s','<div data-v-bf57a568 class="flex items-center"></div>');
  try {
    const w=dom.window;
    w.__wx_channels_search_collector.injectToolbarIcon();
    const button=w.document.querySelector('#wx-search-results-icon');
    assert.ok(button);
    button.onclick();
    assert.equal(w.document.querySelector('#wx-channels-search-ui').style.display,'block');
    assert.ok(w.document.querySelector('#search-export-btn'));
    assert.equal(w.document.querySelector('#search-download-btn'),null);
    button.onclick();
    assert.equal(w.document.querySelector('#wx-channels-search-ui').style.display,'none');
  } finally { dom.window.close(); }
});

test('author collection tools remain available without the download button', () => {
  const dom = setup('profile','<div class="profile-info"><div class="opr-area"></div></div>');
  try {
    const w=dom.window;
    w.__wx_channels_profile_collector.injectToolbarTools();
    assert.ok(w.document.querySelector('#wx-profile-dom-btn'));
    assert.equal(w.document.querySelector('#wx-profile-download-btn'),null);
    assert.equal(typeof w.__wx_channels_profile_collector.addVideoFromAPI,'function');
  } finally { dom.window.close(); }
});

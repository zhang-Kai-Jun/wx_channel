const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('real short media stays paused, explicit user play works, and the next feed is protected', {
  skip: !process.env.PAUSE_BROWSER_EXECUTABLE
}, async t => {
  const browser = await chromium.launch({
    executablePath: process.env.PAUSE_BROWSER_EXECUTABLE,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const source = fs.readFileSync(path.join(__dirname, '../internal/assets/inject/api_client.js'), 'utf8');
    const script = source.slice(0, source.indexOf('// 自动初始化')) +
      '\nwindow.__wx_api_client.init = function() {};\n' +
      source.slice(source.indexOf('// 自动初始化'), source.indexOf('// 监听初始化事件'));
    await page.route('**/*', route => route.fulfill({
      contentType: route.request().url().endsWith('/pause-test.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      body: route.request().url().endsWith('/pause-test.js') ? script :
        '<html><head><meta charset="utf-8"><script src="/pause-test.js"></script></head><body></body></html>'
    }));
    await page.goto('https://channels.weixin.qq.com/web/pages/feed');
    await page.evaluate(() => {
      document.body.innerHTML = '<div class="slides-item"><div id="flow-feed-one"><video muted playsinline preload="auto" style="width:320px;height:180px"></video></div><button aria-label="\u64ad\u653e">Play</button></div>';
      const video = document.querySelector('video');
      const sampleCount = 960;
      const buffer = new ArrayBuffer(44 + sampleCount * 2);
      const view = new DataView(buffer);
      const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true);
      text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, 'data'); view.setUint32(40, sampleCount * 2, true);
      video.src = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
      window.probe = { ended: 0, playStates: [], rejections: [] };
      video.addEventListener('ended', () => window.probe.ended++);
      video.addEventListener('play', () => window.probe.playStates.push(video.paused));
      window.startMedia = () => video.play().catch(error => window.probe.rejections.push(error.name));
      document.querySelector('button').onclick = window.startMedia;
      window.startMedia();
    });
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 5000 }).catch(async error => {
      t.diagnostic(JSON.stringify(await page.evaluate(() => {
        const video = document.querySelector('video');
        return { probe: window.probe, readyState: video.readyState, networkState: video.networkState,
          paused: video.paused, mediaError: video.error && video.error.message };
      })));
      t.diagnostic(JSON.stringify(errors));
      throw error;
    });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.probe.ended), 0);
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), true);
    const states = await page.evaluate(() => window.probe.playStates);
    assert.ok(states.length > 0 && states.every(Boolean));
    await page.getByRole('button').click();
    await page.waitForFunction(() => window.probe.ended === 1, null, { timeout: 5000 }).catch(async error => {
      t.diagnostic(JSON.stringify(await page.evaluate(() => ({ probe: window.probe,
        paused: document.querySelector('video').paused, time: document.querySelector('video').currentTime,
        duration: document.querySelector('video').duration }))));
      throw error;
    });
    await page.evaluate(() => {
      document.querySelector('[id]').id = 'flow-feed-two';
      const video = document.querySelector('video');
      video.currentTime = 0;
      window.startMedia();
    });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.probe.ended), 1);
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

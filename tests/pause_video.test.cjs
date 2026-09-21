const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = ['1', 'staged'].includes(process.env.PAUSE_TEST_BASELINE)
  ? execFileSync('git', ['show', (process.env.PAUSE_TEST_BASELINE === 'staged' ? '' : 'HEAD') + ':internal/assets/inject/api_client.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
  : fs.readFileSync(path.join(__dirname, '../internal/assets/inject/api_client.js'), 'utf8');
const clientSource = source.slice(0, source.indexOf('// 自动初始化')) +
  source.slice(source.indexOf('window.__wx_selectors__ ='));
const pauseLabel = '\u6682\u505c';
const playLabel = '\u64ad\u653e';

function setup(html, onWait = () => {}, options = {}) {
  const dom = new JSDOM(html, { url: options.url || 'https://channels.weixin.qq.com/' });
  const { window } = dom;
  const document = window.document;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = this.closest('[hidden], [data-offscreen]');
    const zero = this.matches('audio');
    const top = hidden ? 2000 : 0;
    return { left: 0, right: zero ? 0 : 640, top, bottom: top + (zero ? 0 : 480), width: zero ? 0 : 640, height: zero ? 0 : 480 };
  };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { get() { return this.getBoundingClientRect().width; } },
    offsetHeight: { get() { return this.getBoundingClientRect().height; } }
  });
  vm.runInNewContext(clientSource, {
    window, document, XPathResult: window.XPathResult, KeyboardEvent: window.KeyboardEvent, MutationObserver: window.MutationObserver,
    console: { log() {}, warn() {}, error() {} },
    Date: options.now ? class extends Date { static now() { return options.now(); } } : Date,
    fetch: async () => ({}), clearTimeout,
    setTimeout: (callback, delay) => {
      const invoke = () => { onWait(delay, document); callback(); };
      if (options.asyncTimers) return setTimeout(invoke, Math.min(delay, 5));
      invoke();
      return 0;
    }
  });
  return { window, document, run: () => window.__wx_api_client.executeDomAction({ action: 'pause_video' }) };
}

function mediaState(element, paused = false, canPause = true) {
  const state = { paused, calls: 0 };
  Object.defineProperty(element, 'paused', { get: () => state.paused });
  Object.defineProperty(element, 'readyState', { configurable: true, get: () => 2 });
  element.pause = () => { state.calls++; if (canPause) state.paused = true; };
  return state;
}

for (const hidden of [false, true]) {
  test(`comment collection recognizes only visible disabled notice: ${hidden}`, async () => {
    const { window, document } = setup(`<div class="comment-panel" ${hidden ? 'hidden' : ''}><div class="text-center text-fg-3">作者已关闭评论</div></div>`);
    const notice = document.querySelector('.text-center');
    notice.getClientRects = () => [{}];
    window.WXU = { API: {}, API2: {} };
    let collected = 0, reply, callback;
    window.__sph_fetch_video_comments = () => {
      collected++;
      return { panel_ready: true, comment_count: 1, raw_items: [] };
    };
    window.__wx_api_client.sendResponse = (_id, data) => { reply = data; };
    window.__wx_api_client.sendFetchCommentsCallback = (_id, data) => { callback = data; };
    try {
      await window.__wx_api_client.handleAPICall({ id: 1, key: 'key:channels:dom_action', body: { action: 'fetch_video_comments', task_id: 'test' } });
      assert.equal(reply.success, hidden);
      assert.equal(callback.success, hidden);
      assert.equal(collected, hidden ? 1 : 0);
      if (!hidden) {
        assert.equal(reply.result.reason, 'comments_disabled');
        assert.equal(callback.message, '作者已关闭评论');
      }
    } finally { window.close(); }
  });
}

function slide(media = '<audio class="h-0 w-0"></audio>', label = pauseLabel) {
  return `<div class="slides-item"><div ml-key="flow-image">${media}</div><div class="bottom-area"><button aria-label="${label}"><svg ml-key="flow-video-${label === pauseLabel ? 'pause' : 'play'}"></svg></button></div></div>`;
}

test('image post pauses its zero-size audio through the control and is idempotent', async () => {
  const { document, run } = setup(slide());
  const state = mediaState(document.querySelector('audio'));
  const button = document.querySelector('button');
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    state.paused = true;
    button.setAttribute('aria-label', playLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  const result = await run();
  assert.equal(result.success, true);
  assert.equal(clicks, 1);
  assert.equal(state.paused, true);
  assert.equal((await run()).byMethod, 'already_paused');
  assert.equal(clicks, 1);
});

test('icon-only control is clicked through its button and can be replaced on render', async () => {
  const { document, run } = setup(slide(''));
  const button = document.querySelector('button');
  button.removeAttribute('aria-label');
  button.onclick = () => { button.outerHTML = `<button><svg ml-key="flow-video-play"></svg></button>`; };
  assert.equal((await run()).byMethod, 'button_click');
});

test('a reused image pause button can immediately stop a different feed', async () => {
  const { document, run } = setup(slide('').replace('ml-key="flow-image"', 'ml-key="flow-image" id="flow-feed-one"'));
  const button = document.querySelector('button');
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    button.setAttribute('aria-label', playLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  assert.equal((await run()).success, true);
  document.querySelector('[id]').id = 'flow-feed-two';
  button.setAttribute('aria-label', pauseLabel);
  button.querySelector('svg').setAttribute('ml-key', 'flow-video-pause');
  assert.equal((await run()).success, true);
  assert.equal(clicks, 2);
});

test('empty page is not reported as already paused', async () => {
  assert.equal((await setup('').run()).success, false);
});

test('offscreen controls and media are left alone', async () => {
  const { document, run } = setup(slide().replace('class="slides-item"', 'class="slides-item" data-offscreen') + slide());
  const audios = [...document.querySelectorAll('audio')].map(audio => mediaState(audio));
  const buttons = [...document.querySelectorAll('button')];
  buttons[0].onclick = () => assert.fail('clicked offscreen post');
  buttons[1].onclick = () => {
    audios[1].paused = true;
    buttons[1].setAttribute('aria-label', playLabel);
    buttons[1].querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  assert.equal((await run()).success, true);
  assert.equal(audios[0].paused, false);
  assert.equal(audios[0].calls, 0);
});

test('native video without controls still pauses', async () => {
  const { document, run } = setup('<video></video>');
  const state = mediaState(document.querySelector('video'));
  assert.equal((await run()).success, true);
  assert.equal(state.paused, true);
});

test('stale video pause control never toggles native playback back on', async () => {
  let now = 0;
  const { document, run } = setup('<div class="slides-item"><video></video><button aria-label="' + pauseLabel + '"></button></div>',
    () => { now += 500; }, { now: () => now });
  const state = mediaState(document.querySelector('video'));
  let clicks = 0;
  document.querySelector('button').onclick = () => { clicks++; state.paused = !state.paused; };
  assert.equal((await run()).success, true);
  assert.equal((await run()).success, true);
  assert.equal(state.paused, true);
  assert.equal(clicks, 0);
  assert.equal(state.calls, 1);
});

test('image toggle is clicked only once while labels lag even across rerenders and source changes', async () => {
  let now = 0, clicks = 0, playing = true;
  const { document, window, run } = setup(slide().replace('ml-key="flow-image"', 'ml-key="flow-image" id="flow-feed-one"'),
    () => { now += 500; }, { now: () => now });
  const state = mediaState(document.querySelector('audio'));
  document.addEventListener('click', event => {
    if (!event.target.closest('button')) return;
    clicks++;
    playing = !playing;
  });
  await run();
  const button = document.querySelector('button');
  button.replaceWith(button.cloneNode(true));
  document.querySelector('audio').src = 'loaded.mp3';
  await run();
  assert.equal(clicks, 1);
  assert.equal(playing, false);
  assert.equal(state.paused, true);
  const replacement = document.querySelector('button');
  replacement.setAttribute('aria-label', playLabel);
  replacement.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  assert.equal((await run()).success, true);
  // A confirmed play -> pause control transition allows protecting a later autoplay.
  replacement.setAttribute('aria-label', pauseLabel);
  replacement.querySelector('svg').setAttribute('ml-key', 'flow-video-pause');
  playing = true;
  await run();
  assert.equal(clicks, 2);
  assert.equal(playing, false);
  window.close();
});

test('already paused video is not toggled by keyboard', async () => {
  const { document, run } = setup('<video></video>');
  const state = mediaState(document.querySelector('video'), true);
  document.addEventListener('keydown', () => assert.fail('toggled paused video'));
  assert.equal((await run()).byMethod, 'already_paused');
  assert.equal(state.calls, 0);
});

test('play icon does not prove success while audio still plays', async () => {
  const { document, run } = setup(slide());
  mediaState(document.querySelector('audio'), false, false);
  const button = document.querySelector('button');
  button.onclick = () => {
    button.setAttribute('aria-label', playLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  assert.equal((await run()).success, false);
});

test('image control must pause the slideshow even before audio starts', async () => {
  const { document, run } = setup(slide());
  mediaState(document.querySelector('audio'), true);
  const button = document.querySelector('button');
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    button.setAttribute('aria-label', playLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  assert.equal((await run()).byMethod, 'button_click');
  assert.equal(clicks, 1);
});

test('stalled time alone does not prove a failed pause succeeded', async () => {
  const { document, run } = setup('<video></video>');
  mediaState(document.querySelector('video'), false, false);
  assert.equal((await run()).success, false);
});

test('native audio fallback works when the control is unavailable', async () => {
  const { document, run } = setup('<div class="slides-item"><div ml-key="flow-image"><audio></audio></div></div>');
  const state = mediaState(document.querySelector('audio'));
  assert.equal((await run()).success, true);
  assert.equal(state.paused, true);
});

test('pause errors report failure without toggling the keyboard', async () => {
  const { document, run } = setup('<video></video>');
  mediaState(document.querySelector('video'));
  document.querySelector('video').pause = () => { throw new Error('unavailable'); };
  document.addEventListener('keydown', () => assert.fail('must not toggle playback'));
  assert.equal((await run()).success, false);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'automatic pause did not complete');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function autoSetup(t, html, pathname = 'feed', options = {}) {
  const context = setup(html, () => {}, { ...options, asyncTimers: true, url: `https://channels.weixin.qq.com/web/pages/${pathname}` });
  const client = context.window.__wx_api_client;
  t.after(async () => {
    if (client.stopAutoPause) client.stopAutoPause();
    if (client.pausePromise) await client.pausePromise;
    context.window.close();
  });
  return { ...context, client };
}

test('auto pause starts without an API request and ignores duplicate DOM notifications', async t => {
  const { document, window, client } = autoSetup(t, '<video></video>');
  const state = mediaState(document.querySelector('video'));
  client.startAutoPause();
  await waitFor(() => state.paused && !client.pausePromise);
  document.querySelector('video').className = 'updated';
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(state.calls, 1);
  state.paused = false;
  document.querySelector('video').dispatchEvent(new window.Event('play'));
  await waitFor(() => state.paused && !client.pausePromise);
  assert.equal(state.calls, 2);
});

test('auto pause waits for a dynamically inserted image player and coalesces manual requests', async t => {
  const { document, client, run } = autoSetup(t, '');
  client.startAutoPause();
  document.body.innerHTML = slide();
  const state = mediaState(document.querySelector('audio'));
  const button = document.querySelector('button');
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    state.paused = true;
    button.setAttribute('aria-label', playLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  await waitFor(() => client.pausePromise);
  assert.equal((await run()).success, true);
  assert.equal(clicks, 1);
});

test('auto pause retries when the control arrives after the first failed operation', async t => {
  const { document, client } = autoSetup(t, '<div class="slides-item"><div ml-key="flow-image"><audio></audio></div></div>');
  const state = mediaState(document.querySelector('audio'), false, false);
  client.startAutoPause();
  await waitFor(() => state.calls >= 5 && !client.pausePromise);
  const button = document.createElement('button');
  button.setAttribute('aria-label', pauseLabel);
  button.onclick = () => {
    state.paused = true;
    button.setAttribute('aria-label', playLabel);
  };
  document.querySelector('.slides-item').append(button);
  await waitFor(() => state.paused && !client.pausePromise);
});

test('auto pause bounds background retries but still handles new play events', async t => {
  const { document, window, client } = autoSetup(t, '<video></video>');
  const video = document.querySelector('video');
  const state = mediaState(video, false, false);
  client.startAutoPause();
  await waitFor(() => state.calls === 15 && !client.pausePromise);
  video.className = 'changed';
  video.dispatchEvent(new window.Event('play'));
  assert.equal(state.calls, 16);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(state.calls, 16);
  document.body.innerHTML = '<video></video>';
  const nextState = mediaState(document.querySelector('video'));
  await waitFor(() => nextState.paused && !client.pausePromise);
});

test('auto pause cancels a pending retry when stopped', async t => {
  const { document, client } = autoSetup(t, '<video></video>');
  const state = mediaState(document.querySelector('video'), false, false);
  client.startAutoPause();
  await waitFor(() => state.calls === 5 && !client.pausePromise);
  client.stopAutoPause();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(state.calls, 5);
});

test('auto pause continues protecting the content after five seconds', async t => {
  let now = 10000;
  const { document, window, client } = autoSetup(t, '<video></video>', 'feed', { now: () => now });
  const video = document.querySelector('video');
  const state = mediaState(video);
  const pause = video.pause;
  video.pause = () => {
    if (state.calls === 0) now += 6000;
    pause();
  };
  client.startAutoPause();
  await waitFor(() => state.paused && !client.pausePromise);
  now += 4000;
  state.paused = false;
  video.dispatchEvent(new window.Event('play'));
  await waitFor(() => state.paused && !client.pausePromise);
  assert.equal(state.calls, 2);
  now += 2000;
  state.paused = false;
  video.dispatchEvent(new window.Event('play'));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(state.paused, true);
  assert.equal(state.calls, 3);
});

test('short video is paused inside the play event before it can finish and advance', async t => {
  const { document, window, client } = autoSetup(t, '<video></video>');
  const video = document.querySelector('video');
  const state = mediaState(video, true);
  client.startAutoPause();
  state.paused = false;
  video.dispatchEvent(new window.Event('play'));
  let advanced = false;
  if (!state.paused) {
    video.dispatchEvent(new window.Event('ended'));
    advanced = true;
  }
  assert.equal(advanced, false);
  assert.equal(state.paused, true);
});

test('initial scan pauses already playing media without a timer', async t => {
  const { document, client } = autoSetup(t, '<video></video>');
  const state = mediaState(document.querySelector('video'));
  client.startAutoPause();
  assert.equal(state.paused, true);
});

test('a new target pauses immediately while the previous confirmation is pending', async t => {
  const { document, window, client, run } = autoSetup(t, '<div class="slides-item"><video></video></div>');
  mediaState(document.querySelector('video'));
  client.startAutoPause();
  const previous = client.pausePromise;
  document.body.innerHTML = '<div class="slides-item"><video></video></div>';
  const video = document.querySelector('video');
  const state = mediaState(video);
  video.dispatchEvent(new window.Event('play'));
  assert.equal(state.paused, true);
  assert.notEqual(client.pausePromise, previous);
  assert.equal((await run()).success, true);
  assert.equal((await previous).cancelled, true);
});

test('transitioning feed media pauses even while the old slide has the largest visible area', async t => {
  const { document, window, client } = autoSetup(t,
    '<div class="slides-item"><video></video></div><div class="slides-item" data-offscreen><video></video></div>');
  const videos = [...document.querySelectorAll('video')];
  mediaState(videos[0]);
  const next = mediaState(videos[1], true);
  client.startAutoPause();
  next.paused = false;
  videos[1].dispatchEvent(new window.Event('playing'));
  assert.equal(next.paused, true);
});

test('DOM insertion pauses a short video before the next timer task', async t => {
  const { document, client } = autoSetup(t, '');
  client.startAutoPause();
  document.body.innerHTML = '<div class="slides-item"><video></video></div>';
  const state = mediaState(document.querySelector('video'));
  await Promise.resolve();
  assert.equal(state.paused, true);
});

test('native fallback runs before waiting for an ineffective pause button', async () => {
  let state;
  let playedDuringWait = false;
  const { document, run } = setup(slide('<video></video>'), () => {
    if (!state.paused) playedDuringWait = true;
  });
  state = mediaState(document.querySelector('video'));
  await run();
  assert.equal(playedDuringWait, false, 'media kept playing until the first timer');
});

function userInputHandlers(document) {
  const handlers = {};
  const add = document.addEventListener.bind(document);
  document.addEventListener = (type, handler, options) => {
    if (type === 'click' || type === 'keydown') handlers[type] = handler;
    return add(type, handler, options);
  };
  return handlers;
}

test('explicit play click releases only the current content, including a reused media node', async t => {
  const { document, window, client } = autoSetup(t,
    `<div class="slides-item"><div id="flow-feed-one"><video src="one.mp4"></video></div><button aria-label="${playLabel}"></button></div>`);
  const handlers = userInputHandlers(document);
  const video = document.querySelector('video');
  const state = mediaState(video);
  client.startAutoPause();
  await waitFor(() => !client.pausePromise);
  assert.equal(typeof handlers.click, 'function');
  handlers.click({ type: 'click', isTrusted: true, target: document.querySelector('button') });
  state.paused = false;
  video.dispatchEvent(new window.Event('play'));
  assert.equal(state.paused, false);
  document.querySelector('[id]').id = 'flow-feed-two';
  video.src = 'two.mp4';
  video.dispatchEvent(new window.Event('play'));
  assert.equal(state.paused, true);
});

test('play key releases playback but comment input and synthetic clicks do not', async t => {
  const { document, window, client } = autoSetup(t,
    `<div class="slides-item"><video></video><textarea></textarea><button aria-label="${playLabel}"></button></div>`);
  const handlers = userInputHandlers(document);
  const video = document.querySelector('video');
  const state = mediaState(video);
  client.startAutoPause();
  await waitFor(() => !client.pausePromise);
  assert.equal(typeof handlers.keydown, 'function');
  handlers.keydown({ type: 'keydown', isTrusted: true, target: document.querySelector('textarea'), key: ' ' });
  document.querySelector('button').click();
  state.paused = false;
  video.dispatchEvent(new window.Event('play'));
  assert.equal(state.paused, true);
  handlers.keydown({ type: 'keydown', isTrusted: true, target: video, key: ' ' });
  state.paused = false;
  video.dispatchEvent(new window.Event('play'));
  assert.equal(state.paused, false);
});

test('bootstrap installs pause protection while the document is still loading', async t => {
  const { document, window, client } = autoSetup(t, '<video></video>');
  Object.defineProperty(document, 'readyState', { get: () => 'loading' });
  const state = mediaState(document.querySelector('video'));
  client.init = () => {};
  const bootstrap = source.slice(source.indexOf('// 自动初始化'), source.indexOf('// 监听初始化事件'));
  vm.runInNewContext(bootstrap, { window, document });
  assert.equal(typeof client.stopAutoPause, 'function');
  assert.equal(state.paused, true);
});

test('auto pause cancels the old target and pauses the new one during rapid navigation', async t => {
  const { document, client } = autoSetup(t, '<div class="slides-item"><video></video></div>');
  const oldVideo = document.querySelector('video');
  const oldState = mediaState(oldVideo);
  client.startAutoPause();
  await waitFor(() => oldState.paused && client.pausePromise);
  document.body.innerHTML = '<div class="slides-item"><video></video></div>';
  const newState = mediaState(document.querySelector('video'));
  await waitFor(() => newState.paused && !client.pausePromise);
  assert.equal(oldState.calls, 1);
  assert.equal(newState.calls, 1);
});

test('author list pages do not auto pause previews', async t => {
  const { document, client } = autoSetup(t, '<video></video>', 'profile');
  const state = mediaState(document.querySelector('video'));
  client.startAutoPause();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.calls, 0);
});

test('pause action bypasses the generic DOM operator', async () => {
  const { document, window, run } = setup('<video></video>');
  const state = mediaState(document.querySelector('video'));
  window.__wx_dom_operator__ = { execute: () => assert.fail('wrong pause implementation') };
  assert.equal((await run()).success, true);
  assert.equal(state.paused, true);
});

test('initially paused audio that autoplays during confirmation must be paused', async () => {
  let state;
  let started = false;
  const { document, run } = setup(slide('<audio></audio>', playLabel), (delay, document) => {
    if (delay !== 200 || started) return;
    started = true;
    state.paused = false;
    const button = document.querySelector('button');
    button.setAttribute('aria-label', pauseLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-pause');
  });
  state = mediaState(document.querySelector('audio'), true);
  const button = document.querySelector('button');
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    state.paused = true;
    button.setAttribute('aria-label', playLabel);
    button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
  };
  const result = await run();
  assert.equal(result.byMethod, 'button_click');
  assert.equal(clicks, 1);
  assert.equal(state.paused, true);
  assert.equal(result.diagnostics.version, 'pause-v5-no-toggle');
});

test('unloaded media is not reported as already paused', async () => {
  const { document, run } = setup('<video></video>');
  const video = document.querySelector('video');
  mediaState(video, true);
  Object.defineProperty(video, 'readyState', { get: () => 0 });
  const result = await run();
  assert.equal(result.success, false);
  assert.equal(result.diagnostics.media[0].readyState, 0);
});

test('media that resumes after a pause is not reported as successfully stopped', async () => {
  let state;
  const { document, run } = setup('<video></video>', delay => {
    if (delay === 200) state.paused = false;
  });
  state = mediaState(document.querySelector('video'));
  assert.equal((await run()).success, false);
});

if (process.env.PAUSE_DOM_FIXTURE) {
  test('provided DOM: image post control pauses audio without touching the next post', async () => {
    const { document, run } = setup(fs.readFileSync(process.env.PAUSE_DOM_FIXTURE, 'utf8'));
    const slides = [...document.querySelectorAll('.slides-item')];
    slides.slice(1).forEach(element => element.setAttribute('data-offscreen', ''));
    assert.equal(document.querySelectorAll('video').length, 0);
    const audio = slides[0].querySelector('audio');
    const state = mediaState(audio);
    const button = slides[0].querySelector(`button[aria-label="${pauseLabel}"]`);
    let clicks = 0;
    button.onclick = () => {
      clicks++;
      state.paused = true;
      button.setAttribute('aria-label', playLabel);
      button.querySelector('svg').setAttribute('ml-key', 'flow-video-play');
    };
    assert.equal((await run()).success, true);
    assert.equal(clicks, 1);
    assert.equal(state.paused, true);
  });
}

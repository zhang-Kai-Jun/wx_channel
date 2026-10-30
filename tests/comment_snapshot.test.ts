import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../internal/assets/inject/api_client.js', import.meta.url), 'utf8');
const start = source.indexOf('  commentPageInstance: function');
const end = source.indexOf('  sendClientState:', start);
const methodsStart = source.indexOf('  startCommentSnapshot: function');
const methodsEnd = source.indexOf('  // 处理 API 调用请求', methodsStart);
function setup() {
  const timers = new Map<number, () => void>();
  const callbacks: any[] = [];
  let starts = 0, stopped = 0;
  const window: any = { location:{ href:'https://channels.weixin.qq.com/web/pages/feed?oid=a', pathname:'/web/pages/feed' },
    __start_feed_comment_collection_with_open_panel(task: any) {
      starts++;
      timers.set(starts, () => {});
      task.timers.push(starts);
    }, __stop_feed_comment_collection() { stopped++; } };
  const sandbox = vm.createContext({ window, navigator:{ userAgent:'test' }, document:{ hidden:false },
    clearInterval:(id:number) => timers.delete(id), clearTimeout:(id:number) => timers.delete(id),
    fetch:async (_url:string, init:any) => { callbacks.push(JSON.parse(init.body)); return {}; } });
  const client = vm.runInContext('({' + source.slice(start,end) + source.slice(methodsStart,methodsEnd) + '})', sandbox);
  window.__wx_api_client = client;
  return { client, window, timers, callbacks, sandbox, get starts() { return starts; }, get stopped() { return stopped; } };
}

const capture = fs.readFileSync(new URL('../internal/handlers/script.go',import.meta.url),'utf8');
const managedStart = capture.indexOf('    window.__stop_feed_comment_collection = function');
const managedEnd = capture.indexOf('\n})();',managedStart);
const statsStart = capture.indexOf('\tfunction getCommentStats(items)');
const statsEnd = capture.indexOf('// 校验二级评论展开情况',statsStart);

for (const mode of ['count', 'unknown_empty_cursor', 'cursor_drained', 'missing_replies', 'no_more', 'no_more_missing_replies', 'no_more_reply_loading', 'no_more_fetching', 'fetching_no_growth', 'fetching_timeout', 'timeout', 'ten_minute_budget', 'retry_budget', 'initialization_cancel', 'initialization_failed', 'page_changed'] as const) {
  test(`真实快照加载循环：${mode}`, () => {
    const f = setup();
    let now = 0, nextTimer = 100;
    const saved: any[] = [];
    const items: any[] = [{ commentId:'one', levelTwoComment:[], expandCommentCount:mode === 'missing_replies' || mode === 'no_more_missing_replies' ? 2 : 0, isReplyLoading:mode === 'no_more_reply_loading' }];
    if (mode === 'no_more') {
      for (let index = 1; index < 588; index++) items.push({ commentId:`comment-${index}`, levelTwoComment:[] });
      items[0].levelTwoComment = Array.from({ length:112 }, (_, index) => ({ commentId:`reply-${index}` }));
      items[0].expandCommentCount = 112;
    }
    const home = { flowCommentList:{ dataList:{ items, noMore:mode.startsWith('no_more'), fetching:mode === 'no_more_fetching' || mode === 'fetching_timeout', buffers:{ nextBuffer:mode === 'cursor_drained' ? 'cursor' : '' } } } };
    const payload = { items, total:mode === 'no_more' ? 704 : ['count', 'missing_replies', 'no_more_fetching'].includes(mode) ? 1 : 100, nextBuffer:home.flowCommentList.dataList.buffers.nextBuffer, home };
    const found = { store:{}, home };
    Object.assign(f.sandbox, {
      autoScrollTimer:null, saveDebounceTimer:null, lastProgressText:'', Date:class extends Date { static now() { return now; } },
      document:{ querySelector:() => null, querySelectorAll:() => [] }, console:{ log() {}, warn() {}, error() {} }, __wx_log() {},
      findFlowCommentListInStores:() => found,
      extractStoreComments:() => mode.startsWith('initialization_') ? null : payload,
      findFeedStore:() => ({}), extractCommentPayloadFromDOM:() => null, extractCommentPayload:() => null,
      tryTriggerStoreLoadMore() {}, updateProgressHint() {}, formatComments:() => [], saveComments() {},
      expandSecondaryComments() {}, scrollCommentList:() => true, verifyCommentAllExpanded() {},
      setInterval(callback:() => void) { const id = nextTimer++; f.timers.set(id,callback); return id; },
    });
    f.window.__wx_channels_store__ = { profile:{ id:'a' } };
    delete f.window.__start_feed_comment_collection_with_open_panel;
    f.window.dumpAllPiniaStores = (options:any) => { saved.push(options); return Promise.resolve('saved.json'); };
    vm.runInContext(capture.slice(statsStart,statsEnd) + capture.slice(managedStart,managedEnd),f.sandbox);
    f.client.startCommentSnapshot(body);
    if (mode === 'retry_budget') {
      now = 590000;
      f.client.stopCommentSnapshot('one');
      f.client.startCommentSnapshot({ ...body, task_id:'retry' });
      now = 600000;
    }
    assert.equal(f.window.__sph_snapshot.stopped,false,'初次读取不能立即把空游标视为完整');
    const tick = (steps = 1) => {
      for (let step = 0; step < steps && !f.window.__sph_snapshot.stopped; step++) {
        for (const callback of [...f.timers.values()]) callback();
      }
    };
    if (mode === 'fetching_no_growth') {
      tick(10);
      assert.equal(f.window.__sph_snapshot.stopped,false);
      home.flowCommentList.dataList.fetching = true;
      tick(25);
      assert.equal(f.window.__sph_snapshot.stopped,false,'请求中不能因连续无增长提前停止');
      home.flowCommentList.dataList.fetching = false;
      tick(10);
      assert.equal(f.window.__sph_snapshot.stopped,false,'请求结束后重新累计无增长，不能沿用请求前的计数');
      tick();
      assert.equal(saved.length,1);
      assert.equal(saved[0].reason,'no_growth');
      assert.equal(saved[0].complete,false);
      assert.equal(f.timers.size,0);
      return;
    }
    if (mode === 'no_more_fetching' || mode === 'no_more_reply_loading') {
      tick(25);
      assert.equal(f.window.__sph_snapshot.stopped,false,'主评论或回复请求中不能完成，也不能因无增长停止');
      home.flowCommentList.dataList.fetching = false;
      items[0].isReplyLoading = false;
      tick();
      assert.equal(f.window.__sph_snapshot.stopped,false,'请求结束后需连续两次确认完整');
    }
    if (mode === 'fetching_timeout') now = 600000;
    if (mode === 'initialization_cancel') {
      f.client.stopCommentSnapshot('one'); assert.equal(f.timers.size,0); return;
    }
    if (mode === 'cursor_drained') { payload.nextBuffer = ''; home.flowCommentList.dataList.buffers.nextBuffer = ''; }
    if (mode === 'timeout') now = 601000;
    if (mode === 'ten_minute_budget') {
      for (const elapsed of [241000, 599999]) {
        now = elapsed;
        items.push({ commentId:'new-' + elapsed, levelTwoComment:[] });
        for (const callback of [...f.timers.values()]) callback();
        assert.equal(f.window.__sph_snapshot.stopped,false,'有增长时超过四分钟仍可继续，十分钟之前不应超时');
      }
      now = 600000;
    }
    if (mode === 'page_changed') f.window.__wx_channels_store__.profile.id = 'b';
    for (let step=0;step<25 && !f.window.__sph_snapshot.stopped;step++) {
      for (const callback of [...f.timers.values()]) callback();
    }
    assert.equal(f.window.__sph_snapshot.stopped,true);
    assert.equal(f.timers.size,0);
    if (mode === 'initialization_failed' || mode === 'page_changed') {
      assert.equal(f.callbacks[0].stop_reason,mode); assert.equal(saved.length,0);
    } else {
      assert.equal(saved.length,1);
      const complete = ['count', 'cursor_drained', 'no_more', 'no_more_fetching', 'no_more_reply_loading'].includes(mode);
      assert.equal(saved[0].complete,complete);
      assert.equal(saved[0].reason,['timeout', 'ten_minute_budget', 'retry_budget', 'fetching_timeout'].includes(mode) ? 'timeout' : complete ? 'completed' : 'no_growth');
    }
  });
}
const body = { task_id:'one', collection_id:'collection' };

test('采集中只读增量包含新回复，同编号重放且不驱动滚动', () => {
  const f = setup();
  f.client.startCommentSnapshot(body);
  const items: any[] = [{ commentId:'a', content:'首条', levelTwoComment:[{ commentId:'b', content:'回复' }] }];
  f.window.__sph_findFlowCommentListInStores = () => ({ flowCommentList:{ dataList:{ items }, feed:{ id:'a' } } });
  assert.equal(typeof f.client.readCommentSnapshot, 'function', '需要采集中读取数据的接口');
  const req = { ...body, task_id:'read-1' };
  const first = f.client.readCommentSnapshot(req);
  assert.equal(first.raw_items.length,2);
  assert.equal(first.raw_items[1].parentCommentId,'a');
  items[0].levelTwoComment.push({ commentId:'c', content:'新回复' });
  assert.equal(f.client.readCommentSnapshot(req),first,'响应丢失后重查同一编号不能丢掉上一批');
  const next = f.client.readCommentSnapshot({ ...req, task_id:'read-2' });
  assert.equal(next.raw_items.length,1);
  assert.equal(next.raw_items[0].commentId,'c');
  f.client.stopCommentSnapshot('one');
  items.push({ commentId:'late', content:'最后一批' });
  assert.equal(f.client.readCommentSnapshot({ ...req, task_id:'read-3' }).raw_items[0].commentId,'late','停止后仍能读取末批');
  assert.equal(f.client.readCommentSnapshot({ ...req, collection_id:'wrong' }).success,false);
  assert.equal(f.starts,1,'只读接口不得启动第二套采集');
});

test('实际 home Store 根节点使用同一 flow 判断请求及完整性', () => {
  const f = setup();
  const extractStart = capture.indexOf('\tfunction extractStoreComments(found)');
  const extractEnd = capture.indexOf('\n\t// 格式化评论数据', extractStart);
  const helpersStart = capture.indexOf('    function snapshotRequestsPending(payload)');
  const helpersEnd = capture.indexOf('\n\t// 暴露手动启动函数', helpersStart);
  Object.assign(f.sandbox, { document:{ querySelectorAll:() => [] } });
  vm.runInContext(capture.slice(extractStart, extractEnd) + capture.slice(helpersStart, helpersEnd), f.sandbox);
  const flow = { commentCount:708, dataList:{ items:[{ commentId:'a' }], noMore:true, fetching:false } };
  const payload = f.sandbox.extractStoreComments({ store:{ flowCommentList:flow }, flowCommentList:flow });
  const task = {};
  assert.equal(f.sandbox.snapshotFullyLoaded(payload, { total:704, missingReplies:0 }, task),false);
  assert.equal(f.sandbox.snapshotFullyLoaded(payload, { total:704, missingReplies:0 }, task),true);
  flow.dataList.fetching = true;
  assert.equal(f.sandbox.snapshotRequestsPending(payload),true);
  assert.equal(f.sandbox.snapshotFullyLoaded(payload, { total:704, missingReplies:0 }, task),false);
});

// 回放真实滚动、回复展开和快照循环；JSDOM 不提供布局，按节点样式补充可见性与尺寸。
function domSnapshot(html: string, pending: 'none' | 'main' | 'reply' = 'none') {
  const f = setup();
  const dom = new JSDOM(`<div class="comment-panel"><div class="comment-list">${html}</div></div>`);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    get() {
      for (let node: any = this; node; node = node.parentElement) {
        if (node.hidden || dom.window.getComputedStyle(node).display === 'none') return null;
      }
      return this.parentElement;
    },
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  const panel = dom.window.document.querySelector('.comment-list')!;
  let scrolls = 0, loads = 0, clicks = 0, now = 0, nextTimer = 100;
  Object.defineProperties(panel, {
    scrollHeight:{ get:() => 500 }, clientHeight:{ get:() => 200 },
    scrollTop:{ set() { scrolls++; } },
  });
  dom.window.document.addEventListener('click', () => { clicks++; });
  const items = [{ commentId:'one', levelTwoComment:[], isReplyLoading:pending === 'reply' }];
  const home = { flowCommentList:{ dataList:{ items, fetching:pending === 'main', noMore:false } } };
  const payload = { items, home, total:704, nextBuffer:'' };
  Object.assign(f.window, {
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),
    __wx_channels_store__:{ profile:{ id:'a' } },
  });
  Object.assign(f.sandbox, {
    document:dom.window.document, NodeFilter:dom.window.NodeFilter,
    // API 客户端使用轻量 window；DOM 事件的 view 必须属于 JSDOM 的真实 Window。
    MouseEvent:class extends dom.window.MouseEvent {
      constructor(type: string, options: MouseEventInit) { super(type, { ...options, view:dom.window }); }
    },
    Date:class extends Date { static now() { return now; } },
    console:{ log() {}, warn() {}, error() {} }, __wx_log() {},
    autoScrollTimer:null, saveDebounceTimer:null, lastProgressText:'',
    findFlowCommentListInStores:() => ({ store:{}, home }), extractStoreComments:() => payload,
    tryTriggerStoreLoadMore() { loads++; }, updateProgressHint() {}, formatComments:() => [],
    setInterval(callback:() => void) { const id = nextTimer++; f.timers.set(id, callback); return id; },
  });
  const scrollStart = capture.indexOf('\tfunction scrollCommentList()');
  const scrollEnd = capture.indexOf('\n\tfunction initObserver()', scrollStart);
  const expandStart = capture.indexOf('// 尝试展开二级评论');
  const expandEnd = capture.indexOf('// 暴露辅助函数到全局', expandStart);
  vm.runInContext(capture.slice(statsStart, statsEnd) + capture.slice(scrollStart, scrollEnd) +
    capture.slice(expandStart, expandEnd) + capture.slice(managedStart, managedEnd), f.sandbox);
  delete f.window.__start_feed_comment_collection_with_open_panel;
  const saved: any[] = [];
  f.window.dumpAllPiniaStores = (options: any) => { saved.push(options); return Promise.resolve('saved.json'); };
  f.client.startCommentSnapshot(body);
  return { ...f, dom, home, items, saved,
    get scrolls() { return scrolls; }, get loads() { return loads; }, get clicks() { return clicks; },
    advance(ms: number) { now += ms; },
    tick(steps = 1) {
      for (let step = 0; step < steps && !f.window.__sph_snapshot.stopped; step++) {
        for (const callback of [...f.timers.values()]) callback();
      }
    },
  };
}

const hiddenLoaders = [
  '<span class="loading-icon" style="display:none"></span>',
  '<span class="loading-icon" style="visibility:hidden"></span>',
  '<div hidden><span class="loading-icon"></span></div>',
  '<div aria-hidden="true"><span class="loading-icon"></span></div>',
  '<div inert><span class="loading-icon"></span></div>',
];
for (const html of hiddenLoaders) {
  test(`隐藏加载提示不阻止滚动和加载结束：${html}`, () => {
    const f = domSnapshot(html);
    try {
      f.tick(5);
      assert.equal(f.scrolls,5,'隐藏提示不能吞掉滚动');
      assert.ok(f.loads > 1,'没有实际请求时继续主动加载');
      f.home.flowCommentList.dataList.noMore = true;
      f.tick();
      assert.equal(f.window.__sph_snapshot.stopped,false,'仍需连续两次确认完整');
      f.tick();
      assert.equal(f.saved[0].complete,true,'隐藏提示不能阻止 noMore 正常完成');
    } finally { f.dom.window.close(); }
  });
}

test('隐藏图标之后仍有可见加载提示时不能误判完成，但继续滚动', () => {
  const f = domSnapshot(hiddenLoaders[0] + '<span class="loading-icon" id="visible"></span>');
  try {
    f.home.flowCommentList.dataList.noMore = true;
    f.tick(5);
    assert.equal(f.window.__sph_snapshot.stopped,false,'必须检查所有提示，不能只取第一个隐藏节点');
    assert.equal(f.scrolls,5,'可见加载提示只阻止完整性确认');
    f.dom.window.document.querySelector('#visible')!.remove();
    f.tick(2);
    assert.equal(f.saved[0].complete,true);
  } finally { f.dom.window.close(); }
});

test('仅有可见加载提示而没有真实请求时，仍可按无增长结束', () => {
  const f = domSnapshot('<span class="loading-icon"></span>');
  try {
    f.tick(11);
    assert.ok(f.scrolls > 0);
    assert.equal(f.saved[0].reason,'no_growth','DOM 提示不能无限重置无增长计数');
    assert.equal(f.saved[0].complete,false);
  } finally { f.dom.window.close(); }
});

for (const pending of ['main', 'reply'] as const) {
  test(`实际 ${pending} 请求中继续滚动和展开其他回复，不重复主动加载`, () => {
    const f = domSnapshot('<div class="comment-item__extra"><button class="load-more__btn">1条回复</button></div>', pending);
    try {
      f.tick(25);
      assert.equal(f.window.__sph_snapshot.stopped,false,'真实请求中不因无增长提前停止');
      assert.equal(f.scrolls,25,'真实请求不能吞掉整个采集循环');
      assert.equal(f.clicks,1,'仍可展开其他可操作回复，既有去重防止重复点击');
      assert.equal(f.loads,0,'请求中包括启动阶段都不主动重复调用 Store 加载');
      f.home.flowCommentList.dataList.fetching = false;
      f.items[0].isReplyLoading = false;
      f.dom.window.document.querySelector('.load-more__btn')!.remove();
      f.home.flowCommentList.dataList.noMore = true;
      f.tick(2);
      assert.equal(f.saved[0].complete,true,'请求结束后正常确认完成');
      assert.equal(f.timers.size,0);
    } finally { f.dom.window.close(); }
  });
}

test('持续请求中仍滚动，但十分钟截止后清理循环并返回不完整', () => {
  const f = domSnapshot('', 'main');
  try {
    f.tick(25);
    assert.equal(f.scrolls,25);
    f.advance(600000);
    f.tick();
    assert.equal(f.saved[0].reason,'timeout');
    assert.equal(f.saved[0].complete,false);
    assert.equal(f.timers.size,0);
  } finally { f.dom.window.close(); }
});

test('快照同编号重复启动只创建一个循环，页面实例保持稳定', () => {
  const f = setup();
  assert.equal(f.client.startCommentSnapshot(body).success,true);
  assert.equal(f.client.startCommentSnapshot(body).success,true);
  assert.equal(f.starts,1);
  assert.equal(f.client.commentPageInstance(),f.client.commentPageInstance());
});
test('错误编号取消不影响当前任务，正确取消清除所有初始化和采集定时器', () => {
  const f = setup(); f.client.startCommentSnapshot(body);
  assert.equal(f.client.stopCommentSnapshot('other').success,false);
  assert.equal(f.timers.size,1); assert.equal(f.stopped,0);
  assert.equal(f.client.stopCommentSnapshot('one').stopped,true);
  assert.equal(f.timers.size,0); assert.equal(f.callbacks[0].stop_reason,'cancelled');
});
test('取消后迟到的保存成功不得覆盖取消结果', () => {
  const f = setup(); f.client.startCommentSnapshot(body);
  const task = f.window.__sph_snapshot;
  f.client.stopCommentSnapshot('one');
  f.client.sendSnapshotStatus(task,{ done:true, success:true, stopped:true, complete:true });
  assert.ok(f.callbacks.every((row:any) => row.success === false && row.stop_reason === 'cancelled'));
});
test('保存期间停止立即确认，旧保存的回调仍属于原任务', () => {
  const f = setup(); f.client.startCommentSnapshot(body);
  f.window.dumpAllPiniaStores = () => new Promise(() => {});
  const first = f.window.__sph_snapshot;
  first.finish('completed',true);
  assert.equal(f.client.stopCommentSnapshot('one').stopped,true);
  f.client.startCommentSnapshot({ task_id:'two', collection_id:'next' });
  f.client.sendSnapshotStatus(first,{ done:true, success:true });
  assert.equal(f.callbacks.at(-1).task_id,'one');
  assert.equal(f.callbacks.at(-1).stop_reason,'cancelled');
});
test('初始化功能不存在时明确返回失败终态', () => {
  const f = setup(); delete f.window.__start_feed_comment_collection_with_open_panel;
  f.client.startCommentSnapshot(body);
  assert.equal(f.callbacks[0].stop_reason,'initialization_failed');
  assert.equal(f.callbacks[0].stopped,true);
});

const feed = fs.readFileSync(new URL('../internal/assets/inject/feed.js', import.meta.url),'utf8');
const dumpStart = feed.indexOf('function dumpAllPiniaStores(');
const dumpEnd = feed.indexOf('// ============================================================',dumpStart);
for (const complete of [false,true]) {
  test(`快照文件保存后正确返回完整性和一级二级计数：${complete}`, async () => {
    const f = setup(); f.client.startCommentSnapshot(body);
    const task = f.window.__sph_snapshot;
    const store = { $state:{ flowCommentList:{ commentCount:100, dataList:{ items:[{ commentId:'a', levelTwoComment:[{ commentId:'b' }] }] } } } };
    const app = { __vue__:{ appContext:{ config:{ globalProperties:{ $pinia:{ _s:new Map([['home',store]]) } } } } } };
    const sandbox = vm.createContext({ window:f.window, location:f.window.location, document:{ querySelector:() => app },
      console:{ log() {}, warn() {}, error() {} }, __wx_log() {}, AbortSignal,
      fetch:async () => ({ ok:true, json:async () => ({ path:'saved.json' }) }) });
    vm.runInContext(feed.slice(dumpStart,dumpEnd),sandbox);
    await sandbox.dumpAllPiniaStores({ task, reason:complete ? 'completed' : 'no_growth', complete });
    assert.equal(f.callbacks[0].success,complete);
    assert.equal(f.callbacks[0].complete,complete);
    assert.equal(f.callbacks[0].loaded_count,2);
    assert.equal(f.callbacks[0].total_count,100);
  });
}

for (const mode of ['empty_path', 'http_error', 'network', 'recover', 'cancel', 'page_changed'] as const) {
  test(`保存失败只重发冻结快照且保留采集停止原因：${mode}`, async () => {
    const f = setup(); f.client.startCommentSnapshot(body);
    const task = f.window.__sph_snapshot;
    const state = { flowCommentList:{ commentCount:100, dataList:{ items:[{ commentId:'a', levelTwoComment:[] }] } } };
    const app = { __vue__:{ appContext:{ config:{ globalProperties:{ $pinia:{ _s:new Map([['home',{ $state:state }]]) } } } } } };
    const requests: string[] = [], messages: string[] = [];
    const sandbox = vm.createContext({ window:f.window, location:f.window.location, document:{ querySelector:() => app },
      AbortSignal, setTimeout:(fn:() => void) => { fn(); return 0; },
      console:{ log() {}, warn() {}, error() {} }, __wx_log:(data:any) => messages.push(data.msg),
      fetch:async (_url:string, init:any) => {
        requests.push(init.body);
        state.flowCommentList.dataList.items.push({ commentId:'late', levelTwoComment:[] });
        if (mode === 'cancel') f.client.stopCommentSnapshot('one');
        if (mode === 'page_changed') f.window.location.href += '&changed=1';
        if (mode === 'network') throw new Error('network failed');
        return { ok:mode !== 'http_error', status:503,
          json:async () => mode === 'recover' && requests.length === 2 ? { path:'saved.json' } : { error:'disk unavailable' } };
      },
    });
    vm.runInContext(feed.slice(dumpStart,dumpEnd),sandbox);
    const path = await sandbox.dumpAllPiniaStores({ task, reason:'timeout', complete:false });
    assert.equal(f.starts,1,'保存失败不得重新采集');
    assert.equal(requests.length,mode === 'recover' ? 2 : ['cancel','page_changed'].includes(mode) ? 1 : 3);
    assert.ok(requests.every(request => request === requests[0]),'重试保存必须使用同一份停止时数据');
    assert.equal(path,mode === 'recover' ? 'saved.json' : '');
    if (mode === 'cancel') assert.equal(f.callbacks.at(-1).stop_reason,'cancelled');
    else {
      assert.equal(f.callbacks.at(-1).stop_reason,'timeout','保存失败不能覆盖十分钟超时原因');
      assert.equal(f.callbacks.at(-1).loaded_count,1);
      if (mode !== 'recover') assert.ok(f.callbacks.at(-1).error,'具体保存错误必须返回给技能');
    }
    if (mode !== 'recover') assert.ok(messages.every(message => !message.includes('✅')),'未取到路径不可记录保存成功');
  });
}

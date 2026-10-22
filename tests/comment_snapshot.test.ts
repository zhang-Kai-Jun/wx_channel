import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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

for (const mode of ['count', 'unknown_empty_cursor', 'cursor_drained', 'missing_replies', 'timeout', 'initialization_cancel', 'initialization_failed', 'page_changed'] as const) {
  test(`真实快照加载循环：${mode}`, () => {
    const f = setup();
    let now = 0, nextTimer = 100;
    const saved: any[] = [];
    const items: any[] = [{ commentId:'one', levelTwoComment:[], expandCommentCount:mode === 'missing_replies' ? 2 : 0 }];
    const home = { flowCommentList:{ dataList:{ items, buffers:{ nextBuffer:mode === 'cursor_drained' ? 'cursor' : '' } } } };
    const payload = { items, total:mode === 'count' || mode === 'missing_replies' ? 1 : 100, nextBuffer:home.flowCommentList.dataList.buffers.nextBuffer, home };
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
    assert.equal(f.window.__sph_snapshot.stopped,false,'初次读取不能立即把空游标视为完整');
    if (mode === 'initialization_cancel') {
      f.client.stopCommentSnapshot('one'); assert.equal(f.timers.size,0); return;
    }
    if (mode === 'cursor_drained') { payload.nextBuffer = ''; home.flowCommentList.dataList.buffers.nextBuffer = ''; }
    if (mode === 'timeout') now = 241000;
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
      assert.equal(saved[0].complete,mode === 'count' || mode === 'cursor_drained');
      assert.equal(saved[0].reason,mode === 'timeout' ? 'timeout' : mode === 'count' || mode === 'cursor_drained' ? 'completed' : 'no_growth');
    }
  });
}
const body = { task_id:'one', collection_id:'collection' };

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
      console:{ log() {}, warn() {}, error() {} }, __wx_log() {}, fetch:async () => ({ json:async () => ({ path:'saved.json' }) }) });
    vm.runInContext(feed.slice(dumpStart,dumpEnd),sandbox);
    await sandbox.dumpAllPiniaStores({ task, reason:complete ? 'completed' : 'no_growth', complete });
    assert.equal(f.callbacks[0].success,complete);
    assert.equal(f.callbacks[0].complete,complete);
    assert.equal(f.callbacks[0].loaded_count,2);
    assert.equal(f.callbacks[0].total_count,100);
  });
}

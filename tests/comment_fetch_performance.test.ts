import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../internal/handlers/script.go', import.meta.url), 'utf8');
const start = script.indexOf('func (h *ScriptHandler) getFetchVideoCommentsScript() string {');
const injected = script.slice(start).split('<script>')[1].split('</script>')[0];
const api = fs.readFileSync(new URL('../internal/assets/inject/api_client.js', import.meta.url), 'utf8');
const apiStart = api.indexOf("if (body.action === 'fetch_video_comments') {");
const apiEnd = api.indexOf('\n        var fvcTimeout;', apiStart);
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const invokeAPI = new AsyncFunction('window', 'document', 'body', 'resp', 'self', 'setTimeout', 'id',
  'var fvcTimeout;\n' + api.slice(apiStart, apiEnd));

function fixture(initial: string[] = []) {
  let items = initial.map(commentId => ({ commentId }));
  const found = { store: {}, home: { feed: { awemeId: 'video-a' } } };
  let loads = 0;
  const window: any = {
    location: { href: 'https://channels.weixin.qq.com/web/pages/feed' },
    __wx_channels_store__: { profile: { id: 'video-a' } },
    __sph_findFlowCommentListInStores: () => found,
    __sph_extractStoreComments: () => ({ items, total: 20, currentTotalCount: items.length, nextBuffer: 'next' }),
    __sph_tryTriggerStoreLoadMore() { loads++; },
  };
  const document = { querySelector: () => ({ offsetParent: {} }), querySelectorAll: () => [] };
  vm.runInNewContext(injected, { window, document, setTimeout, clearTimeout, Date, Promise });
  return { window, document, found, loads: () => loads,
    append(id: string) { items = [...items, { commentId: id }]; } };
}

test('首次等待让出主线程，能收到异步到达的评论', async () => {
  const f = fixture();
  let callbackRan = false;
  setTimeout(() => { callbackRan = true; f.append('first'); }, 20);
  const result = await f.window.__sph_fetch_video_comments({});
  assert.equal(callbackRan, true, '等待评论时，页面网络及定时器回调必须能执行');
  assert.equal(result.panel_ready, true);
  assert.equal(result.raw_items[0].commentId, 'first');
});

test('加载更多的异步响应在本批次被第二次读取捕获', async () => {
  const f = fixture(['first']);
  f.window.__sph_tryTriggerStoreLoadMore = () => setTimeout(() => f.append('second'), 20);
  const result = await f.window.__sph_fetch_video_comments({});
  assert.deepEqual(Array.from(result.raw_items, (item: any) => item.commentId), ['first', 'second']);
});

test('等待期间停止采集，不触发加载或消耗评论增量', async () => {
  const f = fixture();
  f.window.__sph_cancelled_collections = new Set();
  setTimeout(() => { f.window.__sph_cancelled_collections.add('collection'); f.append('first'); }, 20);
  const result = await f.window.__sph_fetch_video_comments({ collection_id: 'collection' });
  assert.equal(result.reason, 'cancelled');
  assert.equal(f.loads(), 0);
  assert.equal(f.window.__sph_fetch_state, undefined);
});

test('加载更多等待期间切换作品，不污染增量状态', async () => {
  const f = fixture(['first']);
  f.window.__sph_tryTriggerStoreLoadMore = () => setTimeout(() => {
    f.window.__wx_channels_store__.profile.id = 'video-b'; f.append('other-video');
  }, 20);
  const result = await f.window.__sph_fetch_video_comments({});
  assert.equal(result.reason, 'page_changed');
  assert.equal(f.window.__sph_fetch_state?.seenL1['other-video'], undefined);
});

test('并发批次按序执行，同一条评论只计入一个批次', async () => {
  const f = fixture(['first']);
  let loads = 0;
  f.window.__sph_tryTriggerStoreLoadMore = () => {
    if (++loads === 1) setTimeout(() => f.append('second'), 20);
  };
  const results = await Promise.all([
    f.window.__sph_fetch_video_comments({}), f.window.__sph_fetch_video_comments({}),
  ]);
  assert.deepEqual(results.map(r => Array.from(r.raw_items, (item: any) => item.commentId)), [['first', 'second'], []]);
});

test('API 等待异步采集完成，并发重放仍只执行一次', async () => {
  let reads = 0;
  const window = { async __sph_fetch_video_comments() {
    reads++; await new Promise(resolve => setTimeout(resolve, 20)); return { raw_items: [{ commentId: 'first' }] };
  } };
  const responses: any[] = [];
  const invoke = () => invokeAPI(window, { querySelectorAll: () => [] },
    { action: 'fetch_video_comments', task_id: 'task', collection_id: 'collection' },
    (r: any) => responses.push(r), { sendFetchCommentsCallback() {} }, setTimeout, 'request');
  await Promise.all([invoke(), invoke()]);
  assert.equal(reads, 1);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0].result.raw_items, [{ commentId: 'first' }]);
  assert.deepEqual(responses[0], responses[1]);
});

test('等待加载更多期间停止，下一批仍可取得未交付的评论', async () => {
  const f = fixture(['first']);
  f.window.__sph_cancelled_collections = new Set();
  f.window.__sph_tryTriggerStoreLoadMore = () => {
    setTimeout(() => f.window.__sph_cancelled_collections.add('stopped'), 20);
  };
  const result = await f.window.__sph_fetch_video_comments({ collection_id: 'stopped' });
  assert.equal(result.reason, 'cancelled');
  assert.equal(f.window.__sph_fetch_state, undefined);
  const next = await f.window.__sph_fetch_video_comments({ collection_id: 'next' });
  assert.equal(next.raw_items[0].commentId, 'first');
});

test('读取异常释放队列，后续请求仍能执行', async () => {
  const f = fixture(['first']);
  const read = f.window.__sph_extractStoreComments;
  let shouldThrow = true;
  f.window.__sph_extractStoreComments = () => {
    if (shouldThrow) { shouldThrow = false; throw new Error('read failed'); }
    return read();
  };
  const results = await Promise.allSettled([
    f.window.__sph_fetch_video_comments({}), f.window.__sph_fetch_video_comments({}),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
});

test('旧 cmd 入口也等待采集完成后再回调', async () => {
  const legacyStart = api.indexOf("if (data.action === 'fetch_video_comments') {");
  const legacyEnd = api.indexOf("\n      if (data.action === 'watch_video')", legacyStart);
  const runLegacy = new AsyncFunction('window', 'data', 'console', api.slice(legacyStart, legacyEnd));
  const responses: any[] = [];
  const window = {
    __sph_fetch_video_comments: async () => { await new Promise(r => setTimeout(r, 20)); return { comment_count: 1 }; },
    __wx_api_client: { sendFetchCommentsCallback: (_id: string, r: any) => responses.push(r) },
  };
  await runLegacy(window, { action: 'fetch_video_comments', task_id: 'legacy' }, { log() {}, error() {} });
  assert.equal(responses[0].result.comment_count, 1);
});

test('采集日志关联请求及阶段耗时，日志异常不影响评论返回', async () => {
  const f = fixture(['first']);
  let record: any;
  f.window.__sph_perf_log = (kind: string, fields: any) => {
    assert.equal(kind, 'comment_fetch'); record = fields; throw new Error('log unavailable');
  };
  const result = await f.window.__sph_fetch_video_comments({ request_id: 'request', task_id: 'task' });
  assert.equal(result.comment_count, 1);
  assert.equal(record.request_id, 'request');
  assert.equal(record.task_id, 'task');
  assert.ok(record.loadmore_wait_ms >= 250);
  assert.ok(record.store_reads >= 2);
  assert.equal(typeof record.sync_ms, 'number');
});

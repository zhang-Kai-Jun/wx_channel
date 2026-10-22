const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../internal/assets/inject/api_client.js'), 'utf8');
const start = source.indexOf("if (body.action === 'fetch_video_comments') {");
const end = source.indexOf('\n        var fvcTimeout;', start);
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const run = new AsyncFunction('window', 'document', 'body', 'resp', 'self', 'setTimeout', 'id', 'var fvcTimeout;\n' + source.slice(start, end));

test('原请求重放返回相同增量，不重复滚动或读取', async () => {
  let reads = 0;
  const window = { __sph_fetch_video_comments() { return { panel_ready:true, raw_items:[{ id:++reads }] }; } };
  const document = { querySelectorAll: () => [] };
  const results = [];
  const invoke = id => run(window, document, { action:'fetch_video_comments', task_id:id, collection_id:'collection' }, r => results.push(r), { sendFetchCommentsCallback() {} });
  await Promise.all([invoke('same'), invoke('same')]);
  await invoke('same');
  assert.equal(reads, 1);
  assert.deepEqual(results.map(r => r.result.raw_items[0].id), [1,1,1]);
  await invoke('next');
  assert.equal(reads, 2);
});

test('原请求尚在等待时重放，共用执行并接收迟到结果', async () => {
  let resume, reads = 0;
  const window = {};
  const results = [];
  const invoke = () => run(window, { querySelectorAll: () => [] },
    { action:'fetch_video_comments', task_id:'pending', collection_id:'collection' },
    r => results.push(r), { sendFetchCommentsCallback() {} }, r => { resume = r; });
  const first = invoke();
  const second = invoke();
  window.__sph_fetch_video_comments = () => ({ raw_items:[{ id:++reads }] });
  resume();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], results[1]);
});

test('其他采集任务保持原来的执行方式', async () => {
  let reads = 0;
  const window = { __sph_fetch_video_comments: () => ({ comment_count:++reads }) };
  for (let i = 0; i < 2; i++) await run(window, { querySelectorAll: () => [] },
    { action:'fetch_video_comments', task_id:'legacy' }, () => {}, { sendFetchCommentsCallback() {} });
  assert.equal(reads, 2);
});

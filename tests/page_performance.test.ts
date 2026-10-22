import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const file = new URL('../internal/handlers/page_performance.go', import.meta.url);
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const injected = source.split('<script>')[1]?.split('</script>')[0] || '';
  const logs: any[] = [];
  const timers: (() => void)[] = [];
  const navigationTimers: (() => void)[] = [];
  const listeners: Record<string, () => void> = {};
  const observers: any[] = [];
  let now = 0;
  const counts = { nodes: 100, media: 1 };
  const document = { visibilityState: 'visible', readyState: 'loading',
    getElementsByTagName: () => ({ length: counts.nodes }),
    querySelectorAll: () => Array.from({ length: counts.media }, () => ({ paused: true })),
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; } };
  const window: any = { location: { pathname: '/web/pages/feed' },
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; },
    __wx_api_client: { commentPageInstance: () => 'page-1' } };
  const performance: any = { now: () => now,
    memory: { usedJSHeapSize: 1000000, jsHeapSizeLimit: 100000000 },
    getEntriesByType: () => [{ responseEnd: 500, domContentLoadedEventEnd: 800, loadEventEnd: 1000 }] };
  class PerformanceObserver {
    callback: any;
    constructor(callback: any) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const fetch = (_: string, options: any) => { logs.push(JSON.parse(JSON.parse(options.body).msg.slice('[Perf] '.length))); return Promise.resolve({}); };
  vm.runInNewContext(injected, { window, document, performance, PerformanceObserver, URL, AbortController,
    fetch, setTimeout(fn: () => void, delay: number) { if (delay === 1000) timers.push(fn); if (delay === 0) navigationTimers.push(fn); return 1; }, clearTimeout() {} });
  return { window, document, performance, counts, logs, listeners, timers, navigationTimers, observers, advance(ms: number) { now += ms; } };
}

test('卡顿日志记录主线程延迟和可见性，并限流', () => {
  const f = fixture();
  assert.equal(typeof f.window.__sph_perf_log, 'function', '页面需要安装性能诊断器');
  f.advance(3000); f.timers.shift()!();
  const lag = f.logs.find(l => l.event === 'event_loop_lag');
  assert.equal(lag.lag_ms, 2000);
  assert.equal(lag.visibility, 'visible');
  assert.equal(lag.page_instance_id, 'page-1');
  f.advance(3000); f.timers.shift()!();
  assert.equal(f.logs.filter(l => l.event === 'event_loop_lag').length, 1);
});

test('导航与慢资源有独立耗时，资源地址不记录查询参数', async () => {
  const f = fixture();
  assert.ok(f.listeners.load, '需要记录页面 load 阶段');
  f.listeners.load();
  f.navigationTimers.shift()!();
  await Promise.resolve(); await Promise.resolve();
  const nav = f.logs.find(l => l.event === 'navigation');
  assert.equal(nav.response_end_ms, 500);
  assert.equal(nav.load_ms, 1000);
  const observer = f.observers[0];
  observer.callback({ getEntries: () => [{ entryType: 'resource', initiatorType: 'script',
    name: 'https://cdn.example.com/page.js?token=secret', duration: 4500 }] });
  const resource = f.logs.find(l => l.event === 'slow_resource');
  assert.equal(resource.resource, 'https://cdn.example.com/page.js');
  assert.equal(resource.duration_ms, 4500);
});

test('诊断日志上传阻塞时不无限堆积请求，也不向控制台递归写日志', () => {
  const f = fixture();
  assert.equal(typeof f.window.__sph_perf_log, 'function');
  for (let i = 0; i < 100; i++) f.window.__sph_perf_log('api_received', { request_id: String(i) });
  assert.ok(f.logs.length <= 2, '同时最多两条诊断上传，不堆积请求');
});

test('按分钟记录内存、DOM和采集缓存增长，区分越跑越慢的累积来源', async () => {
  const f = fixture();
  f.window.__wx_cached_cards = [1, 2];
  f.window.__wx_channels_search_collector = { feeds: [1, 2, 3] };
  f.window.__sph_fetch_requests = new Map([['first', {}]]);
  f.advance(60000); f.timers.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  const first = f.logs.find(l => l.event === 'page_resources');
  assert.ok(first, '需要定期落下资源基线，才能对比后期增长');
  assert.equal(first.dom_nodes, 100);
  assert.equal(first.js_heap_bytes, 1000000);
  assert.equal(first.cached_cards, 2);
  assert.equal(first.collected_feeds, 3);
  assert.equal(first.fetch_request_cache, 1);
  assert.equal(first.page_age_ms, 60000);
  f.counts.nodes = 500;
  f.performance.memory.usedJSHeapSize = 9000000;
  f.window.__sph_fetch_requests.set('second', {});
  f.advance(60000); f.timers.shift()!();
  const last = f.logs.filter(l => l.event === 'page_resources').at(-1);
  assert.equal(last.dom_nodes, 500);
  assert.equal(last.js_heap_bytes, 9000000);
  assert.equal(last.fetch_request_cache, 2);
  assert.equal(last.page_age_ms, 120000);
});

test('记录后台持续时间和长任务累计耗时，内存接口缺失时仍可诊断', async () => {
  const f = fixture();
  delete f.performance.memory;
  f.document.visibilityState = 'hidden';
  f.listeners.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  f.observers[0].callback({ getEntries: () => [{ entryType: 'longtask', duration: 400, startTime: 100 }] });
  await new Promise(resolve => setImmediate(resolve));
  f.advance(60000); f.timers.shift()!();
  const sample = f.logs.find(l => l.event === 'page_resources');
  assert.ok(sample);
  assert.equal(sample.visibility, 'hidden');
  assert.equal(sample.hidden_for_ms, 60000);
  assert.equal(sample.long_task_count, 1);
  assert.equal(sample.long_task_total_ms, 400);
  assert.equal(sample.js_heap_bytes, null);
  await new Promise(resolve => setImmediate(resolve));
  f.document.visibilityState = 'visible';
  f.listeners.visibilitychange();
  const visibility = f.logs.filter(l => l.event === 'visibility').at(-1);
  assert.equal(visibility.previous_state_ms, 60000);
});

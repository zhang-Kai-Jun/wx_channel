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
  const listeners: Record<string, (event?: any) => void> = {};
  const observers: any[] = [];
  let now = 0;
  const counts = { nodes: 100, media: 1 };
  const document = { visibilityState: 'visible', readyState: 'loading',
    getElementsByTagName: () => ({ length: counts.nodes }),
    querySelectorAll: () => Array.from({ length: counts.media }, () => ({ paused: true })),
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; } };
  const window: any = { location: { pathname: '/web/pages/feed', href: 'https://channels.weixin.qq.com/web/pages/feed' },
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

test('页面异常记录位置和堆栈，地址去掉凭据且不阻止微信原有错误处理', async () => {
  const f = fixture();
  let prevented = false;
  assert.equal(typeof f.listeners.error, 'function');
  f.listeners.error({ message: 'failed https://res.wx.qq.com/app.js?token=secret#x',
    filename: 'https://res.wx.qq.com/app.js?token=secret#x', lineno: 19, colno: 4,
    error: { stack: 'Error at https://res.wx.qq.com/app.js?token=secret#x' },
    preventDefault() { prevented = true; } });
  const error = f.logs.find(l => l.event === 'js_error');
  assert.equal(error.resource, 'https://res.wx.qq.com/app.js');
  assert.equal(error.line, 19);
  assert.equal(error.column, 4);
  assert.ok(error.stack.includes('app.js'));
  assert.ok(!JSON.stringify(error).includes('secret'));
  assert.equal(prevented, false);
  await new Promise(resolve => setImmediate(resolve));
  f.listeners.error({ message: 'repeated' });
  assert.equal(f.logs.filter(l => l.event === 'js_error').length, 1, '相同类型的错误需要限流');
});

test('脚本资源失败与 Promise 异常独立记录，忽略图片和诊断上传错误', async () => {
  const f = fixture();
  assert.equal(typeof f.listeners.error, 'function');
  assert.equal(typeof f.listeners.unhandledrejection, 'function');
  f.listeners.error({ target: { tagName: 'IMG', src: 'https://cdn.example.com/image.png' } });
  f.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://channels.weixin.qq.com/__wx_channels_api/tip' } });
  assert.equal(f.logs.length, 0);
  f.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://res.wx.qq.com/module.js?pass_ticket=secret' } });
  await new Promise(resolve => setImmediate(resolve));
  f.listeners.unhandledrejection({ reason: { message: 'initialization failed', stack: 'x'.repeat(5000) } });
  const resource = f.logs.find(l => l.event === 'resource_error');
  const rejection = f.logs.find(l => l.event === 'unhandled_rejection');
  assert.equal(resource.resource, 'https://res.wx.qq.com/module.js');
  assert.equal(rejection.message, 'initialization failed');
  assert.ok(rejection.stack.length <= 2048);
  assert.doesNotThrow(() => f.listeners.error({ get message() { throw new Error('broken event'); } }));
});

test('导航细分连接、首包和正文阶段，便于定位进入代理回调前的等待', () => {
  const f = fixture();
  f.performance.getEntriesByType = () => [{ redirectStart: 1, redirectEnd: 101,
    domainLookupStart: 101, domainLookupEnd: 111, connectStart: 111, secureConnectionStart: 121,
    connectEnd: 151, requestStart: 160, responseStart: 460, responseEnd: 500,
    domContentLoadedEventEnd: 800, loadEventEnd: 1000 }];
  f.listeners.load();
  f.navigationTimers.shift()!();
  const nav = f.logs.find(l => l.event === 'navigation');
  assert.equal(nav.redirect_ms, 100);
  assert.equal(nav.dns_ms, 10);
  assert.equal(nav.connect_ms, 40);
  assert.equal(nav.tls_ms, 30);
  assert.equal(nav.request_start_ms, 160);
  assert.equal(nav.wait_response_ms, 300);
  assert.equal(nav.download_ms, 40);
});

test('导航日志占满上传通道时保留一条异常，且页面后续改写 fetch 不影响诊断', async () => {
  const f = fixture();
  assert.equal(typeof f.listeners.error, 'function');
  f.window.__sph_perf_log('navigation', {});
  f.window.__sph_perf_log('page_resources', {});
  f.window.fetch = () => { throw new Error('wrapped fetch must not be used'); };
  f.listeners.error({ message: 'early initialization error' });
  assert.equal(f.logs.length, 2, '诊断仍然最多同时上传两条');
  await new Promise(resolve => setImmediate(resolve));
  const error = f.logs.find(l => l.event === 'js_error');
  assert.equal(error.message, 'early initialization error');
  assert.equal(error.resource, '');
});

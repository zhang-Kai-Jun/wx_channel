package handlers

// getPerformanceDiagnosticsScript 用轻量计时区分页面执行、资源加载和后台限速。
// 诊断上传不经过 console 面板，同时限制在途请求，避免日志本身放大卡顿。
func (h *ScriptHandler) getPerformanceDiagnosticsScript() string {
	return `<script>
(function() {
  'use strict';
  if (window.__sph_perf_log) return;
  var inFlight = 0;
  var dropped = 0;
  var lastReports = Object.create(null);
  var lastTick = performance.now();
  var startedAt = lastTick;
  var lastSampleAt = lastTick;
  var visibilitySince = lastTick;
  var previousVisibility = document.visibilityState;
  var hiddenSince = previousVisibility === 'hidden' ? lastTick : null;
  var frozenAt = null;
  var longTaskCount = 0;
  var longTaskTotal = 0;
  var longTaskMax = 0;
  var stopped = false;
  function limited(kind, fields) {
    var now = performance.now();
    if (lastReports[kind] !== undefined && now - lastReports[kind] < 10000) return;
    lastReports[kind] = now;
    window.__sph_perf_log(kind, fields);
  }
  window.__sph_perf_log = function(kind, fields) {
    if (inFlight >= 2 || stopped) { dropped++; return; }
    var controller;
    var timer;
    try {
      var client = window.__wx_api_client;
      var record = Object.assign({}, fields, {
        event: kind, at_ms: Math.round(performance.now()),
        page: window.location.pathname, visibility: document.visibilityState,
        page_age_ms: Math.round(performance.now() - startedAt),
        page_instance_id: client && client.commentPageInstance ? client.commentPageInstance() : '',
        dropped_logs: dropped
      });
      var body = JSON.stringify({ msg: '[Perf] ' + JSON.stringify(record) });
      controller = new AbortController();
      timer = setTimeout(function() { controller.abort(); }, 2000);
      inFlight++;
      Promise.resolve(fetch('/__wx_channels_api/tip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body, signal: controller.signal
      })).catch(function() {}).finally(function() { clearTimeout(timer); inFlight--; });
      dropped = 0;
    } catch (_) {
      if (timer) { clearTimeout(timer); inFlight--; }
    }
  };
  // 每分钟只读数量和内存计数，不序列化 DOM、Vue store 或采集结果。
  function sampleResources(reason) {
    try {
      var now = performance.now();
      var memory = performance.memory;
      var media = document.querySelectorAll('video, audio');
      var playing = 0;
      for (var i = 0; i < media.length; i++) if (!media[i].paused) playing++;
      var collector = window.__wx_channels_search_collector;
      window.__sph_perf_log('page_resources', {
        reason: reason, hidden_for_ms: hiddenSince === null ? 0 : Math.round(now - hiddenSince),
        js_heap_bytes: memory ? memory.usedJSHeapSize : null,
        js_heap_limit_bytes: memory ? memory.jsHeapSizeLimit : null,
        dom_nodes: document.getElementsByTagName('*').length,
        media_nodes: media.length, playing_media: playing,
        cached_cards: window.__wx_cached_cards ? window.__wx_cached_cards.length : 0,
        collected_feeds: collector && collector.feeds ? collector.feeds.length : 0,
        fetch_request_cache: window.__sph_fetch_requests ? window.__sph_fetch_requests.size : 0,
        comment_collections: window.__sph_comment_collections ? window.__sph_comment_collections.size : 0,
        long_task_count: longTaskCount, long_task_total_ms: Math.round(longTaskTotal),
        long_task_max_ms: Math.round(longTaskMax)
      });
    } catch (_) {}
  }
  function tick() {
    if (stopped) return;
    var now = performance.now();
    var visibility = document.visibilityState;
    var lag = Math.max(0, now - lastTick - 1000);
    if (lag >= 750) limited('event_loop_lag', {
      lag_ms: Math.round(lag), previous_visibility: previousVisibility,
      ready_state: document.readyState
    });
    previousVisibility = visibility;
    lastTick = now;
    if (now - lastSampleAt >= 60000) {
      lastSampleAt = now;
      sampleResources('periodic');
    }
    setTimeout(tick, 1000);
  }
  setTimeout(tick, 1000);
  // 可见性变化只记录，不将后台定时器限速误报为前台同步阻塞。
  document.addEventListener('visibilitychange', function() {
    var now = performance.now();
    window.__sph_perf_log('visibility', {
      previous_visibility: previousVisibility, previous_state_ms: Math.round(now - visibilitySince)
    });
    previousVisibility = document.visibilityState;
    visibilitySince = now;
    hiddenSince = previousVisibility === 'hidden' ? now : null;
    lastTick = now;
  });
  document.addEventListener('freeze', function() {
    frozenAt = performance.now();
    window.__sph_perf_log('freeze', {});
  });
  document.addEventListener('resume', function() {
    var now = performance.now();
    window.__sph_perf_log('resume', { frozen_ms: frozenAt === null ? null : Math.round(now - frozenAt) });
    frozenAt = null;
    lastTick = now;
  });
  function navigation(phase) {
    var entry = performance.getEntriesByType('navigation')[0];
    if (!entry) return;
    window.__sph_perf_log('navigation', {
      phase: phase, response_end_ms: Math.round(entry.responseEnd),
      dom_ready_ms: Math.round(entry.domContentLoadedEventEnd), load_ms: Math.round(entry.loadEventEnd)
    });
  }
  document.addEventListener('DOMContentLoaded', function() { setTimeout(function() {
    navigation('dom_ready'); sampleResources('dom_ready');
  }, 0); }, { once: true });
  window.addEventListener('load', function() { setTimeout(function() { navigation('load'); }, 0); }, { once: true });
  var observer;
  try {
    observer = new PerformanceObserver(function(list) {
      list.getEntries().forEach(function(entry) {
        if (entry.entryType === 'longtask') {
          longTaskCount++;
          longTaskTotal += entry.duration;
          longTaskMax = Math.max(longTaskMax, entry.duration);
          if (entry.duration >= 200) limited('long_task', { duration_ms: Math.round(entry.duration), start_ms: Math.round(entry.startTime) });
        } else if (entry.entryType === 'resource' && entry.duration >= 2000 &&
          /^(script|link|fetch|xmlhttprequest)$/.test(entry.initiatorType)) {
          try {
            var url = new URL(entry.name);
            if (url.pathname.indexOf('/__wx_channels_api/') === 0) return;
            limited('slow_resource', {
              resource: url.origin + url.pathname, initiator: entry.initiatorType,
              duration_ms: Math.round(entry.duration)
            });
          } catch (_) {}
        }
      });
    });
    // 分别订阅，旧版 Chromium 不支持 longtask 时仍保留资源计时。
    observer.observe({ type: 'resource', buffered: true });
    try { observer.observe({ type: 'longtask', buffered: true }); } catch (_) {}
  } catch (_) {}
  window.addEventListener('pagehide', function(event) {
    if (!event.persisted) { stopped = true; if (observer) observer.disconnect(); }
  });
})();
</script>`
}

/**
 * @file Feed页面功能模块 - 视频详情页工具注入
 */
console.log('[feed.js] 加载Feed页面模块');

// ==================== Feed页面工具注入 ====================

function __build_feed_header_icon(id, title, svgMarkup) {
  var wrapper = document.createElement('div');
  wrapper.id = id;
  wrapper.className = 'relative h-5 w-5 flex-initial flex-shrink-0 cursor-pointer';
  wrapper.title = title;
  wrapper.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'color:rgba(255,255,255,0.5)',
    'transition:color 0.2s ease, opacity 0.2s ease',
    'margin-right:16px'
  ].join(';');
  wrapper.innerHTML = svgMarkup;
  wrapper.onmouseenter = function () {
    wrapper.style.color = 'rgba(255,255,255,0.82)';
  };
  wrapper.onmouseleave = function () {
    wrapper.style.color = 'rgba(255,255,255,0.5)';
  };
  return wrapper;
}

function __get_visible_feed_op_items() {
  var selectors = [
    '.op-item',
    '[class*="op-item"]',
    '.op-list > div',
    '.action-list > div'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors[i])).filter(function (node) {
      return node && node.offsetParent !== null;
    });
    if (nodes.length >= 3) return nodes;
  }
  return [];
}

function __try_open_feed_comment_panel() {
  var commentPanel = document.querySelector(
    '.comment-list, .comment-panel, .comment-drawer, [class*="comment-panel"], [class*="comment-drawer"], [class*="comment-list"]'
  );
  if (commentPanel) return true;

  var actionCandidates = __get_visible_feed_op_items();
  if (actionCandidates.length) {
    var commentAction = actionCandidates[actionCandidates.length - 1];
    try {
      commentAction.click();
      return true;
    } catch (e) {
      console.warn('[feed.js] 点击原生评论按钮失败:', e);
    }
  }

  try {
    var app = document.querySelector('[data-v-app]') || document.getElementById('app');
    var vue = app && (app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component));
    var pinia = vue && vue.appContext && vue.appContext.config && vue.appContext.config.globalProperties && vue.appContext.config.globalProperties.$pinia;
    if (pinia && pinia._s && typeof pinia._s.forEach === 'function') {
      var methodNames = ['openComment', 'openCommentPanel', 'showCommentPanel', 'toggleCommentPanel', 'onClickComment', 'handleCommentClick'];
      var opened = false;
      pinia._s.forEach(function (store) {
        if (opened || !store) return;
        for (var i = 0; i < methodNames.length; i++) {
          var methodName = methodNames[i];
          if (typeof store[methodName] === 'function') {
            try {
              store[methodName]();
              opened = true;
              break;
            } catch (_) {}
          }
        }
      });
      if (opened) return true;
    }
  } catch (e) {
    console.warn('[feed.js] 调用评论面板方法失败:', e);
  }

  return false;
}

function __start_feed_comment_collection_with_open_panel() {
  var opened = __try_open_feed_comment_panel();
  if (opened) {
    __wx_log({ msg: '💬 正在打开评论区...' });
  } else {
    __wx_log({ msg: '💬 未定位到原生评论按钮，尝试直接采集...' });
  }

  var attempts = 0;
  var maxAttempts = 16;
  var timer = setInterval(function () {
    attempts++;
    if (typeof window.__wx_channels_start_comment_collection === 'function') {
      try {
        window.__wx_channels_start_comment_collection();
      } finally {
        clearInterval(timer);
      }
      return;
    }
    if (attempts >= maxAttempts) {
      clearInterval(timer);
      __wx_log({ msg: '❌ 评论采集功能尚未就绪，请稍后重试' });
    }
  }, opened ? 350 : 120);
}

var __wx_feed_runtime_state = {
  activeFeedId: '',
  monitorStarted: false
};

function __get_active_feed_element() {
  var feedNodes = document.querySelectorAll('[id^="flow-feed-"]');
  if (!feedNodes || feedNodes.length === 0) return null;

  var viewportTop = 0;
  var viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
  var viewportRight = window.innerWidth || document.documentElement.clientWidth || 0;
  var bestNode = null;
  var bestScore = -1;

  for (var i = 0; i < feedNodes.length; i++) {
    var node = feedNodes[i];
    if (!node || !node.getBoundingClientRect) continue;
    var rect = node.getBoundingClientRect();
    var visibleHeight = Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop);
    var visibleWidth = Math.min(rect.right, viewportRight) - Math.max(rect.left, 0);
    var score = Math.max(0, visibleHeight) * Math.max(0, visibleWidth);
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  return bestNode;
}

function __get_active_feed_id() {
  var node = __get_active_feed_element();
  if (!node || !node.id) return '';
  return node.id.replace(/^flow-feed-/, '');
}

function __is_feed_candidate(obj) {
  return !!(obj &&
    typeof obj === 'object' &&
    obj.objectDesc &&
    obj.objectDesc.media &&
    obj.objectDesc.media[0] &&
    (obj.objectDesc.mediaType === 4 || obj.objectDesc.mediaType === 2));
}

function __search_feed_candidate(root, activeFeedId, maxDepth, maxKeys) {
  var visited = [];

  function seen(obj) {
    for (var i = 0; i < visited.length; i++) {
      if (visited[i] === obj) return true;
    }
    visited.push(obj);
    return false;
  }

  function isCandidateMatch(candidate) {
    if (!candidate) return false;
    if (!activeFeedId) return true;
    var candidateId = candidate.id || candidate.objectId || candidate.objectNonceId || '';
    return String(candidateId) === String(activeFeedId);
  }

  function walk(obj, depth) {
    if (!obj || typeof obj !== 'object') return null;
    if (seen(obj)) return null;
    if (__is_feed_candidate(obj) && isCandidateMatch(obj)) {
      return obj;
    }
    if (depth >= maxDepth) return null;

    if (Array.isArray(obj)) {
      for (var ai = 0; ai < obj.length && ai < maxKeys; ai++) {
        var arrayMatch = walk(obj[ai], depth + 1);
        if (arrayMatch) return arrayMatch;
      }
      return null;
    }

    var keys = [];
    try {
      keys = Object.keys(obj);
    } catch (e) {
      return null;
    }

    for (var i = 0; i < keys.length && i < maxKeys; i++) {
      var key = keys[i];
      if (key === 'parent' || key === 'appContext' || key === 'provides' || key === 'deps') continue;

      var value = null;
      try {
        value = obj[key];
      } catch (e) {
        continue;
      }

      if (!value || (typeof value !== 'object' && !Array.isArray(value))) continue;

      var nestedMatch = walk(value, depth + 1);
      if (nestedMatch) return nestedMatch;
    }

    return null;
  }

  return walk(root, 0);
}

function __get_feed_runtime_roots() {
  var roots = [];
  var activeFeedNode = __get_active_feed_element();
  var app = document.getElementById('app') || document.querySelector('[data-v-app]');

  console.log('[feed.js] __get_feed_runtime_roots, activeFeedNode:', activeFeedNode ? '存在' : '空', 'app:', app ? '存在' : '空');

  function push(root) {
    if (root) roots.push(root);
  }

  push(activeFeedNode);
  push(activeFeedNode && activeFeedNode.__vueParentComponent);
  push(activeFeedNode && activeFeedNode.__vnode);
  push(activeFeedNode && activeFeedNode._vnode);

  if (app) {
    push(app.__vue_app__);
    push(app.__vueParentComponent);
    push(app.__vnode);
    push(app._vnode);
  }

  try {
    var appInstance = app && (app.__vue_app__ || (app.__vueParentComponent && app.__vueParentComponent.appContext && app.__vueParentComponent.appContext.app));
    var appContext = appInstance && (appInstance._context || appInstance.context);
    var globalProperties = appContext && appContext.config && appContext.config.globalProperties;
    var pinia = globalProperties && globalProperties.$pinia;

    push(appContext);
    push(globalProperties);
    push(pinia);

    if (pinia && pinia._s && typeof pinia._s.forEach === 'function') {
      pinia._s.forEach(function (store) {
        push(store);
        push(store.$state);
      });
    }
  } catch (e) {
    console.warn('[feed.js] 获取 feed runtime roots 失败:', e);
  }

  return roots;
}

function __locate_current_feed_runtime() {
  var activeFeedId = __get_active_feed_id();
  console.log('[feed.js] __locate_current_feed_runtime, activeFeedId:', activeFeedId);

  var roots = __get_feed_runtime_roots();
  console.log('[feed.js] 获取到', roots.length, '个 runtime roots');

  for (var i = 0; i < roots.length; i++) {
    console.log('[feed.js] 检查 root', i, ':', roots[i] ? '存在' : '空');
    var match = __search_feed_candidate(roots[i], activeFeedId, 6, 40);
    if (match) {
      console.log('[feed.js] 在 root', i, '找到匹配');
      return match;
    }
  }

  console.log('[feed.js] 所有 roots 都没有找到匹配');
  return null;
}

function __extract_profile_from_feed_dom_fallback(activeFeedId) {
  var feedNode = __get_active_feed_element();
  if (!feedNode) return null;

  var descriptionNode = feedNode.querySelector('.content .ctn, .collapsed-text .ctn, .compute-node');
  var authorNode = document.querySelector('.avatar-nickname .nickname, .author-name, .account-info .nickname');
  var avatarNode = document.querySelector('.account-info img, .avatar-wrapper img, .author-info img');
  var posterNode = feedNode.querySelector('.vjs-poster');
  var mediaNode = feedNode.querySelector('.feed-video video, video');
  var counts = document.querySelectorAll('.op-item .op-text, .op-item .count');

  var thumbUrl = '';
  if (posterNode && posterNode.style && posterNode.style.backgroundImage) {
    var matched = posterNode.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (matched && matched[1]) thumbUrl = matched[1];
  }

  var mediaUrl = mediaNode ? (mediaNode.currentSrc || mediaNode.src || '') : '';
  if (mediaUrl && String(mediaUrl).indexOf('blob:') === 0) mediaUrl = '';

  return {
    id: activeFeedId || (feedNode.id || '').replace(/^flow-feed-/, ''),
    type: 'media',
    title: descriptionNode ? descriptionNode.textContent.trim() : '',
    nickname: authorNode ? authorNode.textContent.trim() : '',
    contact: {
      nickname: authorNode ? authorNode.textContent.trim() : '',
      avatar_url: avatarNode ? avatarNode.src : ''
    },
    thumbUrl: thumbUrl,
    coverUrl: thumbUrl,
    url: mediaUrl,
    spec: [],
    likeCount: counts[0] ? parseInt(counts[0].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0,
    forwardCount: counts[1] ? parseInt(counts[1].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0,
    favCount: counts[2] ? parseInt(counts[2].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0,
    commentCount: counts[3] ? parseInt(counts[3].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0
  };
}

function __remember_current_feed(feed, reason) {
  if (!feed || typeof WXU === 'undefined' || !WXU.format_feed) return null;

  var profile = WXU.format_feed(feed);
  if (!profile) return null;

  var prevProfile = window.__wx_channels_store__ && window.__wx_channels_store__.profile;
  var prevId = prevProfile && prevProfile.id ? String(prevProfile.id) : '';
  var nextId = profile.id ? String(profile.id) : '';

  if (typeof WXU.set_feed === 'function' && prevId !== nextId) {
    WXU.set_feed(feed);
  } else if (window.__wx_channels_store__) {
    window.__wx_channels_store__.profile = profile;
  }

  __wx_feed_runtime_state.activeFeedId = nextId || __get_active_feed_id();
  if (reason) {
    console.log('[feed.js] 已同步当前视频:', reason, profile.id, profile.title);
  }
  return profile;
}

function __sync_feed_profile_with_runtime(forceLog) {
  showFeedDebugInfo('🔍 同步视频信息中... (runtime)');

  console.log('[feed.js] __sync_feed_profile_with_runtime 开始执行, forceLog:', forceLog);

  var runtimeFeed = __locate_current_feed_runtime();
  console.log('[feed.js] runtimeFeed:', runtimeFeed ? '找到' : '未找到');
  if (runtimeFeed) {
    console.log('[feed.js] runtimeFeed 内容:', runtimeFeed.objectDesc ? runtimeFeed.objectDesc.media : '无 media');
    showFeedDebugInfo('✅ 从页面获取到视频信息');
    return __remember_current_feed(runtimeFeed, forceLog ? 'runtime' : '');
  }

  var fallback = __extract_profile_from_feed_dom_fallback(__get_active_feed_id());
  console.log('[feed.js] fallback:', fallback ? '找到' : '未找到');
  if (fallback && fallback.url && window.__wx_channels_store__) {
    window.__wx_channels_store__.profile = fallback;
    __wx_feed_runtime_state.activeFeedId = fallback.id || __get_active_feed_id();
    console.log('[feed.js] 已使用 DOM fallback 同步当前视频:', fallback.id, fallback.title);
    showFeedDebugInfo('✅ 从DOM元素获取到视频信息');
    if (forceLog) {
      console.log('[feed.js] 已使用 DOM fallback 同步当前视频:', fallback.id, fallback.title);
    }
    return fallback;
  }

  console.log('[feed.js] 最终 profile:', window.__wx_channels_store__ && window.__wx_channels_store__.profile);
  showFeedDebugInfo('⚠️ 未能获取到视频信息，请尝试重新播放视频');
  return window.__wx_channels_store__ && window.__wx_channels_store__.profile;
}

function __resolve_current_feed_profile(retryCount, intervalMs) {
  retryCount = typeof retryCount === 'number' ? retryCount : 6;
  intervalMs = typeof intervalMs === 'number' ? intervalMs : 220;

  return new Promise(function (resolve) {
    var attempts = 0;

    function tryResolve() {
      attempts += 1;
      var profile = __sync_feed_profile_with_runtime(attempts === 1);
      if (profile) {
        resolve(profile);
        return;
      }
      if (attempts >= retryCount) {
        resolve(null);
        return;
      }
      setTimeout(tryResolve, intervalMs);
    }

    tryResolve();
  });
}

function __start_feed_slide_monitor() {
  if (__wx_feed_runtime_state.monitorStarted) return;
  __wx_feed_runtime_state.monitorStarted = true;

  __wx_feed_runtime_state.activeFeedId = __get_active_feed_id();

  setInterval(function () {
    var activeFeedId = __get_active_feed_id();
    if (!activeFeedId || activeFeedId === __wx_feed_runtime_state.activeFeedId) return;

    __wx_feed_runtime_state.activeFeedId = activeFeedId;
    console.log('[feed.js] 检测到当前视频切换:', activeFeedId);

    // 视频切换时，重新注入按钮（因为Vue可能会重新渲染工具栏）
    __insert_tools_to_feed_toolbar().then(function(success) {
      if (success) {
        console.log('[feed.js] 视频切换后按钮已重新注入');
      }
    });

    setTimeout(function () { __sync_feed_profile_with_runtime(true); }, 80);
    setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 320);
    setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 900);
  }, 500);

  // 持续监控工具栏按钮是否存在，如果不存在则重新注入
  // 这样可以应对Vue随时重新渲染工具栏的情况
  setInterval(function() {
    var container = document.querySelector('header.home-header > .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 > .flex.items-center') ||
      document.querySelector('header.home-header .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 .flex.items-center') ||
      document.querySelector('.home-header .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 .flex.items-center');

    if (!container) return;

    var btns = container.querySelectorAll('#wx-feed-comment-icon');
    if (btns.length < 2) {
      console.log('[feed.js] 检测到按钮消失，尝试重新注入...');
      __insert_tools_to_feed_toolbar();
    }
  }, 2000);
}

/** 注入Feed页面顶部工具栏按钮 */
async function __insert_tools_to_feed_toolbar() {
  // 查找顶部工具栏容器
  var findToolbarContainer = function () {
    return document.querySelector('header.home-header > .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 > .flex.items-center') ||
      document.querySelector('header.home-header .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 .flex.items-center') ||
      document.querySelector('.home-header .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 .flex.items-center');
  };

  var tryInject = function () {
    var container = findToolbarContainer();
    if (!container) {
      console.log('[feed.js] 工具栏容器不存在');
      return false;
    }

    // 每次都移除可能存在的旧按钮，确保全新注入
    var oldBtns = container.querySelectorAll('#wx-feed-comment-icon, #wx-feed-copy-link-icon, #wx-feed-dom-icon, #wx-feed-store-snapshot-icon, #wx-feed-comment-snapshot-icon, #wx-feed-comment-count-icon');
    if (oldBtns.length > 0) {
      console.log('[feed.js] 移除旧的工具栏按钮 (' + oldBtns.length + '个)');
      oldBtns.forEach(function(btn) { btn.remove(); });
    }

    // 创建评论图标
    var commentIconWrapper = __build_feed_header_icon(
      'wx-feed-comment-icon',
      '采集评论',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6.85 18.825L3 20.1l1.275-3.85A7.95 7.95 0 0 1 4 14.15c0-4.28 3.57-7.75 8-7.75s8 3.47 8 7.75-3.57 7.75-8 7.75c-.73 0-1.44-.1-2.1-.3a8.23 8.23 0 0 1-3.05-1.775Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
    );

    commentIconWrapper.onclick = function () {
      __start_feed_comment_collection_with_open_panel();
    };

    // 创建复制链接按钮（文字形式）
    var copyLinkIconWrapper = document.createElement('div');
    copyLinkIconWrapper.id = 'wx-feed-copy-link-icon';
    copyLinkIconWrapper.className = 'relative flex-shrink-0 cursor-pointer';
    copyLinkIconWrapper.title = '视频链接';
    copyLinkIconWrapper.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'color:rgba(255,255,255,0.5)',
      'transition:color 0.2s ease, opacity 0.2s ease',
      'margin-right:16px',
      'font-size:14px',
      'padding:0 8px',
      'height:28px',
      'border-radius:4px',
      'background:rgba(255,255,255,0.1)'
    ].join(';');
    copyLinkIconWrapper.textContent = '复制链接';
    copyLinkIconWrapper.onmouseenter = function () {
      copyLinkIconWrapper.style.color = 'rgba(255,255,255,0.82)';
      copyLinkIconWrapper.style.background = 'rgba(255,255,255,0.2)';
    };
    copyLinkIconWrapper.onmouseleave = function () {
      copyLinkIconWrapper.style.color = 'rgba(255,255,255,0.5)';
      copyLinkIconWrapper.style.background = 'rgba(255,255,255,0.1)';
    };

    copyLinkIconWrapper.onclick = function () {
      var paramsToKeep = ["oid", "nid", "fromSubPage", "context_id", "eid"];
      var u = new URL(window.location.href);
      var base = u.origin + u.pathname;
      var filteredParams = new URLSearchParams();
      paramsToKeep.forEach(function (key) {
        var val = u.searchParams.get(key);
        if (val) filteredParams.set(key, val);
      });
      var trimmedUrl = base + "?" + filteredParams.toString();
      __copy_to_clipboard(trimmedUrl);
    };

    // 复制到剪贴板函数
    function __copy_to_clipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          __wx_log({ msg: '已复制: ' + text });
          showFeedDebugInfo('已复制: ' + text);
        }).catch(function () {
          __fallback_copy(text);
        });
      } else {
        __fallback_copy(text);
      }
    }

    // 降级复制方案
    function __fallback_copy(text) {
      var textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        __wx_log({ msg: '已复制: ' + text });
        showFeedDebugInfo('已复制: ' + text);
      } catch (err) {
        console.error('[feed.js] 复制失败:', err);
        __wx_log({ msg: '复制失败，请手动复制' });
      }
      document.body.removeChild(textArea);
    }

    // 创建获取DOM按钮
    var domIconWrapper = __build_feed_header_icon(
      'wx-feed-dom-icon',
      '获取DOM',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 9h6M9 12h6M9 15h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>'
    );

    domIconWrapper.onclick = function () {
      try {
        // 获取完整HTML
        var pageHTML = document.documentElement.outerHTML;

        // 创建Blob对象
        var blob = new Blob([pageHTML], { type: 'text/plain;charset=utf-8' });

        // 创建下载链接
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;

        // 生成文件名
        var pageTitle = document.title || 'page';
        pageTitle = pageTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        a.download = pageTitle + '_dom_' + timestamp + '.txt';

        // 触发下载
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        __wx_log({ msg: 'DOM已下载: ' + a.download });
        console.log('[feed.js] DOM已下载:', a.download);
      } catch (e) {
        console.error('[feed.js] 获取DOM失败:', e);
        __wx_log({ msg: '获取DOM失败: ' + e.message });
      }
    };

    // 创建 Store 快照按钮
    var storeSnapshotIconWrapper = __build_feed_header_icon(
      'wx-feed-store-snapshot-icon',
      'Store快照',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="M9 9h6M9 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    );

    storeSnapshotIconWrapper.onclick = function () {
      dumpAllPiniaStores();
    };

    // 创建评论快照按钮（采集评论 → 等待稳定 → Store快照）
    var commentSnapshotIconWrapper = __build_feed_header_icon(
      'wx-feed-comment-snapshot-icon',
      '评论快照',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M9 9h6M9 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="17" cy="17" r="4" fill="currentColor"/></svg>'
    );

    commentSnapshotIconWrapper.onclick = function () {
      var originalWxLog = typeof __wx_log === 'function' ? __wx_log : null;
      var snapshotSaved = false;

      function onCollectionDone() {
        if (snapshotSaved) return;
        snapshotSaved = true;
        var savedWxLog = originalWxLog;
        if (savedWxLog) __wx_log = savedWxLog;
        dumpAllPiniaStores().then(function (path) {
          if (savedWxLog) savedWxLog({ msg: '📸 评论快照已保存: ' + (path || '(空)') });
          else console.log('[评论快照] 最终JSON路径: ' + (path || '(空)'));
        });
      }

      __wx_log = function (data) {
        if (originalWxLog) originalWxLog(data);
        if (snapshotSaved) return;
        var msg = data && data.msg;
        if (!msg) return;
        if (msg.indexOf('✅ 评论采集完成') !== -1 || msg.indexOf('⚠️ 采集停止') !== -1 || msg.indexOf('✅ 评论已保存') !== -1) {
          console.log('[评论快照] 检测到采集完成信号: ' + msg);
          onCollectionDone();
        }
      };

      __wx_log({ msg: '📸 评论快照: 开始采集评论...' });
      __start_feed_comment_collection_with_open_panel();
    };

    // 创建评论总数按钮
    var commentCountIconWrapper = __build_feed_header_icon(
      'wx-feed-comment-count-icon',
      '评论总数',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 20v-8m0 0V4m0 8h8m-8 0H4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );

    commentCountIconWrapper.onclick = function () {
      var commentCount = 0;
      try {
        var app = document.querySelector('[data-v-app]') || document.getElementById('app');
        var vue = app && (app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component));
        var appContext = vue && (vue.appContext || (vue.ctx && vue.ctx.appContext));
        var globalProperties = appContext && appContext.config && appContext.config.globalProperties;
        var pinia = globalProperties && globalProperties.$pinia;
        if (!pinia || !pinia._s) { console.log(commentCount); return; }

        var stores = pinia._s;
        var iterator = stores.keys();
        var result = iterator.next();

        while (!result.done) {
          var id = result.value;
          var s = stores.get(id);
          if (!s) { result = iterator.next(); continue; }

          var home = s.home || (s.$state && s.$state.home);
          var flowCommentList = null;
          if (home && home.flowCommentList) {
            flowCommentList = home.flowCommentList;
          } else if (s.flowCommentList) {
            flowCommentList = s.flowCommentList;
          }

          if (flowCommentList && flowCommentList.commentCount !== undefined) {
            commentCount = flowCommentList.commentCount;
            break;
          }

          var state = s.$state || s;
          if (state.home && state.home.flowCommentList && state.home.flowCommentList.commentCount !== undefined) {
            commentCount = state.home.flowCommentList.commentCount;
            break;
          }

          result = iterator.next();
        }
      } catch (e) {}
      __wx_log({ msg: '� 评论总数: ' + commentCount });

      console.log(commentCount);
    };

    // Insert into container
    container.insertBefore(commentSnapshotIconWrapper, container.firstChild);
    container.insertBefore(storeSnapshotIconWrapper, commentSnapshotIconWrapper);
    container.insertBefore(commentCountIconWrapper, storeSnapshotIconWrapper);
    container.insertBefore(domIconWrapper, container.firstChild);
    container.insertBefore(commentIconWrapper, container.firstChild);
    container.insertBefore(copyLinkIconWrapper, container.firstChild);

    console.log('[feed.js] ✅ 工具栏按钮注入成功');
    __wx_log({ msg: "注入评论工具成功!" });
    return true;
  };

  // 立即尝试注入
  if (tryInject()) return true;

  // 如果失败，使用 MutationObserver 监听 DOM 变化 + 定时器重试
  return new Promise(function (resolve) {
    var retryCount = 0;
    var maxRetries = 20;
    var retryInterval = 300;

    // 使用 MutationObserver 监听 DOM 变化
    var observer = new MutationObserver(function (mutations, obs) {
      if (tryInject()) {
        obs.disconnect();
        clearInterval(retryTimer);
        resolve(true);
        return;
      }
      // 即使有 DOM 变化也继续尝试
      retryCount++;
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    // 使用定时器定期重试（更可靠）
    var retryTimer = setInterval(function() {
      retryCount++;
      if (tryInject()) {
        observer.disconnect();
        clearInterval(retryTimer);
        resolve(true);
        return;
      }
      if (retryCount >= maxRetries) {
        observer.disconnect();
        clearInterval(retryTimer);
        console.log('[feed.js] 工具栏按钮注入失败，已重试' + maxRetries + '次');
        resolve(false);
      }
    }, retryInterval);

    // 监听页面可见性变化（从后台切回时重新尝试）
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') {
        retryCount = 0; // 重置计数器
      }
    });

    // 监听滚动结束事件
    var scrollTimer = null;
    window.addEventListener('scroll', function() {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function() {
        retryCount = 0; // 重置计数器
        tryInject(); // 立即尝试注入
      }, 500);
    });

    // 10秒后超时
    setTimeout(function () {
      observer.disconnect();
      clearInterval(retryTimer);
      window.removeEventListener('scroll', null); // 清理监听器
      console.log('[feed.js] 工具栏按钮注入超时（10秒）');
      resolve(false);
    }, 10000);
  });
}

// 在页面上显示调试信息
function showFeedDebugInfo(msg) {
  // 创建临时提示元素
  var existing = document.getElementById('wx-feed-debug-toast');
  if (existing) existing.remove();

  var toast = document.createElement('div');
  toast.id = 'wx-feed-debug-toast';
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(0,0,0,0.8);color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;max-width:90%;word-break:break-all;';
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(function() {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s';
    setTimeout(function() { toast.remove(); }, 500);
  }, 3000);
}

/** Feed页面按钮注入入口 */
async function __insert_tools_to_feed_page() {
  console.log('[feed.js] 开始注入Feed页面按钮到顶部工具栏...');
  __start_feed_slide_monitor();

  var success = await __insert_tools_to_feed_toolbar();
  if (success) {
    setTimeout(function () { __sync_feed_profile_with_runtime(true); }, 120);
    setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 500);
    return true;
  }

  console.log('[feed.js] 首次注入失败，开始重试机制...');

  // 重试机制：每隔500ms重试一次，最多重试10次
  var retries = 0;
  var maxRetries = 10;

  return new Promise(function(resolve) {
    var retryTimer = setInterval(async function() {
      retries++;
      console.log('[feed.js] 重试注入 (' + retries + '/' + maxRetries + ')...');

      var retrySuccess = await __insert_tools_to_feed_toolbar();
      if (retrySuccess) {
        clearInterval(retryTimer);
        setTimeout(function () { __sync_feed_profile_with_runtime(true); }, 120);
        setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 500);
        resolve(true);
        return;
      }

      if (retries >= maxRetries) {
        clearInterval(retryTimer);
        console.log('[feed.js] 重试' + maxRetries + '次后仍未找到Feed页面工具栏');
        resolve(false);
      }
    }, 500);

    // 总超时15秒
    setTimeout(function() {
      clearInterval(retryTimer);
      if (retries < maxRetries) {
        console.log('[feed.js] 注入超时');
      }
      resolve(false);
    }, 15000);
  });
}

/** Feed页面导出按钮点击处理 */


console.log('[feed.js] Feed页面模块加载完成');

if (typeof WXE !== 'undefined') {
  WXE.onGotoNextFeed(function (feed) {
    __remember_current_feed(feed, 'goto-next');
  });
  WXE.onGotoPrevFeed(function (feed) {
    __remember_current_feed(feed, 'goto-prev');
  });
  WXE.onFeed(function (feed) {
    __remember_current_feed(feed, 'feed-event');
  });
  WXE.onFetchFeedProfile(function (feed) {
    __remember_current_feed(feed, 'feed-profile');
  });
}

/**
 * 遍历所有 Pinia Store 并发送到后端保存
 */
function dumpAllPiniaStores() {
  return new Promise(function (resolve) {
    var app = document.querySelector('[data-v-app]') || document.getElementById('app');
    var vue = app && (app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component));
    var appContext = vue && (vue.appContext || (vue.ctx && vue.ctx.appContext));
    var globalProperties = appContext && appContext.config && appContext.config.globalProperties;
    var pinia = globalProperties && globalProperties.$pinia;

    if (!pinia || !pinia._s) {
      console.warn('[Pinia Store] 未找到 Pinia Store');
      __wx_log({ msg: '❌ 未找到 Pinia Store' });
      resolve('');
      return;
    }

    var stores = {};
    var storeNames = [];
    var commentCount = 0;
    var loadedCount = 0;

    pinia._s.forEach(function (store, name) {
      try {
        var state = (store.$state && JSON.parse(JSON.stringify(store.$state))) || {};
        stores[name] = state;
        storeNames.push(name);

        // 从 home store 中提取评论数量
        if (name === 'home' && state.flowCommentList) {
          var flowCommentList = state.flowCommentList;
          commentCount = flowCommentList.commentCount || 0;
          loadedCount = (flowCommentList.items && flowCommentList.items.length) || 0;
        }
      } catch (e) {
        stores[name] = { '__error__': e.message };
      }
    });

    console.log('[Pinia Store] 快照数据:', stores);
    __wx_log({ msg: '💾 Store快照采集中... (' + storeNames.length + '个, 评论数=' + commentCount + ')' });

    var page = window.__wx_current_page__ || location.pathname || '';
    var snapshotTaskId = window.__snapshotTaskId || '';

    fetch('/__wx_channels_api/dump_pinia_store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stores: stores,
        page: page,
        url: location.href,
        timestamp: Date.now()
      })
    }).then(function (res) { return res.json(); })
      .then(function (data) {
        var jsonPath = (data && data.path) ? data.path : '';
        console.log('[Pinia Store] 快照已保存:', data);
        __wx_log({ msg: '✅ Store快照已保存 (' + storeNames.length + '个: 评论数=' + commentCount + ')' });

        // 通知 Go 后端采集完成
        if (snapshotTaskId) {
          fetch('/__wx_channels_api/comment_snapshot_callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task_id: snapshotTaskId,
              done: true,
              success: !!jsonPath,
              total_count: commentCount,
              loaded_count: loadedCount,
              snapshot_path: jsonPath || '',
              message: jsonPath ? '快照采集完成' : '快照路径为空'
            })
          }).catch(function (e) {
            console.error('[Pinia Store] 回调失败:', e);
          });
        }

        resolve(jsonPath);
      })
      .catch(function (err) {
        console.error('[Pinia Store] 保存失败:', err);
        __wx_log({ msg: '❌ Store快照保存失败: ' + err.message });

        // 通知 Go 后端采集失败
        if (snapshotTaskId) {
          fetch('/__wx_channels_api/comment_snapshot_callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task_id: snapshotTaskId,
              done: true,
              success: false,
              error: err.message || '保存失败'
            })
          }).catch(function () {});
        }

        resolve('');
      });
  });
}

// ============================================================
// 暴露全局函数，供 api_client.js 通过 WebSocket 广播指令调用
// ============================================================
// 全局任务ID（api_client.js 在调用 dumpAllPiniaStores 前设置）
window.__snapshotTaskId = '';
window.__try_open_feed_comment_panel = __try_open_feed_comment_panel;
window.__start_feed_comment_collection_with_open_panel = __start_feed_comment_collection_with_open_panel;
window.dumpAllPiniaStores = dumpAllPiniaStores;

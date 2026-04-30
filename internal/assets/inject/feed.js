/**
 * @file Feed页面功能模块 - 视频详情页下载按钮注入
 */
console.log('[feed.js] 加载Feed页面模块');

// ==================== Feed页面下载按钮注入 ====================

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

    setTimeout(function () { __sync_feed_profile_with_runtime(true); }, 80);
    setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 320);
    setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 900);
  }, 500);
}

/** 注入Feed页面顶部工具栏按钮 */
async function __insert_download_btn_to_feed_toolbar() {
  // 查找顶部工具栏容器
  var findToolbarContainer = function () {
    return document.querySelector('header.home-header > .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 > .flex.items-center') ||
      document.querySelector('header.home-header .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 .flex.items-center') ||
      document.querySelector('.home-header .pointer-events-auto.flex-initial.flex-shrink-0.pl-4 .flex.items-center');
  };

  var tryInject = function () {
    var container = findToolbarContainer();
    if (!container) return false;

    // 检查是否已存在
    if (container.querySelector('#wx-feed-comment-icon') || container.querySelector('#wx-feed-download-icon')) {
      console.log('[feed.js] 工具栏按钮已存在');
      return true;
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

    // 创建复制链接按钮
    var copyLinkIconWrapper = __build_feed_header_icon(
      'wx-feed-copy-link-icon',
      '复制链接',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M7.75 11.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM4.75 8A2.25 2.25 0 0 0 2.5 10.25v4.5A2.25 2.25 0 0 0 4.75 17h4.5a2.25 2.25 0 0 0 2.25-2.25V15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M7.75 4.75A2.25 2.25 0 0 1 10 2.5h7.5A2.25 2.25 0 0 1 19.75 4.75v7.5A2.25 2.25 0 0 1 17.5 14.5H15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
    );

    copyLinkIconWrapper.onclick = function () {
      // 从本地存储获取profile数据
      var profile = __wx_channels_store__ && __wx_channels_store__.profile;

      // 如果本地没有，尝试从API获取
      if (!profile || !profile.id) {
        fetch('/__wx_channels_api/get_current_profile', {
          method: 'GET',
          headers: { 'X-Local-Auth': 'local-dev' }
        }).then(function (res) { return res.json(); })
          .then(function (data) {
            if (data && data.id) {
              __copy_video_ids_to_clipboard(data);
            } else {
              // 降级：复制URL
              __copy_to_clipboard(window.location.href);
            }
          }).catch(function () {
            __copy_to_clipboard(window.location.href);
          });
      } else {
        __copy_video_ids_to_clipboard(profile);
      }
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

    // 复制视频ID到剪贴板
    function __copy_video_ids_to_clipboard(profile) {
      var id = profile.id || '';
      var nonceId = profile.nonce_id || '';
      var copyText = 'id: ' + id + '\nnonce_id: ' + nonceId;

      console.log('[feed.js] 复制视频ID:', copyText);
      __copy_to_clipboard(copyText);
    };

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

    // 创建下载图标
    var downloadIconWrapper = __build_feed_header_icon(
      'wx-feed-download-icon',
      '下载视频',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 3C12.3314 3 12.6 3.26863 12.6 3.6V13.1515L15.5757 10.1757C15.8101 9.94142 16.1899 9.94142 16.4243 10.1757C16.6586 10.4101 16.6586 10.7899 16.4243 11.0243L12.4243 15.0243C12.1899 15.2586 11.8101 15.2586 11.5757 15.0243L7.57574 11.0243C7.34142 10.7899 7.34142 10.4101 7.57574 10.1757C7.81005 9.94142 8.18995 9.94142 8.42426 10.1757L11.4 13.1515V3.6C11.4 3.26863 11.6686 3 12 3ZM3.6 14.4C3.93137 14.4 4.2 14.6686 4.2 15V19.2C4.2 19.5314 4.46863 19.8 4.8 19.8H19.2C19.5314 19.8 19.8 19.5314 19.8 19.2V15C19.8 14.6686 20.0686 14.4 20.4 14.4C20.7314 14.4 21 14.6686 21 15V19.2C21 20.1941 20.1941 21 19.2 21H4.8C3.80589 21 3 20.1941 3 19.2V15C3 14.6686 3.26863 14.4 3.6 14.4Z" fill="currentColor"></path></svg>'
    );

    downloadIconWrapper.onclick = function () {
      __handle_feed_download_click();
    };

    // Create Export icon
    var exportIconWrapper = __build_feed_header_icon(
      'wx-feed-export-icon',
      '导出CSV',
      '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 3.75h5.25L18 8.5v11.75H8c-1.1 0-2-.9-2-2V5.75c0-1.1.9-2 2-2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path><path d="M13 3.75V8.5h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path><path d="M9.5 12.5h5M9.5 15.5h5M9.5 18.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>'
    );

    exportIconWrapper.onclick = function () {
      __handle_export_click();
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

    // Insert into container
    container.insertBefore(exportIconWrapper, container.firstChild);
    container.insertBefore(storeSnapshotIconWrapper, exportIconWrapper);
    container.insertBefore(downloadIconWrapper, storeSnapshotIconWrapper);
    container.insertBefore(domIconWrapper, container.firstChild);
    container.insertBefore(commentIconWrapper, container.firstChild);
    container.insertBefore(copyLinkIconWrapper, container.firstChild);

    console.log('[feed.js] ✅ 工具栏按钮注入成功');
    __wx_log({ msg: "注入评论和下载按钮成功!" });
    return true;
  };

  // 立即尝试注入
  if (tryInject()) return true;

  // 如果失败，使用 MutationObserver 监听 DOM 变化
  return new Promise(function (resolve) {
    var observer = new MutationObserver(function (mutations, obs) {
      if (tryInject()) {
        obs.disconnect();
        resolve(true);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // 5秒后超时
    setTimeout(function () {
      observer.disconnect();
      console.log('[feed.js] 工具栏按钮注入超时');
      resolve(false);
    }, 5000);
  });
}

/** Feed页面下载按钮点击处理 */
function __handle_feed_download_click() {
  var currentProfile = __wx_channels_store__ && __wx_channels_store__.profile;

  // 直接在页面上显示提示
  showFeedDebugInfo('📥 点击下载按钮 | 当前profile: ' + (currentProfile ? '已存储' : '为空'));

  console.log('[feed.js] 点击下载按钮，当前 profile:', currentProfile);

  // 尝试从 runtime 获取
  var profile = __sync_feed_profile_with_runtime(false);
  console.log('[feed.js] runtime 同步后的 profile:', profile);

  if (!profile || !profile.url) {
    // runtime 失败，尝试从后端 API 获取
    showFeedDebugInfo('⏳ 正在从服务器获取视频数据...');
    console.log('[feed.js] 尝试从后端获取视频数据');

    fetch('/__wx_channels_api/get_current_profile', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
    .then(function(response) { return response.json(); })
    .then(function(data) {
      console.log('[feed.js] 后端返回的profile数据:', data);
      if (data && data.id) {
        profile = data;
        __wx_channels_store__.profile = profile;
        showFeedDebugInfo('✅ 从服务器获取到视频: ' + (profile.title || profile.id).substring(0, 15));
        __show_feed_download_options(profile);
      } else {
        showFeedDebugInfo('❌ 服务器没有视频数据 - 请先播放视频');
      }
    })
    .catch(function(err) {
      console.error('[feed.js] 获取视频数据失败:', err);
      showFeedDebugInfo('❌ 获取视频数据失败');
    });

    return;
  }

  showFeedDebugInfo('✅ 视频数据已就绪: ' + (profile.title || profile.id).substring(0, 20));
  __show_feed_download_options(profile);
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

/** Feed页面下载选项菜单 */
function __show_feed_download_options(profile) {
  console.log('[feed.js] 显示下载选项菜单', profile);

  // 移除已存在的菜单
  var existingMenu = document.getElementById('wx-download-menu');
  if (existingMenu) existingMenu.remove();
  var existingOverlay = document.getElementById('wx-download-overlay');
  if (existingOverlay) existingOverlay.remove();

  var menu = document.createElement('div');
  menu.id = 'wx-download-menu';
  menu.style.cssText = 'position:fixed;z-index:99999;background:#2b2b2b;color:#e5e5e5;border-radius:8px;padding:0;width:280px;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;';

  var title = profile.title || '未知视频';
  var shortTitle = title.length > 30 ? title.substring(0, 30) + '...' : title;

  var html = '';

  // 标题栏
  html += '<div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);">';
  html += '<div style="font-size:15px;font-weight:500;color:#fff;margin-bottom:8px;">下载选项</div>';
  html += '<div style="font-size:13px;color:#999;line-height:1.4;">' + shortTitle + '</div>';
  html += '</div>';

  // 选项区域
  html += '<div style="padding:16px 20px;">';

  // 视频下载选项
  if (profile.spec && profile.spec.length > 0) {
    html += '<div style="margin-bottom:12px;font-size:12px;color:#999;">选择画质:</div>';
    profile.spec.forEach(function (spec, index) {
      var label = spec.fileFormat || ('画质' + (index + 1));
      if (spec.width && spec.height) {
        label += ' (' + spec.width + 'x' + spec.height + ')';
      }
      html += '<div class="download-option" data-index="' + index + '" style="padding:10px 16px;margin:8px 0;background:rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;text-align:center;transition:background 0.2s;font-size:13px;">' + label + '</div>';
    });
  } else {
    html += '<div class="download-option" data-index="-1" style="padding:10px 16px;margin:8px 0;background:rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;text-align:center;font-size:13px;">下载视频</div>';
  }

  // 封面下载
  html += '<div class="download-cover" style="padding:10px 16px;margin:8px 0;background:rgba(7,193,96,0.15);color:#07c160;border-radius:6px;cursor:pointer;text-align:center;font-size:13px;font-weight:500;">下载封面</div>';

  html += '</div>';

  // 底部按钮
  html += '<div style="padding:12px 20px;border-top:1px solid rgba(255,255,255,0.08);">';
  html += '<div class="close-menu" style="padding:8px;text-align:center;cursor:pointer;color:#999;font-size:13px;">取消</div>';
  html += '</div>';

  menu.innerHTML = html;
  document.body.appendChild(menu);

  var anchor = document.getElementById('wx-feed-download-icon');
  if (anchor && anchor.getBoundingClientRect) {
    var rect = anchor.getBoundingClientRect();
    var menuWidth = 280;
    var left = Math.max(16, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 16));
    var top = Math.max(56, rect.bottom + 12);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  } else {
    menu.style.top = '60px';
    menu.style.right = '20px';
  }

  // 添加遮罩
  var overlay = document.createElement('div');
  overlay.id = 'wx-download-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99998;';
  document.body.appendChild(overlay);

  function closeMenu() {
    menu.remove();
    overlay.remove();
  }

  // 绑定事件
  menu.querySelectorAll('.download-option').forEach(function (el) {
    el.onmouseover = function () { this.style.background = 'rgba(255,255,255,0.15)'; };
    el.onmouseout = function () { this.style.background = 'rgba(255,255,255,0.08)'; };
    el.onclick = function () {
      var index = parseInt(this.getAttribute('data-index'));
      var spec = index >= 0 && profile.spec ? profile.spec[index] : null;
      closeMenu();
      __wx_channels_handle_click_download__(spec);
    };
  });

  var coverBtn = menu.querySelector('.download-cover');
  coverBtn.onmouseover = function () { this.style.background = 'rgba(7,193,96,0.25)'; };
  coverBtn.onmouseout = function () { this.style.background = 'rgba(7,193,96,0.15)'; };
  coverBtn.onclick = function () {
    closeMenu();
    __wx_channels_handle_download_cover();
  };

  menu.querySelector('.close-menu').onclick = closeMenu;
  overlay.onclick = closeMenu;
}

/** Feed页面按钮注入入口 */
async function __insert_download_btn_to_feed_page() {
  console.log('[feed.js] 开始注入Feed页面按钮到顶部工具栏...');
  __start_feed_slide_monitor();

  var success = await __insert_download_btn_to_feed_toolbar();
  if (success) {
    setTimeout(function () { __sync_feed_profile_with_runtime(true); }, 120);
    setTimeout(function () { __sync_feed_profile_with_runtime(false); }, 500);
    return true;
  }

  console.log('[feed.js] 未找到Feed页面工具栏');
  return false;
}

/** Feed页面导出按钮点击处理 */
async function __handle_export_click() {
  console.log('[feed.js] 点击导出CSV');

  try {
    // 检查依赖
    if (typeof WXU === 'undefined') {
      throw new Error('WXU 工具库未加载');
    }

    // 移除外部依赖，使用原生方式下载
    // if (typeof saveAs === 'undefined') { ... }

    __wx_log({ msg: '⏳ 正在导出下载记录...' });

    const headers = {};
    if (window.__WX_LOCAL_TOKEN__) {
      headers['X-Local-Auth'] = window.__WX_LOCAL_TOKEN__;
    }

    const response = await fetch('/api/export/downloads?format=csv', {
      headers: headers
    });

    if (!response.ok) throw new Error('导出请求失败: ' + response.status + ' ' + response.statusText);

    const blob = await response.blob();
    const filename = `wx_channels_downloads_${new Date().toISOString().slice(0, 10)}.csv`;

    // 使用原生方式保存文件 (替代 FileSaver.js)
    if (window.navigator && window.navigator.msSaveOrOpenBlob) {
      window.navigator.msSaveOrOpenBlob(blob, filename);
    } else {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }

    __wx_log({ msg: '✅ 导出成功: ' + filename });
  } catch (e) {
    console.error('[feed.js] Export error:', e);

    var errorMsg = e.message || String(e);
    // 处理加载脚本错误的特殊对象
    if (typeof e === 'object' && e.isTrusted) {
      errorMsg = "依赖脚本加载失败 (Network Error)";
    }

    if (typeof __wx_log === 'function') {
      __wx_log({ msg: '❌ 导出失败: ' + errorMsg });
    }
    alert('导出失败: ' + errorMsg);
  }
}

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
  var app = document.querySelector('[data-v-app]') || document.getElementById('app');
  var vue = app && (app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component));
  var appContext = vue && (vue.appContext || (vue.ctx && vue.ctx.appContext));
  var globalProperties = appContext && appContext.config && appContext.config.globalProperties;
  var pinia = globalProperties && globalProperties.$pinia;

  if (!pinia || !pinia._s) {
    console.warn('[Pinia Store] 未找到 Pinia Store');
    __wx_log({ msg: '❌ 未找到 Pinia Store' });
    return;
  }

  var stores = {};
  var storeNames = [];
  pinia._s.forEach(function (store, name) {
    try {
      var state = (store.$state && JSON.parse(JSON.stringify(store.$state))) || {};
      stores[name] = state;
      storeNames.push(name);
    } catch (e) {
      stores[name] = { '__error__': e.message };
    }
  });

  console.log('[Pinia Store] 快照数据:', stores);
  __wx_log({ msg: '💾 Store快照采集中... (' + storeNames.length + '个)' });

  var page = window.__wx_current_page__ || location.pathname || '';

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
      console.log('[Pinia Store] 快照已保存:', data);
      __wx_log({ msg: '✅ Store快照已保存 (' + storeNames.length + '个: ' + storeNames.join(', ') + ')' });
    })
    .catch(function (err) {
      console.error('[Pinia Store] 保存失败:', err);
      __wx_log({ msg: '❌ Store快照保存失败: ' + err.message });
    });
}

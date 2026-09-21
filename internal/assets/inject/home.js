/**
 * @file Home页面功能模块 - 适配新版顶部四栏导航
 */
console.log('[home.js] 加载Home页面模块');

// ==================== 全局变量 ====================
var __last_slide_index__ = -1;
var __home_slide_observer__ = null;
var __home_first_load__ = true;
var __current_tab__ = 'unknown';
var __current_tab_type__ = 'unknown'; // video-player, live-list, unsupported

var __home_tab_meta__ = {
  recommend: {
    displayName: '推荐',
    type: 'video-player',
    description: '当前推荐视频'
  },
  follow: {
    displayName: '关注',
    type: 'video-player',
    description: '当前关注视频'
  },
  friend: {
    displayName: '朋友',
    type: 'video-player',
    description: '当前朋友视频'
  },
  live: {
    displayName: '直播',
    type: 'live-list',
    description: '直播列表数据采集不可用'
  },
  unknown: {
    displayName: '未知',
    type: 'unsupported',
    description: '当前区域数据采集不可用'
  }
};

// ==================== Tab检测 ====================
function __detect_current_tab() {
  // 查找所有 role="tab" 的元素
  var tabs = document.querySelectorAll('[role="tab"]');

  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    var isSelected = tab.getAttribute('aria-selected') === 'true';

    if (isSelected) {
      var text = tab.textContent.trim();
      console.log('[home.js] 找到选中的tab:', text);

      if (text === '推荐') return 'recommend';
      if (text === '关注') return 'follow';
      if (text === '朋友') return 'friend';
      if (text === '直播') return 'live';
      return 'unknown';
    }
  }

  console.log('[home.js] 无法检测当前tab');
  return 'unknown';
}

function __get_tab_type(tab) {
  var meta = __home_tab_meta__[tab] || __home_tab_meta__.unknown;
  return meta.type;
}

function __get_tab_display_name(tab) {
  var meta = __home_tab_meta__[tab] || __home_tab_meta__.unknown;
  return meta.displayName;
}

function __get_tab_description(tab) {
  var meta = __home_tab_meta__[tab] || __home_tab_meta__.unknown;
  return meta.description;
}

function __update_tab_display() {
  var newTab = __detect_current_tab();
  var newTabType = __get_tab_type(newTab);

  if (newTab !== __current_tab__) {
    __current_tab__ = newTab;
    __current_tab_type__ = newTabType;

    var displayName = __get_tab_display_name(newTab);
    var typeDesc = newTabType === 'video-player' ? '视频播放' :
      newTabType === 'live-list' ? '直播列表' : '暂不支持区域';

    console.log('[home.js] 当前tab切换为:', displayName, '类型:', typeDesc);

    // 根据tab类型更新页面工具状态

    if (displayName !== '未知') {
      __wx_log({ msg: '📍 当前模块: ' + displayName + ' - ' + __get_tab_description(newTab) });
    }
  }
}

function __try_collect_page_data() {
  // 新版顶部四栏不再维护旧分类缓存，这里保留空函数以兼容旧调用点
}

function __is_direct_video_home_page() {
  try {
    var currentUrl = new URL(window.location.href);
    if (!currentUrl.pathname.includes('/pages/home')) return false;
    var hasOidNid = !!(currentUrl.searchParams.get('oid') && currentUrl.searchParams.get('nid'));
    var hasContextId = !!currentUrl.searchParams.get('context_id');
    return hasOidNid || hasContextId;
  } catch (e) {
    try {
      return (/[?&]oid=/.test(window.location.href) && /[?&]nid=/.test(window.location.href)) ||
        /[?&]context_id=/.test(window.location.href);
    } catch (err) {
      return false;
    }
  }
}

function __should_use_feed_mode_for_home_page() {
  try {
    var currentUrl = new URL(window.location.href);
    if (!currentUrl.pathname.includes('/pages/home')) return false;

    var hasOidNid = !!(currentUrl.searchParams.get('oid') && currentUrl.searchParams.get('nid'));
    var fromSubPage = currentUrl.searchParams.get('fromSubPage') || '';
    var isFlowVideo = currentUrl.searchParams.get('tabId') === 'flow' && currentUrl.searchParams.has('feed_lab');

    return hasOidNid || fromSubPage === 'profile' || isFlowVideo;
  } catch (e) {
    return /[?&]oid=/.test(window.location.href) ||
      /[?&]fromSubPage=profile/.test(window.location.href) ||
      (/[?&]tabId=flow/.test(window.location.href) && /[?&]feed_lab=/.test(window.location.href));
  }
}

// ==================== 页面工具注入 ====================

// ==================== 幻灯片切换监听 ====================
// Home页面改为顶部工具栏按钮后，不再需要监听幻灯片切换来重新注入按钮
// 保留此函数以防需要监听其他事件
function __start_home_slide_monitor() {
  if (window.__wx_home_slide_timer__) return;

  window.__wx_home_slide_timer__ = setInterval(function () {
    if (!window.location.pathname.includes('/pages/home')) return;

    __update_tab_display();

    if (__current_tab_type__ === 'video-player') {
      __sync_home_profile_with_runtime(false);
    }
  }, 1500);
}

// ==================== Tab切换监听 ====================
function __start_tab_monitor() {
  if (window.__wx_home_tab_monitor_started__) return;
  window.__wx_home_tab_monitor_started__ = true;

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target) return;
    var tab = target.closest ? target.closest('[role="tab"]') : null;
    if (!tab) return;

    setTimeout(function () {
      __update_tab_display();
      __sync_home_profile_with_runtime(true);
    }, 80);
  }, true);

  window.addEventListener('resize', function () {
  });
}

function __get_active_home_feed_element() {
  var feedNodes = document.querySelectorAll('[id^="flow-feed-"]');
  if (!feedNodes || feedNodes.length === 0) return null;

  var viewportTop = 0;
  var viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
  var bestNode = null;
  var bestScore = -1;

  for (var i = 0; i < feedNodes.length; i++) {
    var node = feedNodes[i];
    if (!node || !node.getBoundingClientRect) continue;
    var rect = node.getBoundingClientRect();
    var visibleHeight = Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop);
    var visibleWidth = Math.min(rect.right, window.innerWidth || document.documentElement.clientWidth || 0) - Math.max(rect.left, 0);
    var score = Math.max(0, visibleHeight) * Math.max(0, visibleWidth);

    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  return bestNode;
}

function __get_active_home_feed_id() {
  var node = __get_active_home_feed_element();
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

function __is_candidate_match_active_feed(candidate, activeFeedId) {
  if (!candidate) return false;
  if (!activeFeedId) return true;

  var candidateId = candidate.id || candidate.objectId || candidate.objectNonceId || '';
  return String(candidateId) === String(activeFeedId);
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

  function walk(obj, depth) {
    if (!obj || typeof obj !== 'object') return null;
    if (seen(obj)) return null;
    if (__is_feed_candidate(obj) && __is_candidate_match_active_feed(obj, activeFeedId)) {
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

function __get_home_runtime_roots() {
  var roots = [];
  var activeFeedNode = __get_active_home_feed_element();
  var app = document.getElementById('app') || document.querySelector('[data-v-app]');

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
    console.warn('[home.js] 获取 Pinia roots 失败:', e);
  }

  return roots;
}

function __extract_profile_from_dom_fallback(activeFeedId) {
  var feedNode = __get_active_home_feed_element();
  if (!feedNode) return null;

  var descriptionNode = feedNode.querySelector('.content .ctn, .collapsed-text .ctn, .compute-node');
  var authorNode = feedNode.querySelector('.mx-auto .text-sm.font-medium.text-white, .min-w-0.flex-shrink.cursor-pointer.overflow-hidden.text-ellipsis.whitespace-nowrap.text-sm.font-medium.text-white');
  var avatarNode = feedNode.querySelector('img.rounded-full');
  var posterNode = feedNode.querySelector('.vjs-poster');
  var mediaNode = feedNode.querySelector('.feed-video video, video');
  var counts = feedNode.querySelectorAll('.op-item .op-text');

  var thumbUrl = '';
  if (posterNode && posterNode.style && posterNode.style.backgroundImage) {
    var matched = posterNode.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (matched && matched[1]) thumbUrl = matched[1];
  }

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
    url: mediaNode ? mediaNode.currentSrc || mediaNode.src || '' : '',
    spec: [],
    likeCount: counts[0] ? parseInt(counts[0].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0,
    forwardCount: counts[1] ? parseInt(counts[1].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0,
    favCount: counts[2] ? parseInt(counts[2].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0,
    commentCount: counts[3] ? parseInt(counts[3].textContent.replace(/[^\d]/g, ''), 10) || 0 : 0
  };
}

function __locate_current_home_feed() {
  var activeFeedId = __get_active_home_feed_id();
  var roots = __get_home_runtime_roots();

  for (var i = 0; i < roots.length; i++) {
    var match = __search_feed_candidate(roots[i], activeFeedId, 6, 40);
    if (match) return match;
  }

  return null;
}

var __wx_home_runtime_state = {
  lastProfileId: ''
};

function __publish_home_profile(profile, feed, reason) {
  if (!profile) return null;

  var profileId = profile.id ? String(profile.id) : '';
  if (profileId && profileId === __wx_home_runtime_state.lastProfileId) {
    if (reason) {
      console.log('[home.js] 当前首页视频未变化，跳过重复上报:', reason, profileId);
    }
    return profile;
  }

  if (feed && typeof WXU !== 'undefined' && typeof WXU.set_feed === 'function') {
    WXU.set_feed(feed);
  } else {
    if (window.__wx_channels_store__) {
      window.__wx_channels_store__.profile = profile;
    }

    fetch('/__wx_channels_api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    }).catch(function () { });

    fetch('/__wx_channels_api/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: '📹 ' + (profile.nickname || '未知作者') + ' - ' + (profile.title || '').substring(0, 30) + '...' })
    }).catch(function () { });
  }

  __wx_home_runtime_state.lastProfileId = profileId;
  if (reason) {
    console.log('[home.js] 已上报当前首页视频:', reason, profile.id, profile.title);
  }
  return profile;
}

function __get_current_home_profile() {
  var activeFeedId = __get_active_home_feed_id();
  var storeProfile = window.__wx_channels_store__ && window.__wx_channels_store__.profile;

  if (storeProfile && (!activeFeedId || String(storeProfile.id) === String(activeFeedId))) {
    return storeProfile;
  }

  var feed = __locate_current_home_feed();
  if (feed && typeof WXU !== 'undefined' && WXU.format_feed) {
    var formatted = WXU.format_feed(feed);
    if (formatted) {
      return __publish_home_profile(formatted, feed, 'runtime');
    }
  }

  var fallback = __extract_profile_from_dom_fallback(activeFeedId);
  if (fallback && fallback.url && String(fallback.url).indexOf('blob:') !== 0) {
    return __publish_home_profile(fallback, null, 'dom-fallback');
  }

  return null;
}

function __sync_home_profile_with_runtime(forceLog) {
  var profile = __get_current_home_profile();
  if (!profile) return null;

  if (forceLog) {
    console.log('[home.js] 已同步当前首页视频:', profile.id, profile.title);
  }

  return profile;
}

function __resolve_current_home_profile(retryCount, intervalMs) {
  retryCount = typeof retryCount === 'number' ? retryCount : 4;
  intervalMs = typeof intervalMs === 'number' ? intervalMs : 240;

  return new Promise(function (resolve) {
    var attempts = 0;

    function tryResolve() {
      attempts += 1;
      var profile = __sync_home_profile_with_runtime(attempts === 1);
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

// ==================== 统一按钮插入入口 ====================
async function insert_channel_tools() {
  __wx_log({ msg: "等待注入页面工具" });

  var pathname = window.location.pathname;
  console.log('[home.js] 当前页面路径:', pathname);

  // 搜索页面由 search.js 处理
  if (pathname.includes('/pages/s')) {
    console.log('[home.js] 搜索页面由 search.js 处理');
    return;
  }

  // Feed页面（视频详情页）
  if (pathname.includes('/pages/feed')) {
    console.log('[home.js] 检测到Feed页面');
    if (typeof __insert_tools_to_feed_page === 'function') {
      var success = await __insert_tools_to_feed_page();
      if (success) return;
    } else {
      console.error('[home.js] __insert_tools_to_feed_page 函数未定义');
    }
  }

  // Home页面
  if (pathname.includes('/pages/home')) {
    if (__should_use_feed_mode_for_home_page()) {
      console.log('[home.js] 检测到Home路径下的详情页模式，切换为Feed逻辑处理');
      if (typeof __insert_tools_to_feed_page === 'function') {
        var feedModeSuccess = await __insert_tools_to_feed_page();
        if (feedModeSuccess) return;
      }
    }

    console.log('[home.js] 检测到Home页面');
    __start_tab_monitor();
    __start_home_slide_monitor();
    __update_tab_display();
    __sync_home_profile_with_runtime(false);
    return;
  }

  // 其他页面尝试通用注入
  __wx_log({ msg: "没有找到操作栏，注入页面工具失败" });
}

console.log('[home.js] Home页面模块加载完成');

// ==================== 事件监听 ====================

// 监听推荐流数据加载，用于初始化当前视频
WXE.onPCFlowLoaded(function (data) {
  // 兼容旧格式 (直接返回数组) 和新格式 ({feeds: [], params: {}})
  var feeds = Array.isArray(data) ? data : (data.feeds || []);
  if (feeds && feeds.length > 0) {
    console.log('[home.js] PCFlowLoaded 收到视频流:', feeds.length);
    WXU.set_feed(feeds[0]);
  }
});

// 监听切换到下一个视频
WXE.onGotoNextFeed(function (feed) {
  console.log('[home.js] onGotoNextFeed 事件触发');
  WXU.set_cur_video();
  WXU.set_feed(feed);
});

// 监听切换到上一个视频
WXE.onGotoPrevFeed(function (feed) {
  console.log('[home.js] onGotoPrevFeed 事件触发');
  WXU.set_cur_video();
  WXU.set_feed(feed);
});

// 监听视频详情加载
WXE.onFetchFeedProfile(function (feed) {
  console.log('[home.js] onFetchFeedProfile 事件触发');
  WXU.set_cur_video();
  WXU.set_feed(feed);
});

// 监听 Feed 事件（统一处理）
WXE.onFeed(function (feed) {
  console.log('[home.js] onFeed 事件触发');
  WXU.set_feed(feed);
});

// 新增：监听搜索结果加载（如果有的话）
if (WXE.onSearchResultLoaded) {
  WXE.onSearchResultLoaded(function (data) {
    console.log('[home.js] onSearchResultLoaded 事件触发');
    console.log('[home.js] 搜索结果数据:', data);
  });
}


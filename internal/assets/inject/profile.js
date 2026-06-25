/**
 * @file Profile页面功能模块 - 事件监听和数据采集
 */

function __wx_is_profile_page__() {
  return window.location.pathname.includes('/pages/profile');
}

function __wx_is_account_like_page__() {
  return window.location.pathname.includes('/pages/account/like');
}

function __wx_is_profile_like_list_page__() {
  return __wx_is_profile_page__() || __wx_is_account_like_page__();
}

function __wx_profile_list_page_title__() {
  return __wx_is_account_like_page__() ? '赞和收藏 - 视频列表' : 'Profile - 视频列表';
}

function __wx_get_like_label_by_key__(key) {
  if (key === 'fav') return '收藏';
  if (key === 'like') return '点赞';
  if (key === 'global_fav') return '看一看';
  return '全部';
}

function __wx_get_account_like_subtab_info__() {
  if (!__wx_is_account_like_page__()) {
    return { key: 'default', label: '全部' };
  }

  var activeTab = document.querySelector('.sub-tab-item.active');
  if (!activeTab) {
    return { key: 'all', label: '全部' };
  }

  var text = (activeTab.textContent || '').trim();
  if (text) {
    return { key: text, label: text };
  }

  var iconUse = activeTab.querySelector('use');
  var href = iconUse ? (iconUse.getAttribute('xlink:href') || iconUse.getAttribute('href') || '') : '';
  if (href.indexOf('icon-account_fav') !== -1) {
    return { key: 'fav', label: '收藏' };
  }
  if (href.indexOf('icon-account_like') !== -1) {
    return { key: 'like', label: '点赞' };
  }
  if (href.indexOf('icon-account_global_fav') !== -1) {
    return { key: 'global_fav', label: '看一看' };
  }

  return { key: 'all', label: '全部' };
}

function __wx_normalize_compare_text__(text) {
  return (text || '')
    .replace(/\s+/g, '')
    .replace(/[#@].*$/g, '')
    .trim();
}

// ==================== 滚动列表并统计卡片数量 ====================

function __wx_channels_scroll_and_count_cards() {
  var SCROLL_STEP = window.innerHeight * 0.8;
  var SCROLL_INTERVAL = 1000;
  var MAX_EMPTY = 10;
  var MAX_TOTAL = 100;

  var scrollCount = 0;
  var emptyCount = 0;
  var lastCount = 0;
  var isRunning = false;
  var debugInfo = [];

  function dumpContainers() {
    var selectors = [
      { el: document.querySelector('.page-profile'), n: '.page-profile' },
      { el: document.querySelector('.page-profile > .content'), n: '.page-profile > .content' },
      { el: document.querySelector('.membership-content'), n: '.membership-content' },
      { el: document.querySelector('.membership-content__bd'), n: '.membership-content__bd' },
      { el: document.documentElement, n: 'documentElement' },
      { el: document.body, n: 'body' }
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = selectors[i].el;
      if (!el) {
        debugInfo.push(selectors[i].n + ': NOT FOUND');
        continue;
      }
      var style = window.getComputedStyle(el);
      debugInfo.push(selectors[i].n + ': overflowY=' + style.overflowY + ', scrollH=' + el.scrollHeight + ', clientH=' + el.clientHeight + ', scrollTop=' + el.scrollTop + ', tagName=' + el.tagName);
    }
  }

  function findScrollableContainer() {
    // 优先找 .page-profile > .content（视频卡片列表容器）
    var candidates = [
      document.querySelector('.page-profile > .content'),
      document.querySelector('.page-profile'),
      document.querySelector('.membership-content'),
      document.querySelector('.membership-content__bd'),
      document.documentElement,
      document.body
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    // 兜底：返回 .page-profile > .content（即使当前不可滚动）
    return document.querySelector('.page-profile > .content') || document.documentElement;
  }

  function doScroll() {
    if (isRunning) return;
    isRunning = true;
    scrollCount++;

    if (scrollCount === 1) dumpContainers();

    var scroller = findScrollableContainer();
    if (!scroller) {
      console.warn('[Profile Scroll] ❌ 未找到容器');
      isRunning = false;
      return;
    }

    var sh = scroller.scrollHeight;
    var ch = scroller.clientHeight;
    var st = scroller.scrollTop;
    var maxScroll = sh - ch;

    var info = '[Profile Scroll] #' + scrollCount + ' ' + (scroller.className || scroller.tagName) + ' sh=' + sh + ' ch=' + ch + ' st=' + st + ' max=' + maxScroll + ' cards=' + document.querySelectorAll('.card-wrp').length;
    console.log(info);
    debugInfo.push(info);

    // 强制滚动（不判断 maxScroll，因为有可能是滚动后才会加载新内容）
    var prevTop = st;
    scroller.scrollTop = st + SCROLL_STEP;

    // 兼容：同时触发 window 滚动（有些页面需要 window 滚动）
    window.scrollBy(0, SCROLL_STEP);

    // 等待 loading 消失后再检查（与 api_client.js 逻辑一致）
    // 等待 loading spinner 消失
    function waitForLoading(cb, delay) {
      var d = delay || 500;
      setTimeout(function() {
        var loading = scroller.querySelector('.loading, [class*="loading"], [class*="spinner"]');
        if (loading) {
          console.log('[Profile Scroll] 检测到 loading，等待消失...');
          var wc = 0;
          (function poll() {
            wc++;
            var again = scroller.querySelector('.loading, [class*="loading"], [class*="spinner"]');
            if (!again) {
              console.log('[Profile Scroll] loading 已消失');
              setTimeout(cb, 300);
              return;
            }
            if (wc >= 10) {
              console.log('[Profile Scroll] loading 等待超时，强制继续');
              cb();
              return;
            }
            setTimeout(poll, 1000);
          }());
        } else {
          cb();
        }
      }, d);
    }

    waitForLoading(function() {
      // 检查 infinite-scroll-disabled
      var disabled = scroller.getAttribute('infinite-scroll-disabled');
      if (disabled === 'true') {
        console.log('[Profile Scroll] infinite-scroll-disabled=true，已无更多数据');
        var currentCount = document.querySelectorAll('.card-wrp').length;
        __wx_log({ msg: '✅ 滚动完成（标签已禁用），卡片已全部加载，共 ' + currentCount + ' 个' });
        isRunning = false;
        return;
      }

      var newTop = scroller.scrollTop;
      console.log('[Profile Scroll] 滚动后 scrollTop=' + newTop + ' (期望=' + (prevTop + SCROLL_STEP) + ')');
      isRunning = false;
      checkResult();
    }, SCROLL_INTERVAL);
  }

  function checkResult() {
    var currentCount = document.querySelectorAll('.card-wrp').length;

    if (scrollCount === 1) {
      lastCount = currentCount;
      __wx_log({ msg: '🔄 滚动开始，当前卡片: ' + currentCount + ' 个' });
      if (debugInfo.length) __wx_log({ msg: '📊 ' + debugInfo.slice(0, 6).join(' | ') });
    } else {
      if (currentCount === lastCount) {
        emptyCount++;
        __wx_log({ msg: '📭 滚动 #' + scrollCount + ' 卡片不变 (' + currentCount + ')，连续 ' + emptyCount + '/' + MAX_EMPTY });
      } else {
        emptyCount = 0;
        lastCount = currentCount;
        __wx_log({ msg: '📥 滚动 #' + scrollCount + ' 加载中，当前卡片: ' + currentCount + ' 个' });
      }
    }

    if (emptyCount >= MAX_EMPTY) {
      __wx_log({ msg: '✅ 滚动完成，卡片已全部加载，共 ' + currentCount + ' 个' });
      return;
    }
    if (scrollCount >= MAX_TOTAL) {
      __wx_log({ msg: '⚠️ 滚动达到上限 ' + MAX_TOTAL + ' 次，当前卡片 ' + currentCount + ' 个' });
      return;
    }

    doScroll();
  }

  __wx_log({ msg: '🚀 开始滚动列表...' });
  doScroll();
}

// ==================== Profile页面视频列表采集器 ====================
window.__wx_channels_profile_collector = {
  videos: [],
  likeTabVideos: {},
  currentLikeTabKey: 'all',
  currentLikeTabLabel: '全部',
  likeTabFlags: {
    all: 7,
  },
  isCollecting: false,
  _lastLogMessage: '',
  _lastTipVideoCount: 0,
  _lastTipLiveReplayCount: 0,
  _maxVideos: 100000, // 最多采集100000个视频

  // 初始化
  init: function () {
    var self = this;
    this.syncCurrentLikeTab();
    // 延迟初始化UI
    setTimeout(function () {
      self.injectToolbarDownloadIcon();
    }, 2000);
    if (__wx_is_account_like_page__()) {
      this.startLikeTabMonitor();
      this.installLikeApiHook();
    }
  },

  syncCurrentLikeTab: function () {
    if (!__wx_is_account_like_page__()) return;
    var info = __wx_get_account_like_subtab_info__();
    this.currentLikeTabKey = info.key;
    this.currentLikeTabLabel = info.label;
    if (!this.likeTabVideos[this.currentLikeTabKey]) {
      this.likeTabVideos[this.currentLikeTabKey] = [];
    }
    this.videos = this.likeTabVideos[this.currentLikeTabKey];
  },

  startLikeTabMonitor: function () {
    var self = this;
    if (window.__wx_account_like_tab_monitor_started__) return;
    window.__wx_account_like_tab_monitor_started__ = true;

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target) return;
      var tab = target.closest ? target.closest('.sub-tab-item') : null;
      if (!tab) return;
      if (tab.id === 'wx-profile-download-btn') return;
      setTimeout(function () {
        self.syncCurrentLikeTab();
        if (window.__wx_batch_download_manager__ && window.__wx_batch_download_manager__.isVisible) {
          if (self.videos.length > 0) {
            var filteredVideos = self.filterLivePictureVideos(self.videos).filter(function (v) {
              return v && (v.type === 'media' || v.type === 'live_replay');
            });
            __update_batch_download_ui__(filteredVideos, '赞和收藏 - ' + self.currentLikeTabLabel);
          } else {
            __close_batch_download_ui__();
          }
        }
      }, 80);
    }, true);
  },

  resolveLikeTabKeyByFlag: function (flag) {
    var normalized = String(flag);
    var keys = Object.keys(this.likeTabFlags);
    for (var i = 0; i < keys.length; i++) {
      if (String(this.likeTabFlags[keys[i]]) === normalized) {
        return keys[i];
      }
    }
    return this.currentLikeTabKey || 'all';
  },

  installLikeApiHook: function () {
    if (!__wx_is_account_like_page__()) return;
    if (window.__wx_like_api_hook_installed__) return;

    var self = this;
    var tryInstall = function () {
      if (!WXU.API4 || typeof WXU.API4.finderGetInteractionedFeedList !== 'function') {
        return false;
      }
      if (WXU.API4.finderGetInteractionedFeedList.__wx_wrapped__) {
        window.__wx_like_api_hook_installed__ = true;
        return true;
      }

      var original = WXU.API4.finderGetInteractionedFeedList;
      var wrapped = async function (payload) {
        var response = await original.apply(this, arguments);
        try {
          var feeds = response && response.data && Array.isArray(response.data.object) ? response.data.object : [];
          var tabFlag = payload && payload.tabFlag ? payload.tabFlag : null;
          if (tabFlag != null) {
            var mappedKey = self.resolveLikeTabKeyByFlag(tabFlag);
            self.likeTabFlags[mappedKey] = tabFlag;
          }
          WXE.emit(WXE.Events.InteractionedFeedsLoaded, {
            feeds: feeds,
            tabFlag: tabFlag,
          });
        } catch (e) {
          console.warn('[Profile] 处理 interactioned list 响应失败:', e);
        }
        return response;
      };
      wrapped.__wx_wrapped__ = true;
      wrapped.__wx_original__ = original;
      WXU.API4.finderGetInteractionedFeedList = wrapped;
      window.__wx_like_api_hook_installed__ = true;
      console.log('[Profile] ✅ 已安装 account/like API4 响应监听');
      return true;
    };

    if (tryInstall()) return;

    WXE.onAPILoaded(function () {
      tryInstall();
    });
  },

  getCurrentLikeTabDOMItems: function () {
    if (!__wx_is_account_like_page__()) return [];
    return Array.prototype.slice.call(document.querySelectorAll('.card-grid .card-wrp'));
  },

  getCurrentLikeTabFirstCardTitle: function () {
    var cards = this.getCurrentLikeTabDOMItems();
    if (!cards.length) return '';
    var titleNode = cards[0].querySelector('.title');
    if (!titleNode) return '';
    var fullTitle = titleNode.getAttribute('title') || titleNode.textContent || '';
    return this.cleanHtmlTags(fullTitle);
  },

  inferLikeTabFlagFromDOM: async function () {
    if (!__wx_is_account_like_page__()) return null;
    if (this.likeTabFlags[this.currentLikeTabKey]) {
      return this.likeTabFlags[this.currentLikeTabKey];
    }

    var firstTitle = this.getCurrentLikeTabFirstCardTitle();
    var normalizedFirstTitle = __wx_normalize_compare_text__(firstTitle);
    var candidateFlags = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (var i = 0; i < candidateFlags.length; i++) {
      var flag = candidateFlags[i];
      try {
        var result = await WXU.API4.finderGetInteractionedFeedList({ lastBuffer: '', tabFlag: flag });
        var items = result && result.data && Array.isArray(result.data.object) ? result.data.object : [];
        if (!items.length) continue;

        if (!normalizedFirstTitle) {
          this.likeTabFlags[this.currentLikeTabKey] = flag;
          return flag;
        }

        var firstProfile = WXU.format_feed(items[0]);
        var fetchedTitle = this.cleanHtmlTags(firstProfile && firstProfile.title ? firstProfile.title : '');
        var normalizedFetchedTitle = __wx_normalize_compare_text__(fetchedTitle);
        var shortCurrent = normalizedFirstTitle.slice(0, 12);
        var shortFetched = normalizedFetchedTitle.slice(0, 12);

        if (
          normalizedFetchedTitle &&
          (
            normalizedFetchedTitle === normalizedFirstTitle ||
            normalizedFetchedTitle.indexOf(shortCurrent) !== -1 ||
            normalizedFirstTitle.indexOf(shortFetched) !== -1
          )
        ) {
          this.likeTabFlags[this.currentLikeTabKey] = flag;
          return flag;
        }
      } catch (e) {
        console.warn('[Profile] 推断 account/like tabFlag 失败:', flag, e);
      }
    }

    return null;
  },

  loadCurrentLikeTabVideos: async function () {
    if (!__wx_is_account_like_page__()) return [];
    this.syncCurrentLikeTab();

    if (this.likeTabVideos[this.currentLikeTabKey] && this.likeTabVideos[this.currentLikeTabKey].length > 0) {
      this.videos = this.likeTabVideos[this.currentLikeTabKey];
      return this.videos;
    }

    if (!WXU.API4 || typeof WXU.API4.finderGetInteractionedFeedList !== 'function') {
      throw new Error('页面 API4 尚未初始化');
    }

    var flag = await this.inferLikeTabFlagFromDOM();
    if (!flag) {
      throw new Error('未能识别当前标签的数据类型');
    }

    var nextMarker = '';
    var hasMore = true;
    var merged = [];
    var seen = {};

    while (hasMore) {
      var response = await WXU.API4.finderGetInteractionedFeedList({
        lastBuffer: nextMarker,
        tabFlag: flag,
      });

      if (!response || response.errCode) {
        throw new Error((response && response.errMsg) || '拉取当前标签数据失败');
      }

      var items = response && response.data && Array.isArray(response.data.object) ? response.data.object : [];
      for (var i = 0; i < items.length; i++) {
        var profile = WXU.format_feed(items[i]);
        if (!profile || !profile.id || seen[profile.id]) continue;
        seen[profile.id] = true;
        merged.push(profile);
      }

      nextMarker = response && response.data ? (response.data.lastBuffer || '') : '';
      hasMore = !!nextMarker && items.length > 0;
      if (items.length < 15) {
        hasMore = false;
      }
    }

    this.likeTabVideos[this.currentLikeTabKey] = merged;
    this.videos = merged;
    return merged;
  },

  // 在Profile页面操作区注入批量下载按钮
  injectToolbarDownloadIcon: function () {
    var self = this;

    var findActionContainer = function () {
      if (__wx_is_profile_page__()) {
        return document.querySelector('.profile-info .opr-area') ||
          document.querySelector('.opr-area.mb-6.mt-6') ||
          document.querySelector('[class*="profile-info"] [class*="opr-area"]');
      }
      if (__wx_is_account_like_page__()) {
        return document.querySelector('[data-v-3a10b0ca].flex.flex-initial.flex-shrink-0.items-center.space-x-3.pb-5') ||
          document.querySelector('.flex.flex-initial.flex-shrink-0.items-center.space-x-3.pb-5');
      }
      return null;
    };

    var tryInject = function () {
      var container = findActionContainer();
      if (!container) return false;
      if (container.querySelector('#wx-profile-download-btn')) return true;

      var button = document.createElement('button');
      button.id = 'wx-profile-download-btn';
      button.type = 'button';
      if (__wx_is_account_like_page__()) {
        button.className = 'wx-like-download-btn flex cursor-pointer items-center justify-center border-0 border-b-2 border-solid pb-0.5 pt-[5px] text-sm';
        button.style.marginLeft = '8px';
        button.style.background = 'transparent';
        button.style.color = 'inherit';
        button.style.borderColor = 'transparent';
        button.style.flexShrink = '0';
        button.style.opacity = '0.88';
        button.title = '批量下载当前列表视频';
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="mx-1 !h-4 !w-4"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 3C12.3314 3 12.6 3.26863 12.6 3.6V13.1515L15.5757 10.1757C15.8101 9.94142 16.1899 9.94142 16.4243 10.1757C16.6586 10.4101 16.6586 10.7899 16.4243 11.0243L12.4243 15.0243C12.1899 15.2586 11.8101 15.2586 11.5757 15.0243L7.57574 11.0243C7.34142 10.7899 7.34142 10.4101 7.57574 10.1757C7.81005 9.94142 8.18995 9.94142 8.42426 10.1757L11.4 13.1515V3.6C11.4 3.26863 11.6686 3 12 3ZM3.6 14.4C3.93137 14.4 4.2 14.6686 4.2 15V19.2C4.2 19.5314 4.46863 19.8 4.8 19.8H19.2C19.5314 19.8 19.8 19.5314 19.8 19.2V15C19.8 14.6686 20.0686 14.4 20.4 14.4C20.7314 14.4 21 14.6686 21 15V19.2C21 20.1941 20.1941 21 19.2 21H4.8C3.80589 21 3 20.1941 3 19.2V15C3 14.6686 3.26863 14.4 3.6 14.4Z" fill="currentColor"></path></svg><div>批量下载</div>';
        button.onmouseenter = function () {
          button.style.opacity = '1';
        };
        button.onmouseleave = function () {
          button.style.opacity = '0.88';
        };
      } else {
        button.className = 'weui-btn_default relative flex h-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sm';
        button.style.width = '96px';
        button.style.marginLeft = '8px';
        button.title = '批量下载当前账号视频';
        button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="h-4 w-4 flex-shrink-0 text-fg-0"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 3C12.3314 3 12.6 3.26863 12.6 3.6V13.1515L15.5757 10.1757C15.8101 9.94142 16.1899 9.94142 16.4243 10.1757C16.6586 10.4101 16.6586 10.7899 16.4243 11.0243L12.4243 15.0243C12.1899 15.2586 11.8101 15.2586 11.5757 15.0243L7.57574 11.0243C7.34142 10.7899 7.34142 10.4101 7.57574 10.1757C7.81005 9.94142 8.18995 9.94142 8.42426 10.1757L11.4 13.1515V3.6C11.4 3.26863 11.6686 3 12 3ZM3.6 14.4C3.93137 14.4 4.2 14.6686 4.2 15V19.2C4.2 19.5314 4.46863 19.8 4.8 19.8H19.2C19.5314 19.8 19.8 19.5314 19.8 19.2V15C19.8 14.6686 20.0686 14.4 20.4 14.4C20.7314 14.4 21 14.6686 21 15V19.2C21 20.1941 20.1941 21 19.2 21H4.8C3.80589 21 3 20.1941 3 19.2V15C3 14.6686 3.26863 14.4 3.6 14.4Z" fill="currentColor"></path></svg><div class="ml-1 min-w-0 flex-shrink-0 whitespace-nowrap text-fg-0">批量下载</div>';
      }

      // 点击事件 - 显示/隐藏批量下载面板
      button.onclick = async function () {
        // 使用通用批量下载组件
        if (window.__wx_batch_download_manager__ && window.__wx_batch_download_manager__.isVisible) {
          __close_batch_download_ui__();
        } else {
          if (__wx_is_account_like_page__()) {
            try {
              __wx_log({ msg: '⏳ 正在加载「' + self.currentLikeTabLabel + '」数据...' });
              await self.loadCurrentLikeTabVideos();
            } catch (e) {
              __wx_log({ msg: '❌ ' + (e.message || e) });
              return;
            }
          }

          // 显示批量下载UI（包含视频和直播回放，排除正在直播）
          var filteredVideos = self.filterLivePictureVideos(self.videos).filter(function (v) {
            return v && (v.type === 'media' || v.type === 'live_replay');
          });

          if (filteredVideos.length === 0) {
            __wx_log({ msg: '⚠️ 暂无视频数据' });
            return;
          }

          var title = __wx_is_account_like_page__()
            ? ('赞和收藏 - ' + self.currentLikeTabLabel)
            : __wx_profile_list_page_title__();
          __show_batch_download_ui__(filteredVideos, title);
        }
      };

      if (__wx_is_account_like_page__()) {
        container.appendChild(button);
      } else {
        var shopWrapper = container.querySelector('.shop-btn__wrp');
        if (shopWrapper && shopWrapper.parentNode === container) {
          container.insertBefore(button, shopWrapper);
        } else {
          container.appendChild(button);
        }
      }

      // 检查是否已有 DOM 按钮
      if (container.querySelector('#wx-profile-dom-btn')) {
        console.log('[Profile] ✅ DOM 按钮已存在');
        return true;
      }

      // 创建获取 DOM 按钮
      var domButton = document.createElement('button');
      domButton.id = 'wx-profile-dom-btn';
      domButton.type = 'button';

      if (__wx_is_account_like_page__()) {
        domButton.className = 'wx-like-download-btn flex cursor-pointer items-center justify-center border-0 border-b-2 border-solid pb-0.5 pt-[5px] text-sm';
        domButton.style.marginLeft = '8px';
        domButton.style.background = 'transparent';
        domButton.style.color = 'inherit';
        domButton.style.borderColor = 'transparent';
        domButton.style.flexShrink = '0';
        domButton.style.opacity = '0.88';
        domButton.title = '获取当前页面 DOM';
        domButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="mx-1 !h-4 !w-4"><path d="M9 9h6M9 12h6M9 15h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/></svg><div>11获取DOM</div>';
        domButton.onmouseenter = function () {
          domButton.style.opacity = '1';
        };
        domButton.onmouseleave = function () {
          domButton.style.opacity = '0.88';
        };
      } else {
        domButton.className = 'weui-btn_default relative flex h-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sm';
        domButton.style.width = '80px';
        domButton.style.marginLeft = '8px';
        domButton.title = '获取当前页面 DOM';
        domButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="h-4 w-4 flex-shrink-0 text-fg-0"><path d="M9 9h6M9 12h6M9 15h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/></svg><div class="ml-1 min-w-0 flex-shrink-0 whitespace-nowrap text-fg-0">11获取DOM</div>';
      }

      // 点击事件 - 下载 DOM
      domButton.onclick = function () {
        try {
          // 获取完整 HTML
          var pageHTML = document.documentElement.outerHTML;

          // 创建 Blob 对象
          var blob = new Blob([pageHTML], { type: 'text/plain;charset=utf-8' });

          // 创建下载链接
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;

          // 生成文件名
          var pageTitle = document.title || 'page';
          pageTitle = pageTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
          var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

          // 添加页面标识
          var pageType = __wx_is_account_like_page__() ? 'like' : 'profile';
          a.download = pageTitle + '_' + pageType + '_dom_' + timestamp + '.txt';

          // 触发下载
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          __wx_log({ msg: 'DOM已下载: ' + a.download });
          console.log('[profile.js] DOM已下载:', a.download);
        } catch (e) {
          console.error('[profile.js] 获取DOM失败:', e);
          __wx_log({ msg: '获取DOM失败: ' + e.message });
        }
      };

      // ===== 滚动列表按钮 =====
      if (container.querySelector('#wx-profile-scroll-btn')) {
        console.log('[Profile] 滚动列表按钮已存在');
      } else {
        var scrollButton = document.createElement('button');
        scrollButton.id = 'wx-profile-scroll-btn';
        scrollButton.type = 'button';

        if (__wx_is_account_like_page__()) {
          scrollButton.className = 'wx-like-download-btn flex cursor-pointer items-center justify-center border-0 border-b-2 border-solid pb-0.5 pt-[5px] text-sm';
          scrollButton.style.marginLeft = '8px';
          scrollButton.style.background = 'transparent';
          scrollButton.style.color = 'inherit';
          scrollButton.style.borderColor = 'transparent';
          scrollButton.style.flexShrink = '0';
          scrollButton.style.opacity = '0.88';
          scrollButton.title = '滚动并采集卡片列表';
          scrollButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="mx-1 !h-4 !w-4"><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><div>滚动列表</div>';
          scrollButton.onmouseenter = function () {
            scrollButton.style.opacity = '1';
          };
          scrollButton.onmouseleave = function () {
            scrollButton.style.opacity = '0.88';
          };
        } else {
          scrollButton.className = 'weui-btn_default relative flex h-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sm';
          scrollButton.style.width = '88px';
          scrollButton.style.marginLeft = '8px';
          scrollButton.title = '滚动并采集卡片列表';
          scrollButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="h-4 w-4 flex-shrink-0 text-fg-0"><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="ml-1 min-w-0 flex-shrink-0 whitespace-nowrap text-fg-0">滚动列表</div>';
        }

        scrollButton.onclick = function () {
          __wx_channels_scroll_and_count_cards();
        };

        if (__wx_is_account_like_page__()) {
          container.appendChild(scrollButton);
        } else {
          var shopWrapperScroll = container.querySelector('.shop-btn__wrp');
          if (shopWrapperScroll && shopWrapperScroll.parentNode === container) {
            container.insertBefore(scrollButton, shopWrapperScroll);
          } else {
            container.appendChild(scrollButton);
          }
        }

        console.log('[Profile] 滚动列表按钮已注入到操作区');
      }

      // 在批量下载按钮之后添加 DOM 按钮
      if (__wx_is_account_like_page__()) {
        container.appendChild(domButton);
      } else {
        var shopWrapperDom = container.querySelector('.shop-btn__wrp');
        if (shopWrapperDom && shopWrapperDom.parentNode === container) {
          container.insertBefore(domButton, shopWrapperDom);
        } else {
          container.appendChild(domButton);
        }
      }

      console.log('[Profile] ✅ DOM 按钮已注入到操作区');

      // ===== 复制链接按钮 =====
      if (container.querySelector('#wx-profile-copy-link-btn')) {
        console.log('[Profile] ✅ 复制链接按钮已存在');
      } else {
        var copyLinkButton = document.createElement('button');
        copyLinkButton.id = 'wx-profile-copy-link-btn';
        copyLinkButton.type = 'button';

        if (__wx_is_account_like_page__()) {
          copyLinkButton.className = 'wx-like-download-btn flex cursor-pointer items-center justify-center border-0 border-b-2 border-solid pb-0.5 pt-[5px] text-sm';
          copyLinkButton.style.marginLeft = '8px';
          copyLinkButton.style.background = 'transparent';
          copyLinkButton.style.color = 'inherit';
          copyLinkButton.style.borderColor = 'transparent';
          copyLinkButton.style.flexShrink = '0';
          copyLinkButton.style.opacity = '0.88';
          copyLinkButton.title = '主页链接';
          copyLinkButton.textContent = '复制链接';
          copyLinkButton.onmouseenter = function () {
            copyLinkButton.style.opacity = '1';
          };
          copyLinkButton.onmouseleave = function () {
            copyLinkButton.style.opacity = '0.88';
          };
        } else {
          copyLinkButton.className = 'weui-btn_default relative flex h-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sm';
          copyLinkButton.style.width = '80px';
          copyLinkButton.style.marginLeft = '8px';
          copyLinkButton.title = '主页链接';
          copyLinkButton.textContent = '复制链接';
        }

        copyLinkButton.onclick = function () {
          var profileUrl = window.location.origin + '/web/pages/profile?username=' + (new URL(window.location.href).searchParams.get('username') || '');
          console.log('[Profile] 复制链接:', profileUrl);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            console.log('[Profile] 使用 clipboard API 复制');
            navigator.clipboard.writeText(profileUrl).then(function () {
              console.log('[Profile] clipboard API 复制成功');
              __wx_log({ msg: '已复制: ' + profileUrl });
              __show_copy_toast('已复制: ' + profileUrl);
            }).catch(function (e) {
              console.log('[Profile] clipboard API 失败，降级:', e);
              __fallback_copy(profileUrl);
            });
          } else {
            console.log('[Profile] clipboard API 不可用，使用降级方案');
            __fallback_copy(profileUrl);
          }
        };

        function __show_copy_toast(msg) {
          var existing = document.getElementById('wx-profile-copy-toast');
          if (existing) existing.remove();
          var toast = document.createElement('div');
          toast.id = 'wx-profile-copy-toast';
          toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(0,0,0,0.8);color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;max-width:90%;word-break:break-all;';
          toast.textContent = msg;
          document.body.appendChild(toast);
          setTimeout(function () {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.5s';
            setTimeout(function () { toast.remove(); }, 500);
          }, 3000);
        }

        function __fallback_copy(text) {
          var textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(textArea);
          textArea.select();
          try {
            document.execCommand('copy');
            __wx_log({ msg: '已复制: ' + text });
            __show_copy_toast('已复制: ' + text);
          } catch (err) {
            __wx_log({ msg: '复制失败，请手动复制' });
            __show_copy_toast('复制失败，请手动复制');
          }
          document.body.removeChild(textArea);
        }

        if (__wx_is_account_like_page__()) {
          container.appendChild(copyLinkButton);
        } else {
          var shopWrapperCopy = container.querySelector('.shop-btn__wrp');
          if (shopWrapperCopy && shopWrapperCopy.parentNode === container) {
            container.insertBefore(copyLinkButton, shopWrapperCopy);
          } else {
            container.appendChild(copyLinkButton);
          }
        }

        console.log('[Profile] ✅ 复制链接按钮已注入到操作区');
      }

      // ===== 关闭页面按钮 =====
      if (container.querySelector('#wx-profile-close-btn')) {
        console.log('[Profile] ✅ 关闭页面按钮已存在');
        return true;
      }

      var closeButton = document.createElement('button');
      closeButton.id = 'wx-profile-close-btn';
      closeButton.type = 'button';

      if (__wx_is_account_like_page__()) {
        closeButton.className = 'wx-like-download-btn flex cursor-pointer items-center justify-center border-0 border-b-2 border-solid pb-0.5 pt-[5px] text-sm';
        closeButton.style.marginLeft = '8px';
        closeButton.style.background = 'transparent';
        closeButton.style.color = 'inherit';
        closeButton.style.borderColor = 'transparent';
        closeButton.style.flexShrink = '0';
        closeButton.style.opacity = '0.88';
        closeButton.title = '关闭当前页面';
        closeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="mx-1 !h-4 !w-4"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><div>关闭</div>';
        closeButton.onmouseenter = function () {
          closeButton.style.opacity = '1';
        };
        closeButton.onmouseleave = function () {
          closeButton.style.opacity = '0.88';
        };
      } else {
        closeButton.className = 'weui-btn_default relative flex h-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-sm';
        closeButton.style.width = '72px';
        closeButton.style.marginLeft = '8px';
        closeButton.title = '关闭当前页面';
        closeButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" class="h-4 w-4 flex-shrink-0 text-fg-0"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><div class="ml-1 min-w-0 flex-shrink-0 whitespace-nowrap text-fg-0">关闭</div>';
      }

      closeButton.onclick = function () {
        __close_page__();
      };

      // 插入到 DOM 按钮之后
      if (__wx_is_account_like_page__()) {
        container.appendChild(closeButton);
      } else {
        var shopWrapperClose = container.querySelector('.shop-btn__wrp');
        if (shopWrapperClose && shopWrapperClose.parentNode === container) {
          container.insertBefore(closeButton, shopWrapperClose);
        } else {
          container.appendChild(closeButton);
        }
      }

      console.log('[Profile] ✅ 关闭页面按钮已注入到操作区');
      return true;
    };

    if (tryInject()) return;

    var observer = new MutationObserver(function (mutations, obs) {
      if (tryInject()) { obs.disconnect(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 5000);
  },

  // 过滤掉正在直播的图片类型数据
  filterLivePictureVideos: function (videos) {
    return (videos || []).filter(function (v) {
      if (v.type === 'picture' && v.contact && v.contact.liveStatus === 1) {
        return false;
      }
      return true;
    });
  },

  // 清理HTML标签
  cleanHtmlTags: function (text) {
    if (!text || typeof text !== 'string') return text || '';
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    var cleaned = tempDiv.textContent || tempDiv.innerText || '';
    return cleaned.trim();
  },

  // 从API添加单个视频
  addVideoFromAPI: function (videoData) {
    if (!videoData || !videoData.id) return;

    // 过滤掉正在直播的图片类型数据
    if (videoData.type === 'picture' && videoData.contact && videoData.contact.liveStatus === 1) {
      return;
    }

    if (__wx_is_account_like_page__()) {
      this.syncCurrentLikeTab();
    }

    var targetVideos = this.videos;
    if (__wx_is_account_like_page__()) {
      if (!this.likeTabVideos[this.currentLikeTabKey]) {
        this.likeTabVideos[this.currentLikeTabKey] = [];
      }
      targetVideos = this.likeTabVideos[this.currentLikeTabKey];
      this.videos = targetVideos;
    }

    // 限制最多300个视频
    if (targetVideos.length >= this._maxVideos) {
      if (targetVideos.length === this._maxVideos) {
        __wx_log({ msg: '⚠️ [Profile] 已达到最大采集数量 ' + this._maxVideos + ' 个' });
      }
      return;
    }

    // 清理标题
    if (videoData.title) {
      videoData.title = this.cleanHtmlTags(videoData.title);
    }

    // 检查是否已存在
    var exists = targetVideos.some(function (v) { return v.id === videoData.id; });
    if (!exists) {
      targetVideos.push(videoData);
      console.log('[Profile] 新增视频:', (videoData.title || '').substring(0, 30));

      // 每10个视频发送一次日志
      var filteredVideos = this.filterLivePictureVideos(targetVideos);
      var videoCount = filteredVideos.filter(function (v) { return v && v.type === 'media'; }).length;
      var liveReplayCount = filteredVideos.filter(function (v) { return v && v.type === 'live_replay'; }).length;

      if (videoCount > 0 && videoCount % 10 === 0 && videoCount !== this._lastTipVideoCount) {
        this._lastTipVideoCount = videoCount;
        var msg = '📊 [Profile] 已采集 ' + videoCount + ' 个视频';
        if (liveReplayCount > 0) msg += ', ' + liveReplayCount + ' 个直播回放';
        __wx_log({ msg: msg });
      }

      // 更新UI（使用通用批量下载组件，包含视频和直播回放）
      if (window.__wx_batch_download_manager__ && window.__wx_batch_download_manager__.isVisible) {
        var filteredVideos = this.filterLivePictureVideos(targetVideos).filter(function (v) {
          return v && (v.type === 'media' || v.type === 'live_replay');
        });
        var title = __wx_is_account_like_page__()
          ? ('赞和收藏 - ' + this.currentLikeTabLabel)
          : __wx_profile_list_page_title__();
        __update_batch_download_ui__(filteredVideos, title);
      }
    }
  }
};

// ==================== 事件监听 ====================

// 监听用户视频列表加载
WXE.onUserFeedsLoaded(function (feeds) {
  console.log('[Profile] onUserFeedsLoaded 事件触发，feeds:', feeds);

  if (!feeds || !Array.isArray(feeds)) {
    console.warn('[Profile] feeds 不是数组或为空');
    return;
  }

  var isListPage = __wx_is_profile_like_list_page__();
  console.log('[Profile] 是否是列表页:', isListPage, '当前路径:', window.location.pathname);
  if (!isListPage) return;

  console.log('[Profile] 开始处理', feeds.length, '个视频');

  var processedCount = 0;
  feeds.forEach(function (item) {
    if (!item || !item.objectDesc) {
      console.warn('[Profile] 跳过无效项:', item);
      return;
    }

    var media = item.objectDesc.media && item.objectDesc.media[0];
    if (!media) {
      console.warn('[Profile] 跳过无media的项:', item);
      return;
    }

    // 使用 WXU.format_feed 格式化数据
    var profile = WXU.format_feed(item);
    if (!profile) {
      console.warn('[Profile] format_feed 返回 null:', item);
      return;
    }

    // 传递给 collector
    window.__wx_channels_profile_collector.addVideoFromAPI(profile);
    processedCount++;
  });

  console.log('[Profile] 成功处理', processedCount, '个视频');
});

// 监听直播回放列表加载
WXE.onUserLiveReplayLoaded(function (feeds) {
  if (!feeds || !Array.isArray(feeds)) return;

  if (!__wx_is_profile_page__()) return;

  __wx_log({ msg: '📺 [Profile] 获取到直播回放列表，数量: ' + feeds.length });

  feeds.forEach(function (item) {
    if (!item || !item.objectDesc) return;

    var media = item.objectDesc.media && item.objectDesc.media[0];
    var liveInfo = item.liveInfo || {};

    // 获取时长
    var duration = 0;
    if (media && media.spec && media.spec.length > 0 && media.spec[0].durationMs) {
      duration = media.spec[0].durationMs;
    } else if (liveInfo.duration) {
      duration = liveInfo.duration;
    }

    // 构建直播回放数据
    var profile = {
      type: "live_replay",
      id: item.id,
      nonce_id: item.objectNonceId,
      title: window.__wx_channels_profile_collector.cleanHtmlTags(item.objectDesc.description || ''),
      coverUrl: media ? (media.thumbUrl || media.coverUrl || '') : '',
      thumbUrl: media ? (media.thumbUrl || '') : '',
      url: media ? (media.url + (media.urlToken || '')) : '',
      size: media ? (media.fileSize || 0) : 0,
      key: media ? (media.decodeKey || '') : '',
      duration: duration,
      spec: media ? media.spec : [],
      nickname: item.contact ? item.contact.nickname : '',
      contact: item.contact || {},
      createtime: item.createtime || 0,
      liveInfo: liveInfo
    };

    // 传递给 collector
    window.__wx_channels_profile_collector.addVideoFromAPI(profile);
  });

  __wx_log({ msg: '✅ [Profile] 直播回放列表采集完成，共 ' + feeds.length + ' 个' });
});

// 监听赞和收藏/喜欢列表加载
WXE.onInteractionedFeedsLoaded(function (payload) {
  var feeds = Array.isArray(payload) ? payload : (payload && payload.feeds ? payload.feeds : []);
  var tabFlag = payload && payload.tabFlag != null ? payload.tabFlag : null;
  console.log('[Profile] onInteractionedFeedsLoaded 事件触发，feeds:', feeds, 'tabFlag:', tabFlag);

  if (!__wx_is_account_like_page__()) return;
  if (!feeds || !Array.isArray(feeds)) {
    console.warn('[Profile] interactioned feeds 不是数组或为空');
    return;
  }

  var collector = window.__wx_channels_profile_collector;
  var originalKey = collector.currentLikeTabKey;
  var originalLabel = collector.currentLikeTabLabel;
  if (tabFlag != null) {
    var mappedKey = collector.resolveLikeTabKeyByFlag(tabFlag);
    collector.likeTabFlags[mappedKey] = tabFlag;
    collector.currentLikeTabKey = mappedKey;
    collector.currentLikeTabLabel = __wx_get_like_label_by_key__(mappedKey);
    if (!collector.likeTabVideos[mappedKey]) {
      collector.likeTabVideos[mappedKey] = [];
    }
    collector.videos = collector.likeTabVideos[mappedKey];
  } else {
    collector.syncCurrentLikeTab();
  }

  var processedCount = 0;
  feeds.forEach(function (item) {
    var profile = WXU.format_feed(item);
    if (!profile) return;
    collector.addVideoFromAPI(profile);
    processedCount++;
  });

  collector.currentLikeTabKey = originalKey;
  collector.currentLikeTabLabel = originalLabel;
  if (collector.likeTabVideos[originalKey]) {
    collector.videos = collector.likeTabVideos[originalKey];
  }

  console.log('[Profile] 成功处理', processedCount, '个赞和收藏视频');
});

// ==================== 关闭页面 ====================
function __close_page__() {
  try {
    window.close();
  } catch (e) {}
}

// ==================== 初始化 ====================

// 检查是否是列表页
function is_profile_page() {
  return __wx_is_profile_like_list_page__();
}

// 页面加载后初始化
if (is_profile_page()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.__wx_channels_profile_collector.init();
      // 加载 DOM 操作模块
      loadDomModules();
    });
  } else {
    window.__wx_channels_profile_collector.init();
    loadDomModules();
  }
}

// 加载 DOM 操作模块
function loadDomModules() {
  // 延迟加载，确保 api_client 已就绪
  setTimeout(function() {
    console.log('[Profile] 加载 DOM 操作模块...');

    // 加载 DOM 解析器
    if (!window.__wx_dom_parser__) {
      var parserScript = document.createElement('script');
      parserScript.src = '/__wx_channels_internal__/dom_parser.js';
      parserScript.onload = function() {
        console.log('[Profile] DOM 解析器加载完成');
      };
      document.head.appendChild(parserScript);
    }

    // 加载 DOM 操作器
    if (!window.__wx_dom_operator__) {
      var operatorScript = document.createElement('script');
      operatorScript.src = '/__wx_channels_internal__/dom_operator.js';
      operatorScript.onload = function() {
        console.log('[Profile] DOM 操作器加载完成');
      };
      document.head.appendChild(operatorScript);
    }
  }, 3000);
}

// ============================================================
// 暴露全局函数，供 api_client.js 通过 WebSocket 广播指令调用
// ============================================================
window.__wx_channels_scroll_and_count_cards = __wx_channels_scroll_and_count_cards;

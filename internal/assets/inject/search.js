/**
 * @file 搜索页面功能模块 - 事件监听和数据采集
 */
console.log('[search.js] 加载搜索页面模块');

// ==================== 搜索页面数据采集器 ====================
window.__wx_channels_search_collector = {
  feeds: [], // 动态（视频）
  _selectedItems: {}, // 选中的项目 {id: true}
  _currentPage: 1,
  _pageSize: 50,
  _maxItems: 100000,
  _processing: false, // 防止并发处理
  _lastProcessTime: 0, // 上次处理时间
  _processDelay: 100, // 处理延迟（毫秒）

  // 滚动加载状态
  _scrollLoading: false,
  _scrollCount: 0,
  _maxScrollCount: 200,
  _noMoreData: false,
  _lastFeedCount: 0,
  _stableCount: 0, // 连续计数不变次数
  _scrollTimer: null,

  // 滚动状态重置
  resetScrollState: function () {
    this._scrollLoading = false;
    this._scrollCount = 0;
    this._noMoreData = false;
    this._lastFeedCount = 0;
    this._stableCount = 0;
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }
  },

  // 初始化
  init: function () {
    var self = this;
    setTimeout(function () {
      self.injectToolbarIcon();
    }, 2000);
    // 自动恢复监听中的任务（搜索页加载后主动查询并恢复）
    this.checkAndRecoverListeningTasks();
  },

  // 检查并自动恢复 listening 状态的任务
  checkAndRecoverListeningTasks: function () {
    var self = this;
    var searchParams = new URLSearchParams(window.location.search);
    var keyword = searchParams.get('q') || '';

    if (!keyword || keyword.length < 2) {
      return;
    }

    var baseURL = window.location.origin;
    var url = baseURL + '/api/v1/tasks/search?keyword=' + encodeURIComponent(keyword);

    console.log('[任务采集] 检查 listening 任务, keyword:', keyword);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var tasks = JSON.parse(xhr.responseText);
          console.log('[任务采集] 获取到 listening 任务:', tasks);

          if (tasks && tasks.length > 0) {
            // 恢复最新的 listening 任务
            var task = tasks[0];
            console.log('[任务采集] 自动恢复 listening 任务:', task.task_id);
            self._recoverTask(task);
          } else {
            console.log('[任务采集] 没有找到 listening 任务，不做恢复');
          }
        } catch (e) {
          console.error('[任务采集] 解析 listening 任务响应失败:', e);
        }
      } else {
        console.warn('[任务采集] 查询 listening 任务失败, status:', xhr.status);
      }
    };

    xhr.onerror = function () {
      console.error('[任务采集] 查询 listening 任务网络错误');
    };

    xhr.send();
  },

    // 恢复任务（从 listening 状态，等待 start_scroll 指令）
  _recoverTask: function (task) {
    console.log('[任务采集] 恢复任务:', task.task_id, '| keyword:', task.keyword, '| target:', task.target_count);

    this._currentTask = {
      task_id: task.task_id,
      keyword: task.keyword,
      target_count: task.target_count || 100,
      task_type: task.task_type || 'search_keyword_videocontact',
      start_time: Date.now()
    };

    // 已有视频数据要恢复
    if (task.current_count > 0) {
      console.log('[任务采集] 恢复已有 ' + task.current_count + ' 条视频数据');
      // TODO: 如果需要恢复视频列表，后端可以返回 video_list
    }

    this._matchedVideos = [];
    this._isWatching = true;
    this._isScrolling = false;

    // 【关键修改】不再自动开始滚动，只初始化状态
    // 等待后端发送 start_scroll 指令才真正开始滚动
    // 这是因为 RPA 流程中，watchVideo 可能在页面加载前就触发了
    // 需要确保滚动指令由外部程序控制
    console.log('[任务采集] 任务已恢复，正在监听视频，等待 start_scroll 指令...');
  },

  // 从API添加搜索结果
  addSearchResult: function (data) {
    if (!data) return;

    // 防抖：如果正在处理或距离上次处理时间太短，则延迟处理
    var now = Date.now();
    if (this._processing || (now - this._lastProcessTime) < this._processDelay) {
      return;
    }

    this._processing = true;
    this._lastProcessTime = now;

    var startTime = Date.now();
    var initialCount = this.feeds.length;

    // 处理动态（视频）- objectList
    if (data.feeds && Array.isArray(data.feeds)) {
      data.feeds.forEach(function (feed) {
        var feedId = feed.id;
        if (feed && feedId && !this.feeds.find(function (f) { return f.id === feedId; })) {
          if (this.feeds.length < this._maxItems) {
            // 使用 WXU.format_feed 格式化数据（与其他页面统一）
            var formatted = WXU.format_feed(feed);

            // 添加视频和直播数据（保留直播数据显示，但暂时不能下载）
            if (formatted && (formatted.type === 'media' || formatted.type === 'live')) {
              this.feeds.push(formatted);
              // 只有视频类型才默认选中
              if (formatted.type === 'media') {
                this._selectedItems[feedId] = true;
              }
            }
          }
        }
      }, this);
    }

    var newCount = this.feeds.length;
    var addedCount = newCount - initialCount;

    // 只在有新数据时才更新UI和打印日志
    if (addedCount > 0) {
      // 如果通用批量下载UI已打开，更新它（包含所有数据：视频和直播）
      if (window.__wx_batch_download_manager__ && window.__wx_batch_download_manager__.isVisible) {
        __update_batch_download_ui__(this.feeds, '搜索结果');
      }

      var elapsed = Date.now() - startTime;

      // 统计视频和直播数量
      var videoCount = this.feeds.filter(function (f) { return f.type === 'media'; }).length;
      var liveCount = this.feeds.filter(function (f) { return f.type === 'live'; }).length;

      // 打印出视频数据
      // __wx_log({ msg: '视频数据: ' + JSON.stringify(this.feeds[0]) });
      console.log('[搜索] 新增 ' + addedCount + ' 条数据，总计: ' + videoCount + ' 个视频' + (liveCount > 0 ? ', ' + liveCount + ' 个直播' : '') + ' (耗时: ' + elapsed + 'ms)');

      // 只在整十数时打印到后台日志
      if (newCount % 50 === 0) {
        var msg = '📊 [搜索] 已采集 ' + videoCount + ' 个视频';
        if (liveCount > 0) msg += ', ' + liveCount + ' 个直播';
        __wx_log({ msg: msg });
      }
    }

    this._processing = false;
  },

  // 在工具栏注入图标
  injectToolbarIcon: function () {
    var self = this;
    var findIconContainer = function () {
      var container = document.querySelector('div[data-v-bf57a568].flex.items-center');
      if (container) return container;
      var parent = document.querySelector('div.flex-initial.flex-shrink-0.pl-6');
      if (parent) {
        container = parent.querySelector('.flex.items-center');
        if (container) return container;
      }
      return null;
    };

    var tryInject = function () {
      var container = findIconContainer();
      if (!container) return false;
      if (container.querySelector('#wx-search-download-icon')) return true;
      if (container.querySelector('#wx-search-more-icon')) return true;

      // 获取DOM按钮
      var domIconWrapper = document.createElement('div');
      domIconWrapper.id = 'wx-search-dom-icon';
      domIconWrapper.className = 'mr-4 h-6 w-6 flex-initial flex-shrink-0 text-fg-0 cursor-pointer';
      domIconWrapper.title = '获取DOM';
      domIconWrapper.innerHTML = '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 9h6M9 12h6M9 15h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>';

      domIconWrapper.style.display = 'none';
      domIconWrapper.onclick = function () {
        try {
          var pageHTML = document.documentElement.outerHTML;
          var blob = new Blob([pageHTML], { type: 'text/plain;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          var pageTitle = document.title || 'page';
          pageTitle = pageTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
          var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
          a.download = pageTitle + '_dom_' + timestamp + '.txt';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          __wx_log({ msg: 'DOM已下载: ' + a.download });
          console.log('[搜索] DOM已下载:', a.download);
        } catch (e) {
          console.error('[搜索] 获取DOM失败:', e);
          __wx_log({ msg: '获取DOM失败: ' + e.message });
        }
      };

      // 下载按钮
      var iconWrapper = document.createElement('div');
      iconWrapper.id = 'wx-search-download-icon';
      iconWrapper.className = 'mr-4 h-6 w-6 flex-initial flex-shrink-0 text-fg-0 cursor-pointer';
      iconWrapper.title = '搜索结果采集';
      iconWrapper.innerHTML = '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 3C12.3314 3 12.6 3.26863 12.6 3.6V13.1515L15.5757 10.1757C15.8101 9.94142 16.1899 9.94142 16.4243 10.1757C16.6586 10.4101 16.6586 10.7899 16.4243 11.0243L12.4243 15.0243C12.1899 15.2586 11.8101 15.2586 11.5757 15.0243L7.57574 11.0243C7.34142 10.7899 7.34142 10.4101 7.57574 10.1757C7.81005 9.94142 8.18995 9.94142 8.42426 10.1757L11.4 13.1515V3.6C11.4 3.26863 11.6686 3 12 3ZM3.6 14.4C3.93137 14.4 4.2 14.6686 4.2 15V19.2C4.2 19.5314 4.46863 19.8 4.8 19.8H19.2C19.5314 19.8 19.8 19.5314 19.8 19.2V15C19.8 14.6686 20.0686 14.4 20.4 14.4C20.7314 14.4 21 14.6686 21 15V19.2C21 20.1941 20.1941 21 19.2 21H4.8C3.80589 21 3 20.1941 3 19.2V15C3 14.6686 3.26863 14.4 3.6 14.4Z" fill="currentColor"></path></svg>';
      iconWrapper.style.display = 'none';
      iconWrapper.onclick = function () {
        // 使用通用批量下载组件
        if (window.__wx_batch_download_manager__ && window.__wx_batch_download_manager__.isVisible) {
          __close_batch_download_ui__();
        } else {
          // 显示批量下载UI（包含所有数据：视频和直播）
          if (self.feeds.length === 0) {
            __wx_log({ msg: '⚠️ 暂无搜索结果' });
            return;
          }

          __show_batch_download_ui__(self.feeds, '搜索结果');
        }
      };

      // 获取更多视频按钮
      var moreIconWrapper = document.createElement('div');
      moreIconWrapper.id = 'wx-search-more-icon';
      moreIconWrapper.className = 'mr-4 h-6 w-6 flex-initial flex-shrink-0 text-fg-0 cursor-pointer';
      moreIconWrapper.title = '获取更多视频';
      moreIconWrapper.innerHTML = '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12l7 7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
      moreIconWrapper.style.display = 'none';
      moreIconWrapper.onclick = function () {
        self.triggerScrollAndCollect();
      };

      container.insertBefore(iconWrapper, container.firstChild);
      container.insertBefore(moreIconWrapper, container.firstChild);
      container.insertBefore(domIconWrapper, container.firstChild);
      console.log('[搜索] ✅ 下载图标已注入到工具栏');
      return true;
    };

    if (tryInject()) return;
    var observer = new MutationObserver(function (_mutations, obs) {
      if (tryInject()) { obs.disconnect(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 5000);
  },

  // 触发滚动加载更多视频
  triggerScrollAndCollect: function () {
    var self = this;

    // 如果正在加载中，直接返回
    if (this._scrollLoading) {
      __wx_log({ msg: '⏳ 正在加载中，请稍候...' });
      return;
    }

    // 找到搜索结果页面的滚动容器
    var scrollContainer = document.querySelector('[data-v-3932dd4a].search-result-page');
    if (!scrollContainer) {
      console.error('[搜索] 未找到滚动容器 .search-result-page');
      __wx_log({ msg: '❌ 未找到滚动容器' });
      return;
    }

    // 重置状态
    this.resetScrollState();
    this._scrollLoading = true;

    // 保存初始数量
    var startCount = this.feeds.length;
    __wx_log({ msg: '🔄 开始滚动加载，当前已有 ' + startCount + ' 个视频...' });
    console.log('[搜索] 开始滚动加载，当前已有 ' + startCount + ' 个视频');

    // 更新按钮状态为加载中
    this._updateMoreButton('loading', 0);

    // 递归滚动函数
    var scrollOnce = function () {
      // 如果没有更多标记已设置，不再滚动
      if (self._noMoreData) {
        return;
      }

      // 检查 infinite-scroll-disabled 属性（Vue infinite-scroll 组件设置）
      var disabled = scrollContainer.getAttribute('infinite-scroll-disabled');
      var loadingNode = scrollContainer.querySelector('.loading, [class*="loading"], [class*="spinner"]');
      console.log('[搜索] scroll #' + (self._scrollCount + 1) + ' | disabled: ' + disabled + ' | loading节点: ' + (loadingNode ? '存在' : '不存在'));

      // disabled=true 且没有 loading 节点 → 已无更多
      if (disabled === 'true' && !loadingNode) {
        console.log('[搜索] disabled=true 且无loading节点，已无更多数据');
        self._scrollLoading = false;
        self._noMoreData = true;
        __wx_log({ msg: '✅ 已加载完毕，共 ' + self.feeds.length + ' 个视频' });
        self._updateMoreButton('done', self.feeds.length);
        return;
      }

      // 滚动次数超限
      self._scrollCount++;
      if (self._scrollCount >= self._maxScrollCount) {
        console.log('[搜索] 达到最大滚动次数 ' + self._maxScrollCount);
        self._scrollLoading = false;
        __wx_log({ msg: '✅ 已累计采集 ' + self.feeds.length + ' 个视频（已达最大滚动次数）' });
        self._updateMoreButton('done', self.feeds.length);
        return;
      }

      // 记录滚动前的数据量
      var beforeCount = self.feeds.length;

      // 执行滚动：超过容器高度触发 infinite-scroll
      var scrollHeight = scrollContainer.scrollHeight;
      scrollContainer.scrollTop = scrollHeight + 600;
      console.log('[搜索] 滚动后，scrollHeight: ' + scrollHeight + '，当前: ' + beforeCount + ' 个');

      // 轮询等待 loading 节点消失（即本轮数据加载完毕）
      var pollInterval;
      var pollCount = 0;
      var maxPoll = 15; // 最多等待 15 * 1000 = 15秒

      var checkLoaded = function () {
        pollCount++;
        var stillLoading = scrollContainer.querySelector('.loading, [class*="loading"], [class*="spinner"]');
        var afterCount = self.feeds.length;
        var newFeeds = afterCount - beforeCount;

        console.log('[搜索] 轮询 #' + pollCount + ' | loading: ' + (stillLoading ? '还有' : '已消失') + ' | 新增: ' + newFeeds + ' | 总计: ' + afterCount);

        if (stillLoading) {
          // loading 还在，继续等
          if (pollCount < maxPoll) {
            pollInterval = setTimeout(checkLoaded, 1000);
          } else {
            // 等待超时，强制停止
            console.log('[搜索] 等待 loading 消失超时');
            self._scrollLoading = false;
            self._noMoreData = true;
            __wx_log({ msg: '✅ 已加载 ' + afterCount + ' 个视频（等待超时）' });
            self._updateMoreButton('done', afterCount);
          }
          return;
        }

        // loading 消失了，检查数据量是否增长
        if (newFeeds > 0) {
          // 有新增，继续滚动
          console.log('[搜索] 新增 ' + newFeeds + ' 个，继续滚动...');
          setTimeout(scrollOnce, 500);
        } else {
          // 没有新增，等 3 秒再确认一次（避免异步数据延迟）
          console.log('[搜索] 无新增，等待 3 秒确认...');
          setTimeout(function () {
            var confirmedCount = self.feeds.length;
            var confirmedNew = confirmedCount - beforeCount;
            console.log('[搜索] 确认: 新增 ' + confirmedNew + ' 个，总计: ' + confirmedCount);

            if (confirmedNew > 0) {
              // 确认有新数据，继续
              scrollOnce();
            } else {
              // 确认无新数据，停止
              console.log('[搜索] 确认已无更多数据，最终: ' + confirmedCount + ' 个');
              self._scrollLoading = false;
              self._noMoreData = true;
              __wx_log({ msg: '✅ 已加载完毕，共 ' + confirmedCount + ' 个视频' });
              self._updateMoreButton('done', confirmedCount);
            }
          }, 3000);
        }
      };

      // 开始轮询
      pollInterval = setTimeout(checkLoaded, 1000);
    };

    // 开始第一次滚动
    scrollOnce();
  },

  // 更新更多按钮状态
  _updateMoreButton: function (state, totalCount) {
    var btn = document.getElementById('wx-search-more-icon');
    if (!btn) return;

    if (state === 'done') {
      btn.style.color = '#07c160';
      btn.title = '已加载完毕，共 ' + totalCount + ' 个视频';
      btn.innerHTML = '<svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg>';
    } else if (state === 'loading') {
      btn.style.color = '#07c160';
      btn.title = '加载中...';
      btn.innerHTML = '<svg class="h-full w-full animate-spin" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    }
  },

  // 添加搜索UI
  addSearchUI: function () {
    var self = this;
    var existingUI = document.getElementById('wx-channels-search-ui');
    if (existingUI) existingUI.remove();

    var ui = document.createElement('div');
    ui.id = 'wx-channels-search-ui';
    ui.style.cssText = 'position:fixed;top:60px;right:20px;background:#2b2b2b;color:#e5e5e5;padding:0;border-radius:8px;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;width:450px;max-height:80vh;box-shadow:0 8px 24px rgba(0,0,0,0.5);display:none;overflow:hidden;';

    ui.innerHTML =
      // 标题栏
      '<div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;">' +
      '<div style="font-size:15px;font-weight:500;color:#fff;">搜索结果 - 动态</div>' +
      '<div id="search-total-count" style="font-size:13px;color:#999;">0 个</div>' +
      '</div>' +

      // 列表区域
      '<div id="search-list-container" style="overflow-y:auto;padding:12px 20px;max-height:200px;">' +
      '<div id="search-list" style="display:flex;flex-direction:column;gap:8px;"></div>' +
      '</div>' +

      // 分页
      '<div id="search-pagination" style="padding:12px 20px;border-top:1px solid rgba(255,255,255,0.08);border-bottom:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;">' +
      '<div style="font-size:13px;color:#999;">第 <span id="search-current-page">1</span> / <span id="search-total-pages">1</span> 页</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button id="search-prev-page" style="background:rgba(255,255,255,0.08);color:#999;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px;">上一页</button>' +
      '<button id="search-next-page" style="background:rgba(255,255,255,0.08);color:#999;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px;">下一页</button>' +
      '</div>' +
      '</div>' +

      // 操作区
      '<div style="padding:16px 20px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '<label style="display:flex;align-items:center;cursor:pointer;font-size:13px;color:#999;user-select:none;">' +
      '<input type="checkbox" id="search-select-all" style="margin-right:8px;cursor:pointer;" />' +
      '<span>全选当前页</span>' +
      '</label>' +
      '<span id="search-selected-count" style="font-size:13px;color:#07c160;">已选 0 个</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button id="search-download-btn" style="flex:1;background:#07c160;color:#fff;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;">下载选中</button>' +
      '<button id="search-export-btn" style="flex:1;background:transparent;color:#999;border:1px solid rgba(255,255,255,0.12);padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;">导出数据</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(ui);

    // 绑定事件
    setTimeout(function () {
      // 分页
      document.getElementById('search-prev-page').addEventListener('click', function () { self.goToPrevPage(); });
      document.getElementById('search-next-page').addEventListener('click', function () { self.goToNextPage(); });

      // 全选
      document.getElementById('search-select-all').addEventListener('change', function () { self.toggleSelectAll(this.checked); });

      // 下载和导出
      document.getElementById('search-download-btn').addEventListener('click', function () { self.downloadSelected(); });
      document.getElementById('search-export-btn').addEventListener('click', function () { self.exportData(); });
    }, 100);
  },

  // 更新UI统计
  updateSearchUI: function () {
    var totalCountEl = document.getElementById('search-total-count');
    if (totalCountEl) totalCountEl.textContent = this.feeds.length + ' 个';
  },

  // 渲染列表
  renderItemList: function () {
    var listContainer = document.getElementById('search-list');
    if (!listContainer) return;

    var items = this.getCurrentTabItems();
    var totalPages = Math.ceil(items.length / this._pageSize);
    var startIndex = (this._currentPage - 1) * this._pageSize;
    var endIndex = Math.min(startIndex + this._pageSize, items.length);
    var pageItems = items.slice(startIndex, endIndex);

    listContainer.innerHTML = '';

    var self = this;
    pageItems.forEach(function (item) {
      var isSelected = self._selectedItems[item.id] === true;
      var itemEl = self.createItemElement(item, isSelected);
      listContainer.appendChild(itemEl);
    });

    this.updatePagination(totalPages);
    this.updateSelectedCount();
  },

  // 获取当前标签页的数据
  getCurrentTabItems: function () {
    return this.feeds;
  },

  // 创建列表项元素
  createItemElement: function (item, isSelected) {
    var self = this;

    var el = document.createElement('div');
    el.style.cssText = 'display:flex;align-items:flex-start;padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;transition:background 0.2s;gap:10px;cursor:pointer;';

    // 动态（视频）
    el.innerHTML = this.createFeedItemHTML(item, isSelected);

    el.onmouseenter = function () { this.style.background = 'rgba(255,255,255,0.08)'; };
    el.onmouseleave = function () { this.style.background = 'rgba(255,255,255,0.05)'; };

    el.onclick = function (e) {
      if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'IMG') {
        var checkbox = this.querySelector('input[type="checkbox"]');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          self.toggleItemSelection(item.id, checkbox.checked);
        }
      }
    };

    var checkbox = el.querySelector('input[type="checkbox"]');
    if (checkbox) {
      checkbox.onchange = function (e) {
        e.stopPropagation();
        self.toggleItemSelection(item.id, this.checked);
      };
    }

    return el;
  },

  // 创建动态项HTML
  createFeedItemHTML: function (item, isSelected) {
    var coverUrl = item.thumbUrl || item.coverUrl || '';

    // 格式化时长
    var duration = '';
    if (item.duration) {
      var seconds = Math.floor(item.duration / 1000);
      var minutes = Math.floor(seconds / 60);
      seconds = seconds % 60;
      duration = minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    // 格式化文件大小
    var fileSize = '';
    if (item.size) {
      var mb = item.size / (1024 * 1024);
      fileSize = mb.toFixed(1) + ' MB';
    }

    // 格式化发布时间
    var publishTime = '';
    if (item.createtime) {
      var date = new Date(item.createtime * 1000);
      var month = date.getMonth() + 1;
      var day = date.getDate();
      publishTime = month + '月' + day + '日';
    }

    return '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' style="margin-top:4px;cursor:pointer;flex-shrink:0;" />' +
      '<div style="width:60px;height:40px;border-radius:4px;overflow:hidden;background:#1a1a1a;flex-shrink:0;position:relative;">' +
      (coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" />' : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">无封面</div>') +
      (duration ? '<div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;padding:2px 4px;border-radius:2px;">' + duration + '</div>' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;">' +
      '<div style="font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4;">' + (item.title || '无标题') + '</div>' +
      '<div style="display:flex;gap:8px;font-size:11px;color:#999;flex-wrap:wrap;">' +
      (fileSize ? '<span>' + fileSize + '</span>' : '') +
      (publishTime ? '<span>' + publishTime + '</span>' : '') +
      (item.nickname ? '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px;">@' + item.nickname + '</span>' : '') +
      '</div>' +
      '</div>';
  },

  // 创建动态项HTML
  createFeedItemHTML: function (item, isSelected) {
    var coverUrl = item.thumbUrl || item.coverUrl || '';

    // 格式化时长
    var duration = '';
    if (item.duration) {
      var seconds = Math.floor(item.duration / 1000);
      var minutes = Math.floor(seconds / 60);
      seconds = seconds % 60;
      duration = minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    // 格式化文件大小
    var fileSize = '';
    if (item.size) {
      var mb = item.size / (1024 * 1024);
      fileSize = mb.toFixed(1) + ' MB';
    }

    // 格式化发布时间
    var publishTime = '';
    if (item.createtime) {
      var date = new Date(item.createtime * 1000);
      var month = date.getMonth() + 1;
      var day = date.getDate();
      publishTime = month + '月' + day + '日';
    }

    return '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' style="margin-top:4px;cursor:pointer;flex-shrink:0;" />' +
      '<div style="width:60px;height:40px;border-radius:4px;overflow:hidden;background:#1a1a1a;flex-shrink:0;position:relative;">' +
      (coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" />' : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;">无封面</div>') +
      (duration ? '<div style="position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.8);color:#fff;font-size:11px;padding:2px 4px;border-radius:2px;">' + duration + '</div>' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;">' +
      '<div style="font-size:13px;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.4;">' + (item.title || '无标题') + '</div>' +
      '<div style="display:flex;gap:8px;font-size:11px;color:#999;flex-wrap:wrap;">' +
      (fileSize ? '<span>' + fileSize + '</span>' : '') +
      (publishTime ? '<span>' + publishTime + '</span>' : '') +
      (item.nickname ? '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px;">@' + item.nickname + '</span>' : '') +
      '</div>' +
      '</div>';
  },

  // 切换选中状态
  toggleItemSelection: function (id, selected) {
    if (selected) {
      this._selectedItems[id] = true;
    } else {
      delete this._selectedItems[id];
    }
    this.updateSelectedCount();
  },

  // 全选/取消全选
  toggleSelectAll: function (selectAll) {
    var items = this.getCurrentTabItems();
    var startIndex = (this._currentPage - 1) * this._pageSize;
    var endIndex = Math.min(startIndex + this._pageSize, items.length);
    var pageItems = items.slice(startIndex, endIndex);

    var self = this;
    pageItems.forEach(function (item) {
      if (selectAll) {
        self._selectedItems[item.id] = true;
      } else {
        delete self._selectedItems[item.id];
      }
    });

    this.renderItemList();
  },

  // 更新选中数量
  updateSelectedCount: function () {
    var countEl = document.getElementById('search-selected-count');
    if (countEl) {
      var count = 0;
      for (var id in this._selectedItems) {
        if (this._selectedItems[id] === true) {
          count++;
        }
      }
      countEl.textContent = '已选 ' + count + ' 个';
    }
  },

  // 更新分页
  updatePagination: function (totalPages) {
    var currentPageEl = document.getElementById('search-current-page');
    var totalPagesEl = document.getElementById('search-total-pages');
    var prevBtn = document.getElementById('search-prev-page');
    var nextBtn = document.getElementById('search-next-page');

    if (currentPageEl) currentPageEl.textContent = this._currentPage;
    if (totalPagesEl) totalPagesEl.textContent = totalPages;

    if (prevBtn) {
      prevBtn.disabled = this._currentPage <= 1;
      prevBtn.style.opacity = this._currentPage <= 1 ? '0.5' : '1';
    }

    if (nextBtn) {
      nextBtn.disabled = this._currentPage >= totalPages;
      nextBtn.style.opacity = this._currentPage >= totalPages ? '0.5' : '1';
    }
  },

  goToPrevPage: function () {
    if (this._currentPage > 1) {
      this._currentPage--;
      this.renderItemList();
    }
  },

  goToNextPage: function () {
    var items = this.getCurrentTabItems();
    var totalPages = Math.ceil(items.length / this._pageSize);
    if (this._currentPage < totalPages) {
      this._currentPage++;
      this.renderItemList();
    }
  },

  // 下载选中的视频
  downloadSelected: function () {
    // 获取选中的动态（视频）
    var selectedFeeds = this.feeds.filter(function (f) {
      return this._selectedItems[f.id] === true && f.url;
    }, this);

    if (selectedFeeds.length === 0) {
      WXU.toast('没有选中可下载的内容');
      return;
    }

    __wx_log({ msg: '🚀 [搜索] 开始下载 ' + selectedFeeds.length + ' 个视频' });
    // TODO: 实现视频下载逻辑
    WXU.toast('开始下载 ' + selectedFeeds.length + ' 个视频');
  },

  // 导出数据
  exportData: function () {
    var data = {
      feeds: this.feeds,
      timestamp: Date.now()
    };

    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'search_results_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);

    __wx_log({ msg: '📤 [搜索] 已导出搜索结果' });
  }
};

// ==================== 搜索关键词视频采集任务器 ====================
window.__wx_channels_search_task_collector = {
  // 任务状态
  _currentTask: null,        // 当前任务
  _matchedVideos: [],        // 匹配到的视频（前端内存，用于防重）
  _dbConfirmedCount: 0,      // 数据库确认入库的数量（后端返回，用于停止控制）
  _isWatching: false,        // 是否正在监听视频
  _isScrolling: false,       // 是否正在滚动加载
  _scrollTimer: null,        // 滚动定时器
  _waitingForPageLoad: false, // 是否等待页面加载
  _expectedKeyword: null,     // 期望的关键词（用于页面跳转检测）

  // 监听视频（创建任务时调用，等待开始滚动）
  watchVideo: function (taskData) {
    var self = this;

    // 检查是否是搜索页面
    if (!is_search_page()) {
      console.error('[任务采集] 当前不在搜索页面，无法执行任务');
      self._reportError(taskData.task_id, '当前不在搜索页面');
      return;
    }

    // 检查任务数据
    if (!taskData.keyword || !taskData.task_id) {
      console.error('[任务采集] 任务数据不完整:', taskData);
      return;
    }

    console.log('[任务采集] ★★★ watchVideo 被调用, taskId:', taskData.task_id, ', keyword:', taskData.keyword);
    console.log('[任务采集] 当前页面:', window.location.href);
    console.log('[任务采集] collector 当前数据量:', (window.__wx_channels_search_collector && window.__wx_channels_search_collector.feeds) ? window.__wx_channels_search_collector.feeds.length : 0);
    // 发送日志到后端
    this.sendLog('info', 'watchVideo 被调用, taskId=' + taskData.task_id + ', keyword=' + taskData.keyword + ', 页面=' + window.location.href);

    // 重置状态
    this._currentTask = {
      task_id: taskData.task_id,
      keyword: taskData.keyword,
      target_count: taskData.target_count || 100,
      task_type: taskData.task_type,
      start_time: Date.now()
    };
    this._matchedVideos = [];

    // 【关键修复】检查当前 URL 是否是目标关键词页面
    var currentUrl = window.location.href;
    var expectedKeyword = encodeURIComponent(taskData.keyword);
    var urlMatch = currentUrl.includes('q=' + expectedKeyword) || currentUrl.includes('q=' + taskData.keyword);

    if (!urlMatch) {
      console.log('[任务采集] ★★★ 页面 URL 与关键词不匹配，等待页面跳转...');
      console.log('[任务采集] 当前 URL:', currentUrl);
      console.log('[任务采集] 期望关键词:', taskData.keyword);
      this.sendLog('warn', '页面 URL 与关键词不匹配，等待跳转 - 当前:' + currentUrl.split('q=')[1]?.split('&')[0] + ', 期望:' + taskData.keyword);
      this._waitingForPageLoad = true;
      this._expectedKeyword = taskData.keyword;
      this._isWatching = true;
      this._isScrolling = false;
      return;
    }

    // URL 匹配，正常初始化任务
    this._waitingForPageLoad = false;
    this._expectedKeyword = null;

    // 【修复】清理 collector 中的旧数据，防止关键词切换时数据污染
    // 关键词切换时 collector 可能残留上一个关键词的数据，导致新任务一开始就采集到旧数据
    if (window.__wx_channels_search_collector && window.__wx_channels_search_collector.feeds) {
      var oldLen = window.__wx_channels_search_collector.feeds.length;
      window.__wx_channels_search_collector.feeds = [];
      if (oldLen > 0) {
        console.log('[任务采集] 已清理 collector 中的 ' + oldLen + ' 条旧数据');
        this.sendLog('info', '已清理 collector 中的 ' + oldLen + ' 条旧数据');
      }
    }
    this._isWatching = true;
    this._isScrolling = false; // 【关键修复】重置滚动状态，避免前一个任务中断时 _isScrolling=true 导致新任务无法滚动
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }

    // 【修复】处理 collector 中已有数据（此时 collector 已被清理，不会处理旧数据）
    // RPA 流程：进入页面时 WXE.onSearchResultLoaded 已触发了 addSearchResult
    // 此时 collector 可能有新页面的数据，需要处理
    this._processExistingCollectorFeeds();

    // 通知外部任务已开始
    this._reportTaskStarted();

    console.log('[任务采集] 任务已创建，正在监听视频，等待开始滚动...');
  },

  // 处理 collector 中已有的所有视频数据
  _processExistingCollectorFeeds: function () {
    var collector = window.__wx_channels_search_collector;
    if (!collector || !collector.feeds || collector.feeds.length === 0) {
      console.log('[任务采集] collector 中暂无数据，跳过');
      this.sendLog('info', 'collector 中暂无数据');
      return;
    }

    this.sendLog('info', 'collector 中有 ' + collector.feeds.length + ' 个数据，准备处理');

    var existingCount = 0;
    collector.feeds.forEach(function (feed) {
      if (feed && feed.type === 'media') {
        // 检查是否已处理过
        var alreadyProcessed = this._matchedVideos.some(function (v) { return v.id === feed.id; });
        if (!alreadyProcessed) {
          this._matchedVideos.push(feed);
          existingCount++;
          // 上报单条数据
          this._reportVideo(feed);
        }
      }
    }, this);

    if (existingCount > 0) {
      console.log('[任务采集] 已处理 collector 中已有的 ' + existingCount + ' 个视频，_matchedVideos 共 ' + this._matchedVideos.length + ' 个');
    }
  },

  // 开始滚动（监听视频后，外部调用此方法开始滚动）
  startScroll: function (taskId) {
    var self = this;

    console.log('[任务采集] ★★★ startScroll 被调用, taskId:', taskId);
    console.log('[任务采集] 当前 _currentTask:', this._currentTask ? this._currentTask.task_id : 'null');
    console.log('[任务采集] 当前 _isScrolling:', this._isScrolling);
    console.log('[任务采集] window.__wx_channels_search_task_collector:', !!window.__wx_channels_search_task_collector);
    this.sendLog('info', 'startScroll 被调用, taskId=' + taskId + ', _currentTask=' + (this._currentTask ? this._currentTask.task_id : 'null'));

    // 【修复竞态】：如果任务还未初始化，等待最多 2 秒让 watch_video 先完成
    var waitCount = 0;
    var maxWait = 20; // 20 * 100ms = 2秒
    var waitAndProceed = function () {
      if (!self._currentTask || self._currentTask.task_id !== taskId) {
        waitCount++;
        if (waitCount < maxWait) {
          setTimeout(waitAndProceed, 100);
          return;
        }
        console.error('[任务采集] 等待 watch_video 超时，任务不存在，无法开始滚动');
        return;
      }

      // 任务已就绪，继续执行滚动逻辑
      self._doStartScroll(taskId);
    };

    waitAndProceed();
  },

  // 实际执行滚动（从 waitAndProceed 调用）
  _doStartScroll: function (taskId) {
    var self = this;

    console.log('[任务采集] ★★★ _doStartScroll 开始执行, taskId:', taskId);
    console.log('[任务采集] 当前 _matchedVideos.length:', this._matchedVideos.length);
    if (this._isScrolling) {
      console.log('[任务采集] 已在滚动中，先处理已有数据');
      this._processExistingCollectorFeeds();
      return;
    }

    console.log('[任务采集] 开始滚动:', taskId, '| 当前匹配数:', this._matchedVideos.length, '| 目标:', this._currentTask.target_count);

    this._isWatching = false; // 停止监听，开始滚动
    this._isScrolling = true;

    // 【修复】：先处理 collector 中已有的所有视频（避免漏掉）
    this._processExistingCollectorFeeds();

    // 查找滚动容器：优先找页面 div 容器，回退到 window
    var pageContainer = document.querySelector('[data-v-3932dd4a].search-result-page, [class*="search-result"]');
    if (pageContainer) {
      console.log('[任务采集] 找到页面滚动容器:', pageContainer.className);
    } else {
      console.log('[任务采集] 未找到 div 滚动容器，将使用 window 滚动');
    }

    // 上报滚动已开始
    this._sendWebSocketMessage({
      type: 'task_progress',
      data: {
        task_id: taskId,
        current_count: this._dbConfirmedCount || this._matchedVideos.length,
        target_count: this._currentTask.target_count,
        status: 'running'
      }
    });

    // 开始自动滚动加载（带重试机制）
    this._scrollAttempt = 0;
    this._maxScrollAttempts = 10; // 最多尝试滚动 10 次
    this._triggerScrollWithTargetCount();
  },

  // 暂停滚动
  pauseScroll: function (taskId) {
    if (!this._currentTask || this._currentTask.task_id !== taskId) {
      console.log('[任务采集] 任务不存在或ID不匹配，无法暂停');
      return;
    }

    console.log('[任务采集] 暂停滚动:', taskId);

    // 停止滚动
    this._isScrolling = false;
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }

    // 上报暂停状态
    this._sendWebSocketMessage({
      type: 'task_progress',
      data: {
        task_id: taskId,
        current_count: this._dbConfirmedCount || this._matchedVideos.length,
        target_count: this._currentTask.target_count,
        status: 'paused'
      }
    });
  },

  // 恢复滚动
  resumeScroll: function (taskId) {
    var self = this;

    if (!this._currentTask || this._currentTask.task_id !== taskId) {
      console.log('[任务采集] 任务不存在或ID不匹配，无法恢复');
      return;
    }

    console.log('[任务采集] 恢复滚动:', taskId);

    // 重新开始滚动
    if (!this._isScrolling) {
      this._isScrolling = true;
      this._triggerScrollWithTargetCount();
    }

    // 上报恢复状态
    this._sendWebSocketMessage({
      type: 'task_progress',
      data: {
        task_id: taskId,
        current_count: this._dbConfirmedCount || this._matchedVideos.length,
        target_count: this._currentTask.target_count,
        status: 'running'
      }
    });
  },

  // 停止任务
  stopTask: function (taskId) {
    if (!this._currentTask || this._currentTask.task_id !== taskId) {
      console.log('[任务采集] 任务不存在或ID不匹配，无法停止');
      return;
    }

    console.log('[任务采集] 停止任务:', taskId);

    // 停止监听和滚动
    this._isWatching = false;
    this._isScrolling = false;
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }

    // 上报任务被停止
    this._sendWebSocketMessage({
      type: 'task_complete',
      data: {
        task_id: taskId,
        current_count: this._dbConfirmedCount || this._matchedVideos.length,
        target_count: this._currentTask.target_count,
        status: 'stopped'
      }
    });

    // 清理任务状态
    this._currentTask = null;
    this._matchedVideos = [];
    this._dbConfirmedCount = 0;
  },

  // 带目标数量的滚动加载
  // 参考 triggerScrollAndCollect 的成功逻辑：必须先滚动，再检查
  _triggerScrollWithTargetCount: function () {
    var self = this;

    // 【安全检查】如果任务不存在，直接返回
    if (!this._currentTask) {
      console.log('[任务采集] 任务已失效，停止滚动');
      this._isScrolling = false;
      return;
    }

    var currentCount = this._dbConfirmedCount || this._matchedVideos.length;
    var targetCount = this._currentTask ? this._currentTask.target_count : 0;

    console.log('[任务采集] [_triggerScrollWithTargetCount] 当前:', currentCount, '| 目标:', targetCount);

    // 清除之前的定时器
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }

    // 【关键修改】如果已达到目标数量，立即完成，不滚动
    if (currentCount >= targetCount) {
      console.log('[任务采集] 已达到目标数量 ' + targetCount + '，停止加载');
      this._isScrolling = false;
      this._reportTaskComplete('completed');
      return;
    }

    // ===== 找到滚动容器（与 triggerScrollAndCollect 完全一致的选择器）=====
    var scrollContainer = document.querySelector('[data-v-3932dd4a].search-result-page');
    if (!scrollContainer) {
      console.log('[任务采集] 未找到精确滚动容器 [data-v-3932dd4a].search-result-page，尝试备用选择器');
      scrollContainer = document.querySelector('[class*="search-result"]');
    }
    if (!scrollContainer) {
      console.log('[任务采集] 未找到任何滚动容器，改用 window 滚动');
      scrollContainer = null;
    } else {
      console.log('[任务采集] ★★★ 找到滚动容器:', scrollContainer.tagName, scrollContainer.className);
      console.log('[任务采集] 滚动容器属性: scrollHeight=' + scrollContainer.scrollHeight + ', scrollTop=' + scrollContainer.scrollTop + ', clientHeight=' + scrollContainer.clientHeight + ', offsetHeight=' + scrollContainer.offsetHeight);
    }

    // ===== 每次滚动前，先检查是否已标记"无更多"（仅用于提前退出）=====
    if (scrollContainer) {
      var disabled = scrollContainer.getAttribute('infinite-scroll-disabled');
      console.log('[任务采集] 滚动前检查: infinite-scroll-disabled=' + disabled);
      var alreadyNoMore = (disabled === 'true' && !scrollContainer.querySelector('.loading, [class*="loading"], [class*="spinner"]'));
      if (alreadyNoMore) {
        console.log('[任务采集] 已标记无更多数据（infinite-scroll-disabled=true），停止');
        this._isScrolling = false;
        this._reportTaskComplete('insufficient_data');
        return;
      }
    }

    // 记录滚动前的数量（用于判断是否有新增）
    var beforeCount = this._matchedVideos.length;

    // ===== 执行滚动（参考 triggerScrollAndCollect：使用 scrollHeight + 600 超过容器高度）=====
    if (scrollContainer) {
      var beforeScrollTop = scrollContainer.scrollTop;
      var beforeScrollHeight = scrollContainer.scrollHeight;
      var beforeClientHeight = scrollContainer.clientHeight;
      // 设置 scrollTop 超过 clientHeight，触发 infinite-scroll
      var targetScrollTop = beforeScrollHeight + 600;
      scrollContainer.scrollTop = targetScrollTop;
      console.log('[任务采集] ★★★ 执行 div 滚动: [scroll#' + (this._scrollAttempt + 1) + '] scrollHeight=' + beforeScrollHeight + ' + 600 = ' + targetScrollTop + '（容器高度=' + beforeClientHeight + '，原scrollTop=' + beforeScrollTop + '）');
    } else {
      var beforeDocHeight = document.documentElement.scrollHeight;
      window.scrollTo({ top: beforeDocHeight + 600, behavior: 'auto' });
      console.log('[任务采集] ★★★ 执行 window 滚动: [scroll#' + (this._scrollAttempt + 1) + '] docHeight=' + beforeDocHeight + ' + 600 = ' + (beforeDocHeight + 600));
    }

    // ===== 轮询等待本轮数据加载完毕（参考 triggerScrollAndCollect）=====
    var pollCount = 0;
    var maxPoll = 15; // 最多等待 15 秒
    var scrollAttempt = this._scrollAttempt || 0;

    var checkLoaded = function () {
      pollCount++;

      // 【重要】每次轮询时重新查找 loading 节点（避免引用过期）
      var loadingNode = scrollContainer ? scrollContainer.querySelector('.loading, [class*="loading"], [class*="spinner"]') : null;
      var stillLoading = !!loadingNode;

      // 同步 collector 中的新数据
      var collectorBefore = self._matchedVideos.length;
      self._syncCollectorFeeds();
      var collectorNew = self._matchedVideos.length - collectorBefore;

      var afterMatched = self._matchedVideos.length;
      var newMatched = afterMatched - beforeCount;

      console.log('[任务采集] 轮询 #' + pollCount + ' | loading: ' + (stillLoading ? '还有' : '已消失') + ' | collector新增: ' + collectorNew + ' | 本轮新增: ' + newMatched + ' | 总计: ' + afterMatched);

      // 上报进度
      self._reportProgress(afterMatched);

      // 【提前完成检查】达到目标就停止
      if (afterMatched >= targetCount) {
        console.log('[任务采集] 已达到目标数量 ' + targetCount + '，停止加载');
        self._isScrolling = false;
        self._scrollTimer = null;
        self._reportTaskComplete('completed');
        return;
      }

      // loading 还在，继续等
      if (stillLoading) {
        if (pollCount < maxPoll) {
          self._scrollTimer = setTimeout(checkLoaded, 1000);
        } else {
          console.log('[任务采集] 等待 loading 消失超时（15秒）');
          self._isScrolling = false;
          self._scrollTimer = null;
          self._reportTaskComplete('timeout');
        }
        return;
      }

      // ===== loading 已消失，分析是否有新数据 =====

      // 有新增数据 → 继续滚动
      if (newMatched > 0) {
        self._scrollAttempt = 0; // 重置重试计数
        console.log('[任务采集] 有新增 ' + newMatched + ' 个，继续滚动...');
        self._scrollTimer = setTimeout(function () {
          self._triggerScrollWithTargetCount();
        }, 500);
        return;
      }

      // 无新增 → 重试机制（最多 3 次）
      scrollAttempt++;
      self._scrollAttempt = scrollAttempt;

      if (scrollAttempt <= 3) {
        console.log('[任务采集] 无新增，第 ' + scrollAttempt + ' 次重试...');
        self._scrollTimer = setTimeout(function () {
          self._triggerScrollWithTargetCount();
        }, scrollAttempt * 1000);
        return;
      }

      // 3 次重试都无新增 → 等待 3 秒最终确认（参考 triggerScrollAndCollect）
      console.log('[任务采集] 3 次重试无新增，等待 3 秒最终确认...');
      setTimeout(function () {
        var confirmedCount = self._matchedVideos.length;
        var confirmedNew = confirmedCount - beforeCount;
        console.log('[任务采集] 最终确认: 新增 ' + confirmedNew + ' 个，总计: ' + confirmedCount);

        if (confirmedNew > 0) {
          // 确认有新数据 → 继续
          self._scrollAttempt = 0;
          self._scrollTimer = setTimeout(function () {
            self._triggerScrollWithTargetCount();
          }, 500);
        } else {
          // 确认无更多数据 → 停止
          console.log('[任务采集] 最终确认已无更多数据，停止（总计: ' + confirmedCount + '）');
          self._isScrolling = false;
          self._scrollTimer = null;
          if (confirmedCount < targetCount) {
            self._reportTaskComplete('insufficient_data');
          } else {
            self._reportTaskComplete('completed');
          }
        }
      }, 3000);
    };

    // 开始轮询
    self._scrollTimer = setTimeout(checkLoaded, 1000);
  },

  // 同步 collector 中的新视频到 _matchedVideos（轮询时调用）
  _syncCollectorFeeds: function () {
    var collector = window.__wx_channels_search_collector;
    if (!collector || !collector.feeds || collector.feeds.length === 0) return;

    var newCount = 0;
    collector.feeds.forEach(function (feed) {
      // 只处理视频类型，且必须有 id（用于防重）
      if (!feed || feed.type !== 'media' || !feed.id) return;
      var alreadyProcessed = this._matchedVideos.some(function (v) { return v.id === feed.id; });
      if (!alreadyProcessed) {
        this._matchedVideos.push(feed);
        newCount++;
        this._reportVideo(feed);
      }
    }, this);

    if (newCount > 0) {
      console.log('[任务采集] 同步 collector 新视频: ' + newCount + ' 个, 共 ' + this._matchedVideos.length + ' 个');
    }
  },

  // 处理新视频数据
  _handleNewVideo: function (feed) {
    var self = this;

    // 如果还没有开始任务，跳过
    if (!this._currentTask) {
      return;
    }

    // 【防重检查】确保视频有 id，且未在 _matchedVideos 中出现过
    if (!feed || !feed.id) {
      console.warn('[任务采集] 跳过无 id 的视频:', feed ? feed.title : 'unknown');
      return;
    }
    var alreadyMatched = this._matchedVideos.some(function (v) { return v.id === feed.id; });
    if (alreadyMatched) {
      return; // 已存在，不重复处理
    }

    // 检查是否匹配关键词
    if (this._isKeywordMatched(feed)) {
      console.log('[任务采集] 匹配到视频:', feed.title || feed.id);

      // 添加到匹配列表
      this._matchedVideos.push(feed);

      // 上报单条数据
      this._reportVideo(feed);

      // 检查是否已达到目标
      if (this._matchedVideos.length >= this._currentTask.target_count) {
        console.log('[任务采集] 已达到目标数量 ' + this._currentTask.target_count);
        this._isScrolling = false;
        this._reportTaskComplete('completed');
      }
    }
  },

  // 关键词匹配判断
  _isKeywordMatched: function (feed) {
    if (!this._currentTask || !this._currentTask.keyword) {
      return false;
    }

    var keyword = this._currentTask.keyword.toLowerCase();

    // 检查标题
    if (feed.title && feed.title.toLowerCase().indexOf(keyword) !== -1) {
      return true;
    }

    // 检查昵称
    if (feed.nickname && feed.nickname.toLowerCase().indexOf(keyword) !== -1) {
      return true;
    }

    // 检查作者
    if (feed.author && feed.author.toLowerCase().indexOf(keyword) !== -1) {
      return true;
    }

    return false;
  },

  // 上报任务开始
  _reportTaskStarted: function () {
    if (!this._currentTask) return;

    this._sendWebSocketMessage({
      type: 'task_started',
      data: {
        task_id: this._currentTask.task_id,
        keyword: this._currentTask.keyword,
        target_count: this._currentTask.target_count,
        status: 'listening'
      }
    });
  },

  // 上报进度
  _reportProgress: function (currentCount) {
    if (!this._currentTask) return;

    this._sendWebSocketMessage({
      type: 'task_progress',
      data: {
        task_id: this._currentTask.task_id,
        current_count: currentCount,
        target_count: this._currentTask.target_count,
        status: 'running'
      }
    });
  },

  // 上报单条视频
  _reportVideo: function (feed) {
    if (!this._currentTask) return;

    this._sendWebSocketMessage({
      type: 'task_video',
      data: {
        task_id: this._currentTask.task_id,
        video: feed
      }
    });
  },

  // 接收后端广播的进度/完成消息（入库数量由数据库确认）
  _onBackendMessage: function (msg) {
    if (!this._currentTask) return;

    var taskID = msg.data && msg.data.task_id;
    if (taskID !== this._currentTask.task_id) return;

    if (msg.type === 'task_progress') {
      var dbCount = msg.data.current_count;
      if (typeof dbCount === 'number') {
        this._dbConfirmedCount = dbCount;
      }
    } else if (msg.type === 'task_complete') {
      this._dbConfirmedCount = msg.data.current_count || this._dbConfirmedCount;
    }
  },

  // 上报任务完成（不包含视频列表，由调用方自行查询）
  _reportTaskComplete: function (status) {
    if (!this._currentTask) return;

    console.log('[任务采集] 任务完成, status:', status, 'count:', this._matchedVideos.length);

    this._sendWebSocketMessage({
      type: 'task_complete',
      data: {
        task_id: this._currentTask.task_id,
        current_count: this._dbConfirmedCount || this._matchedVideos.length,
        target_count: this._currentTask.target_count,
        status: status
      }
    });

    // 清理任务状态
    this._currentTask = null;
    this._matchedVideos = [];
    this._dbConfirmedCount = 0;
    this._isWatching = false;
    this._isScrolling = false;
    if (this._scrollTimer) {
      clearTimeout(this._scrollTimer);
      this._scrollTimer = null;
    }
  },

  // 上报错误
  _reportError: function (taskId, message) {
    this._sendWebSocketMessage({
      type: 'task_error',
      data: {
        task_id: taskId,
        message: message
      }
    });
  },

  // 发送 WebSocket 消息
  _sendWebSocketMessage: function (msg) {
    if (window.__wx_api_client && window.__wx_api_client.connected) {
      try {
        window.__wx_api_client.ws.send(JSON.stringify(msg));
        console.log('[任务采集] 发送消息:', msg.type);
      } catch (e) {
        console.error('[任务采集] 发送消息失败:', e);
      }
    } else {
      console.warn('[任务采集] WebSocket 未连接，无法发送消息');
    }
  },

  // 获取当前任务状态
  getStatus: function () {
    return {
      hasTask: !!this._currentTask,
      task: this._currentTask,
      matchedCount: this._matchedVideos.length,
      isWatching: this._isWatching,
      isScrolling: this._isScrolling
    };
  },

  // 发送日志到后端
  sendLog: function (level, message) {
    if (window.__wx_api_client && window.__wx_api_client.connected) {
      try {
        window.__wx_api_client.ws.send(JSON.stringify({
          type: 'browser_log',
          data: {
            level: level,
            message: message,
            timestamp: Date.now(),
            task_id: this._currentTask ? this._currentTask.task_id : ''
          }
        }));
      } catch (e) {
        console.error('[任务采集] 发送日志失败:', e);
      }
    }
  }
};

// ==================== 事件监听 ====================

// 确保事件监听器只注册一次
if (!window.__wx_search_event_registered) {
  window.__wx_search_event_registered = true;

  // 监听搜索结果加载
  WXE.onSearchResultLoaded(function (data) {
    // 检查是否是搜索页面
    var isSearchPage = window.location.pathname.includes('/pages/s');
    if (!isSearchPage) {
      return;
    }

    if (!data) {
      console.warn('[搜索] 数据为空');
      return;
    }

    console.log('[搜索] ★★★ onSearchResultLoaded, feeds:', (data.feeds || data.objectList || []).length);
    console.log('[搜索] ★★★ 原始数据 keys:', Object.keys(data));

    // 添加到常规采集器
    window.__wx_channels_search_collector.addSearchResult(data);

    // 如果有任务在运行，处理新数据
    if (window.__wx_channels_search_task_collector._currentTask) {
      var feeds = data.feeds || [];
      var taskCollector = window.__wx_channels_search_task_collector;
      feeds.forEach(function (feed) {
        var formatted = WXU.format_feed(feed);
        if (formatted && formatted.type === 'media') {
          taskCollector._handleNewVideo(formatted);
        } else {
          console.log('[搜索] format_feed跳过: id=', feed.id, '| mediaType=', feed.objectDesc ? feed.objectDesc.mediaType : '无');
        }
      });
    }
  });
}

// ==================== 初始化 ====================

function is_search_page() {
  var path = window.location.pathname || '';
  // 微信搜一搜页面路径特征
  if (!path.includes('/pages/s')) {
    return false;
  }
  // 额外验证：确保 URL 中包含 q= 参数（搜索关键词参数）
  // 排除掉 q= 空值或只有占位符的情况
  var searchParams = new URLSearchParams(window.location.search);
  var q = searchParams.get('q') || '';
  // 如果 q 参数为空或只有纯数字/英文短词（可能是测试数据），也认为不在有效搜索状态
  if (!q || q.length < 2) {
    return false;
  }
  return true;
}

if (is_search_page()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.__wx_channels_search_collector.init();
      checkWaitingTask();
    });
  } else {
    window.__wx_channels_search_collector.init();
    checkWaitingTask();
  }
}

// 检查是否有等待页面加载的任务
function checkWaitingTask() {
  var taskCollector = window.__wx_channels_search_task_collector;
  if (!taskCollector._waitingForPageLoad || !taskCollector._expectedKeyword) {
    return;
  }

  var currentUrl = window.location.href;
  var expectedKeyword = taskCollector._expectedKeyword;

  // 检查 URL 是否包含期望的关键词
  if (currentUrl.includes('q=' + encodeURIComponent(expectedKeyword)) ||
      currentUrl.includes('q=' + expectedKeyword)) {
    console.log('[任务采集] ★★★ 页面已加载到目标关键词，重新初始化任务...');
    taskCollector.sendLog('info', '页面已加载到目标关键词:' + expectedKeyword + '，重新初始化');

    // 重置等待状态
    taskCollector._waitingForPageLoad = false;
    taskCollector._expectedKeyword = null;

    // ========== 关键修复：清理旧数据 ==========
    // 页面跳转后，必须先清理 collector 中的旧数据
    // 否则会处理上一个关键词的旧数据，导致数据混乱
    if (window.__wx_channels_search_collector && window.__wx_channels_search_collector.feeds) {
      var oldLen = window.__wx_channels_search_collector.feeds.length;
      window.__wx_channels_search_collector.feeds = [];
      console.log('[任务采集] ★★★ 已清理 collector 中的 ' + oldLen + ' 条旧数据（页面已跳转）');
      taskCollector.sendLog('warn', '已清理 collector 中的 ' + oldLen + ' 条旧数据，等待新页面数据');
    }

    // 重置匹配状态
    taskCollector._matchedVideos = [];
    taskCollector._dbConfirmedCount = 0;
    taskCollector._isWatching = true;
    taskCollector._isScrolling = false;
    if (taskCollector._scrollTimer) {
      clearTimeout(taskCollector._scrollTimer);
      taskCollector._scrollTimer = null;
    }

    // 注意：不再立即处理现有数据，等待新页面的 onSearchResultLoaded 事件
    console.log('[任务采集] 等待新页面数据加载...');

    // 通知外部任务已开始
    taskCollector._reportTaskStarted();

    console.log('[任务采集] 任务已创建，等待开始滚动...');
  }
}

// 监听 URL 变化（用于检测 SPA 页面跳转）
var lastUrl = window.location.href;
setInterval(function() {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    console.log('[任务采集] URL 变化检测:', window.location.href);
    checkWaitingTask();
  }
}, 1000);

console.log('[search.js] 搜索页面模块加载完成');

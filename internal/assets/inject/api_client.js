/**
 * @file API 客户端 - 通过 WebSocket 与后端通信
 */
console.log('[api_client.js] 加载 API 客户端模块');

window.__wx_api_client = {
  ws: null,
  connected: false,
  connecting: false,
  initialized: false,
  connectToken: 0,
  reconnectTimer: null,
  reconnectDelay: 3000,
  requests: {},
  heartbeatTimer: null,
  lastHeartbeatTime: 0,
  missedHeartbeats: 0,
  apiMethods: {},

  // 初始化
  init: function () {
    if (this.initialized) {
      console.log('[API客户端] 已初始化，跳过重复启动');
      return;
    }
    this.initialized = true;
    this.connect();
    this.setupVisibilityHandler();
    this.setupBeforeUnloadHandler();
  },

  // 设置页面可见性监听
  setupVisibilityHandler: function () {
    var self = this;

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        // 页面变为可见
        console.log('[API客户端] 📱 页面激活，检查连接状态...');

        if (!self.connected) {
          console.log('[API客户端] 连接已断开，立即重连...');
          // 清除现有的重连定时器
          if (self.reconnectTimer) {
            clearTimeout(self.reconnectTimer);
            self.reconnectTimer = null;
          }
          // 立即重连
          self.connect();
        } else {
          // 连接还在，发送一个心跳测试
          self.sendHeartbeat();
        }
      } else {
        // 页面变为隐藏
        console.log('[API客户端] 📴 页面进入后台');
      }
    });

    console.log('[API客户端] ✅ 页面可见性监听已启动');
  },

  // 设置页面关闭前的处理
  setupBeforeUnloadHandler: function () {
    var self = this;

    window.addEventListener('beforeunload', function () {
      // 页面即将关闭，清理资源
      if (self.ws && self.connected) {
        self.ws.close(1000, 'Page unloading');
      }

      if (self.heartbeatTimer) {
        clearInterval(self.heartbeatTimer);
      }

      if (self.reconnectTimer) {
        clearTimeout(self.reconnectTimer);
      }
    });
  },

  // 连接 WebSocket
  connect: function () {
    if (this.connected) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      console.log('[API客户端] 连接已在进行中，跳过重复 connect');
      return;
    }
    this.connecting = true;
    this.connectToken += 1;
    var token = this.connectToken;

    // 检测代理端口
    // 方法1: 尝试从 /__wx_channels_api 端点获取端口信息
    // 方法2: 使用默认端口 2026
    var wsPort = 2026; // 默认端口

    // 尝试多个可能的端口
    var possiblePorts = [2026, 9527, 8081, 3001];

    // 从 localStorage 获取上次成功的端口
    try {
      var lastPort = localStorage.getItem('__wx_api_ws_port');
      if (lastPort) {
        possiblePorts.unshift(parseInt(lastPort));
      }
    } catch (e) {
      // ignore
    }

    // 尝试连接
    this.tryConnect(possiblePorts, 0, token);
  },

  // 尝试连接到指定端口
  tryConnect: function (ports, index, token) {
    var self = this;

    if (token !== this.connectToken) {
      return;
    }

    if (index >= ports.length) {
      this.connecting = false;
      console.error('[API客户端] 所有端口都连接失败，3秒后重试...');
      this.reconnectTimer = setTimeout(function () {
        self.connect();
      }, this.reconnectDelay);
      return;
    }

    var wsPort = ports[index];
    var wsUrl = 'ws://127.0.0.1:' + wsPort + '/ws/api';
    if (window.__WX_LOCAL_TOKEN__) {
      wsUrl += '?token=' + encodeURIComponent(window.__WX_LOCAL_TOKEN__);
    }

    console.log('[API客户端] 尝试连接:', wsUrl);

    // 标记当前尝试的端口索引
    this.currentPortIndex = index;
    this.currentPorts = ports;

    try {
      var ws = new WebSocket(wsUrl);
      this.ws = ws;

      // 设置连接超时（5秒）
      var connectTimeout = setTimeout(function () {
        if (token !== self.connectToken) return;
        if (!self.connected && self.ws === ws && ws.readyState !== WebSocket.OPEN) {
          console.log('[API客户端] 连接超时，尝试下一个端口...');
          ws.close();
          self.tryConnect(ports, index + 1, token);
        }
      }, 5000);

      ws.onopen = function () {
        if (token !== self.connectToken || self.ws !== ws) {
          try { ws.close(); } catch (e) {}
          return;
        }
        clearTimeout(connectTimeout);
        self.connected = true;
        self.connecting = false;
        console.log('[API客户端] ✅ 已连接到后端: ws://127.0.0.1:' + wsPort + '/ws/api');

        // 保存成功的端口
        try {
          localStorage.setItem('__wx_api_ws_port', wsPort);
        } catch (e) {
          // ignore
        }

        // 清除重连定时器
        if (self.reconnectTimer) {
          clearTimeout(self.reconnectTimer);
          self.reconnectTimer = null;
        }

        // 启动心跳
        self.startHeartbeat();
        self.sendClientState();
      };

      ws.onmessage = function (event) {
        // 最先打印，确保能看到所有消息（放在 return 检查之前）
        try {
          var preview = typeof event.data === 'string' ? event.data.substring(0, 300) : '[非字符串]';
          console.log('[API客户端] ★★★ 收到原始数据:', preview);
          console.log('[API客户端] token check: connectToken=%s, self.ws=%s, ws=%s, match=%s',
            self.connectToken, self.ws ? 'exists' : 'null', ws ? 'exists' : 'null',
            (token === self.connectToken && self.ws === ws) ? 'PASS' : 'FAIL');
        } catch(e) {
          console.log('[API客户端] ★★★ 收到原始数据: [解析失败]');
        }
        if (token !== self.connectToken || self.ws !== ws) {
          console.warn('[API客户端] token 检查失败，跳过处理');
          return;
        }
        try {
          var msg = JSON.parse(event.data);
          self.handleMessage(msg);
        } catch (err) {
          console.error('[API客户端] 解析消息失败:', err);
        }
      };

      ws.onerror = function (error) {
        if (token !== self.connectToken || self.ws !== ws) return;
        clearTimeout(connectTimeout);
        console.error('[API客户端] ❌ WebSocket 错误:', error);
        // 如果还没有连接成功，尝试下一个端口
        if (!self.connected) {
          self.tryConnect(ports, index + 1, token);
        }
      };

      ws.onclose = function (event) {
        if (token !== self.connectToken || self.ws !== ws) return;
        clearTimeout(connectTimeout);
        console.log('[API客户端] 🔌 连接关闭:', event.code, event.reason);

        // 停止心跳
        self.stopHeartbeat();
        self.connecting = false;

        if (self.connected) {
          // 之前连接成功过，现在断开了，需要重连
          self.connected = false;
          console.log('[API客户端] 连接已关闭，3秒后重连...');

          // 自动重连（使用之前成功的端口）
          self.reconnectTimer = setTimeout(function () {
            self.connect();
          }, self.reconnectDelay);
        } else {
          // 连接从未成功，尝试下一个端口
          self.tryConnect(ports, index + 1, token);
        }
      };
    } catch (err) {
      this.connecting = false;
      console.error('[API客户端] ❌ 连接失败:', err);
      // 尝试下一个端口
      this.tryConnect(ports, index + 1, token);
    }
  },

  // 处理消息
  handleMessage: function (msg) {
    // 添加详细日志
    console.log('[API客户端] 收到 WebSocket 消息:', JSON.stringify(msg));

    if (msg.type === 'api_call') {
      this.handleAPICall(msg.data);
    } else if (msg.type === 'cmd') {
      console.log('[API客户端] 收到 cmd 指令, data:', JSON.stringify(msg.data));
      this.handleCommand(msg.data);
    } else if (msg.type === 'pong') {
      this.lastHeartbeatTime = Date.now();
    } else if (msg.type === 'task_progress' || msg.type === 'task_complete') {
      // 任务进度/完成广播，转发给任务采集器
      if (window.__wx_channels_search_task_collector) {
        window.__wx_channels_search_task_collector._onBackendMessage(msg);
      }
    } else {
      console.warn('[API客户端] 未知消息类型:', msg.type);
    }
  },

  collectClientState: function () {
    var methods = {};
    if (window.WXU) {
      methods.finderGetCommentDetail = !!(window.WXU.API && typeof window.WXU.API.finderGetCommentDetail === 'function');
      methods.finderUserPage = !!(window.WXU.API && typeof window.WXU.API.finderUserPage === 'function');
      methods.finderSearch = !!(window.WXU.API2 && typeof window.WXU.API2.finderSearch === 'function');
      methods.finderGetInteractionedFeedList = !!(window.WXU.API4 && typeof window.WXU.API4.finderGetInteractionedFeedList === 'function');
    }
    this.apiMethods = methods;
    return {
      pagePath: window.location.pathname,
      href: window.location.href,
      apiReady: !!(methods.finderGetCommentDetail || methods.finderUserPage || methods.finderSearch || methods.finderGetInteractionedFeedList),
      methods: methods,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      visible: !document.hidden
    };
  },

  sendClientState: function () {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify({
        type: 'client_state',
        data: this.collectClientState()
      }));
    } catch (err) {
      console.error('[API客户端] 发送客户端状态失败:', err);
    }
  },

  // 处理指令
  handleCommand: function (data) {
    console.log('[API客户端] ========== 处理指令 ==========');
    console.log('[API客户端] 收到指令:', JSON.stringify(data));
    console.log('[API客户端] window.__wx_channels_search_task_collector:', !!window.__wx_channels_search_task_collector);

    try {
      if (data.action === 'start_comment_collection') {
        if (typeof window.__wx_channels_start_comment_collection === 'function') {
          console.log('[API客户端] 执行评论采集指令...');
          window.__wx_channels_start_comment_collection();
        } else {
          console.warn('[API客户端] 评论采集函数未就绪');
        }
      }

      if (data.action === 'watch_video') {
        // 监听视频（不滚动），等待开始滚动指令
        var taskData = data.payload || data;
        console.log('[API客户端] ★★★ 收到 watch_video 指令:', taskData);

        if (typeof window.__wx_channels_search_task_collector === 'object') {
          console.log('[API客户端] ★★★ 调用 watchVideo, taskId:', taskData.task_id);
          window.__wx_channels_search_task_collector.watchVideo(taskData);
          console.log('[API客户端] ★★★ watchVideo 调用完成');
        } else {
          console.error('[API客户端] 搜索任务采集器未就绪, __wx_channels_search_task_collector:', typeof window.__wx_channels_search_task_collector);
        }
      }

      if (data.action === 'start_scroll') {
        // 开始滚动
        var taskData = data.payload || data;
        console.log('[API客户端] ★★★ 收到 start_scroll 指令:', taskData);

        if (typeof window.__wx_channels_search_task_collector === 'object') {
          console.log('[API客户端] ★★★ 调用 startScroll, taskId:', taskData.task_id);
          window.__wx_channels_search_task_collector.startScroll(taskData.task_id);
          console.log('[API客户端] ★★★ startScroll 调用完成');
        } else {
          console.error('[API客户端] 搜索任务采集器未就绪, __wx_channels_search_task_collector:', typeof window.__wx_channels_search_task_collector);
        }
      }

      if (data.action === 'pause_scroll') {
        // 暂停滚动
        var taskData = data.payload || data;
        console.log('[API客户端] 暂停滚动:', taskData);

        if (typeof window.__wx_channels_search_task_collector === 'object') {
          window.__wx_channels_search_task_collector.pauseScroll(taskData.task_id);
        } else {
          console.warn('[API客户端] 搜索任务采集器未就绪');
        }
      }

      if (data.action === 'resume_scroll') {
        // 恢复滚动
        var taskData = data.payload || data;
        console.log('[API客户端] 恢复滚动:', taskData);

        if (typeof window.__wx_channels_search_task_collector === 'object') {
          window.__wx_channels_search_task_collector.resumeScroll(taskData.task_id);
        } else {
          console.warn('[API客户端] 搜索任务采集器未就绪');
        }
      }

      if (data.action === 'stop_search_task') {
        // 停止搜索关键词视频采集任务
        var taskData = data.payload || data;
        console.log('[API客户端] 停止搜索任务:', taskData);

        if (typeof window.__wx_channels_search_task_collector === 'object') {
          window.__wx_channels_search_task_collector.stopTask(taskData.task_id);
        } else {
          console.warn('[API客户端] 搜索任务采集器未就绪');
        }
      }

      if (data.action === 'download_progress') {
        // 派发自定义事件，供 UI 组件消费
        var event = new CustomEvent('wx_download_progress', { detail: data.payload });
        document.dispatchEvent(event);
      }

      // DOM 操作指令
      if (data.action === 'dom_action') {
        console.log('[API客户端] 收到 DOM 操作指令:', data);
        this.handleDomAction(data).then(function(result) {
          console.log('[API客户端] DOM 操作结果:', result);
        }).catch(function(err) {
          console.error('[API客户端] DOM 操作失败:', err);
        });
      }
    } catch (err) {
      console.error('[API客户端] 处理指令异常:', err);
    }
  },

  // 处理 DOM 操作
  handleDomAction: async function(data) {
    var self = this;
    var action = data.action;
    var selector = data.selector;
    var content = data.content;
    var index = data.index || 0;

    // 内部函数：去除所有空白字符（空格、换行、制表符等）
    function _normalizeText(text) {
      if (!text) return '';
      return text.replace(/[\s\n\r\t]+/g, '').trim();
    }

    console.log('[API客户端] 执行 DOM 操作:', action, '选择器:', selector);

    try {
      var result = { success: false, action: action };

      // 等待页面稳定
      await new Promise(function(resolve) { setTimeout(resolve, 1000); });

      // 通过 preload 脚本的 DOM 操作方法执行
      if (window.__wx_dom_operator__ && typeof window.__wx_dom_operator__.execute === 'function') {
        var opResult = await window.__wx_dom_operator__.execute(action, selector, content, index);
        result = { ...result, ...opResult };
      } else {
        console.warn('[API客户端] __wx_dom_operator__ 未就绪，尝试直接执行');

        // 备用方案：直接通过 window.api 执行
        if (window.api && window.api.dom) {
          var apiResult = await window.api.dom.execute(action, selector, content, index);
          result = { ...result, ...apiResult };
        } else {
          result.message = 'DOM 操作接口未就绪';
          console.error('[API客户端] DOM 操作接口不可用');
        }
      }

      console.log('[API客户端] DOM 操作完成:', result);
      return result;
    } catch (err) {
      console.error('[API客户端] DOM 操作异常:', err);
      return { success: false, action: action, error: err.message };
    }
  },

  // 处理 API 调用请求
  handleAPICall: async function (data) {
    var id = data.id;
    var key = data.key;
    var body = data.body;

    // 内部函数：去除所有空白字符（空格、换行、制表符等）
    function _normalizeText(text) {
      if (!text) return '';
      return text.replace(/[\s\n\r\t]+/g, '').trim();
    }

    // 响应函数
    var self = this;
    function resp(responseData) {
      self.sendResponse(id, responseData);
    }

    try {
      // 等待 WXU.API 和 WXU.API2 初始化
      var maxWait = 10000; // 最多等待10秒
      var startTime = Date.now();

      while ((!window.WXU || !window.WXU.API || !window.WXU.API2) && (Date.now() - startTime < maxWait)) {
        console.log('[API客户端] 等待 WXU.API 初始化...');
        await new Promise(function (resolve) { setTimeout(resolve, 500); });
      }

      if (!window.WXU || !window.WXU.API || !window.WXU.API2) {
        resp({
          errCode: 1,
          errMsg: 'WXU.API 未初始化，请刷新页面重试'
        });
        return;
      }

      if (key === 'key:channels:contact_list') {
        // Correct Scene Mapping:
        // Type 1 (User): Scene 13 → infoList (supports pagination)
        // Type 2 (Live): Scene 13 → objectList (NO pagination support)
        // Type 3 (Video): Scene 19 → objectList (supports pagination)
        var scene = 13; // Default to Scene 13 for Type 1 and Type 2
        if (body.type == 3) {
          scene = 19; // Only Type 3 (Video) uses Scene 19
        }

        var payload = {
          query: body.keyword,
          scene: scene,
          requestId: String(new Date().valueOf()), // Unique request ID for every page
          lastBuffer: body.next_marker ? decodeURIComponent(body.next_marker) : '',
          lastBuff: body.next_marker ? decodeURIComponent(body.next_marker) : '', // Try alias
        };
        var r = await window.WXU.API2.finderSearch(payload);
        console.log('[API客户端] finderSearch 结果:', r);
        resp({
          ...r,
          payload: payload
        });
        return;
      }

      // 获取账号视频列表
      if (key === 'key:channels:feed_list') {
        var payload = {
          username: body.username,
          finderUsername: window.__wx_username || '',
          lastBuffer: body.next_marker ? decodeURIComponent(body.next_marker) : '',
          needFansCount: 0,
          objectId: '0'
        };
        var r = await window.WXU.API.finderUserPage(payload);
        console.log('[API客户端] finderUserPage 结果:', r);
        resp({
          ...r,
          payload: payload
        });
        return;
      }

      // 获取视频详情
      if (key === 'key:channels:feed_profile') {
        console.log('[API客户端] 获取视频详情:', body);

        try {
          var oid = body.objectId || body.object_id || body.oid || '';
          var nid = body.nonceId || body.nonce_id || body.nid || '';

          // 如果提供了 URL，从 URL 中解析 oid 和 nid
          if (body.url) {
            var u = new URL(decodeURIComponent(body.url));
            oid = window.WXU.API.decodeBase64ToUint64String(u.searchParams.get('oid'));
            nid = window.WXU.API.decodeBase64ToUint64String(u.searchParams.get('nid'));
          }

          if (!oid || !nid) {
            throw new Error('缺失 object_id 或 nonce_id');
          }

          var payload = {
            needObject: 1,
            lastBuffer: '',
            scene: 146,
            direction: 2,
            identityScene: 2,
            pullScene: 6,
            objectid: String(oid).includes('_') ? String(oid).split('_')[0] : String(oid),
            objectNonceId: nid,
            encrypted_objectid: ''
          };

          var r = await window.WXU.API.finderGetCommentDetail(payload);
          console.log('[API客户端] finderGetCommentDetail 结果:', r);
          resp({
            ...r,
            payload: payload
          });
          return;
        } catch (err) {
          console.error('[API客户端] 获取视频详情失败:', err);
          resp({
            errCode: 1011,
            errMsg: err.message,
            payload: body
          });
          return;
        }
      }

      // DOM Action API
      if (key === 'key:channels:dom_action') {
        console.log('[API客户端] 执行 DOM Action:', body);
        // 处理需要特殊处理的 action（会触发页面导航的操作）
        if (body.action === 'open_profile') {
          console.log('[API客户端] 检测到 open_profile，通过 HTTP 回调发送响应后执行导航');
          // 【优化】对于 open_profile，直接使用 HTTP 回调确保响应快速到达服务端
          // 因为页面导航会导致 WebSocket 断开，WebSocket 响应可能丢失
          this.sendResponseViaHTTP(id, { success: true, message: '正在打开: ' + (body.url || '') });
          // 延迟执行导航
          setTimeout(function() {
            // 导航前清理关键全局状态（应对 WeChatAppEx 不触发 beforeunload 的情况）
            // 确保下一个用户不会受到前一个用户残留状态的影响
            window.__wx_cached_cards = null;
            window.__wx_current_feed = null;
            // __wx_api_client 本身的连接会在 beforeunload 中关闭，connectToken 自增自动隔离旧消息
            // __wx_channels_profile_collector 会在新页面重新初始化，不需要手动清理

            console.log('[API客户端] 执行页面导航到:', body.url);
            if (body.url && body.url.trim()) {
              window.location.href = body.url;
            } else {
              window.location.reload();
            }
          }, 100);
          return;
        }
        if (body.action === 'enter_video') {
          // enter_video 也会导致页面跳转，通过 HTTP 回调确保响应快速到达
          var cachedCard = window.__wx_cached_cards && window.__wx_cached_cards[body.index];
          var videoTitle = cachedCard ? _normalizeText(cachedCard.videoTitle) : '';
          this.sendResponseViaHTTP(id, { success: true, message: '已进入视频页面', videoTitle: videoTitle });
          // 延迟执行点击
          var self = this;
          setTimeout(function() {
            var xpath = '//div[@ml-key="finder-profile-card" and not(.//div[contains(@class, "living-tag") or contains(@class, "live-card")])]';
            var elements = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            if (elements.snapshotLength > body.index) {
              var el = elements.snapshotItem(body.index);
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(function() {
                el.click();
              }, 500);
            }
          }, 100);
          return;
        }
        try {
          var result = await this.executeDomAction(body, id);
          if (result) {
            resp(result);
          }
        } catch (err) {
          resp({
            errCode: 1,
            errMsg: err.message || 'DOM Action 失败'
          });
        }
        return;
      }

      // 未匹配的 key
      resp({
        errCode: 1000,
        errMsg: '未匹配的key: ' + key,
        payload: data
      });

    } catch (err) {
      console.error('[API客户端] API 调用失败:', err);
      resp({
        errCode: 1,
        errMsg: err.message || 'API 调用失败',
        payload: data
      });
    }
  },

  // 执行 DOM Action
  executeDomAction: async function(body, requestId) {
    var self = this;
    var action = body.action || 'click_element';
    var target = body.target || 'video';
    var content = body.content || '';
    var index = body.index || 0;
    var url = body.url || '';

    // 内部函数：去除所有空白字符（空格、换行、制表符等）
    function _normalizeText(text) {
      if (!text) return '';
      return text.replace(/[\s\n\r\t]+/g, '').trim();
    }

    // ========== 页面类型检测工具函数 ==========
    // 检测当前页面是主页还是详情页
    function _detectPageType() {
      var result = {
        isDetailPage: false,
        isProfilePage: false,
        url: window.location.href,
        feedCount: 0
      };

      // 方法1：检查 URL 特征
      // 详情页 URL 通常包含视频相关参数
      var url = window.location.href;
      if (url.includes('oid=') || url.includes('nid=') || 
          url.includes('objectId=') || url.includes('nonceId=')) {
        result.isDetailPage = true;
        return result;
      }

      // 方法2：检查 DOM 中是否有 feed 容器（主页有 feed，详情页没有）
      var feedPattern = /id="(flow-feed-\d+)"/g;
      var fullHtml = document.documentElement.outerHTML;
      var matches = [...fullHtml.matchAll(feedPattern)];
      result.feedCount = matches.length;

      if (matches.length > 0) {
        result.isProfilePage = true;
        // 如果有多个 feed，认为是主页
        if (matches.length > 1) {
          result.isDetailPage = false;
        } else {
          // 只有一个 feed，可能是详情页中的推荐视频
          result.isDetailPage = false;
        }
      }

      // 方法3：检查 DOM 中是否有视频播放区域
      var hasVideoPlayer = document.querySelector('video') !== null;
      var hasLikeArea = document.querySelector('.like-area, [class*="like"]') !== null;
      
      if (hasVideoPlayer && hasLikeArea && matches.length === 0) {
        result.isDetailPage = true;
      }

      console.log('[API客户端] 页面检测结果:', result);
      return result;
    }
    // ========== 页面类型检测工具函数结束 ==========

    // ========== 重试机制工具函数 ==========
    var _RETRY_CONFIG = {
      maxRetries: 3,
      retryDelay: 1000,
      domRefreshDelay: 300
    };

    async function _waitForElement(checkFn, maxWait, pollInterval) {
      maxWait = maxWait || 3000;
      pollInterval = pollInterval || 500;
      var elapsed = 0;
      while (elapsed < maxWait) {
        if (window.__wx_parsers__) window.__wx_parsers__.refreshAllDom();
        var element = checkFn();
        if (element) return element;
        await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
        elapsed += pollInterval;
      }
      return null;
    }

    async function _executeWithRetry(actionFn, actionName, maxRetries, retryDelay) {
      maxRetries = maxRetries || _RETRY_CONFIG.maxRetries;
      retryDelay = retryDelay || _RETRY_CONFIG.retryDelay;
      for (var attempt = 1; attempt <= maxRetries; attempt++) {
        console.log('[API客户端] ' + actionName + ' 第' + attempt + '次尝试');
        if (window.__wx_parsers__) window.__wx_parsers__.refreshAllDom();
        await new Promise(function(resolve) { setTimeout(resolve, _RETRY_CONFIG.domRefreshDelay); });
        try {
          var result = await actionFn();
          if (result && result.success) {
            console.log('[API客户端] ' + actionName + ' 第' + attempt + '次尝试成功');
            return result;
          }
          console.log('[API客户端] ' + actionName + ' 第' + attempt + '次尝试失败:', result.message || result.error);
        } catch (err) {
          console.error('[API客户端] ' + actionName + ' 第' + attempt + '次尝试异常:', err.message);
        }
        if (attempt < maxRetries) {
          console.log('[API客户端] ' + actionName + ' 等待' + retryDelay + 'ms后重试...');
          await new Promise(function(resolve) { setTimeout(resolve, retryDelay); });
        }
      }
      // 所有重试都失败，收集 DOM 调试信息
      console.log('[API客户端] ' + actionName + ' 所有重试失败，收集 DOM 调试信息...');
      var domDebug = _collectDomDebugInfo();
      // 保存到全局变量，可在控制台直接访问 window.__domDebug__
      window.__domDebug__ = domDebug;
      console.log('[API客户端] DOM已保存到 window.__domDebug__，可直接在控制台查看');
      return {
        success: false,
        message: actionName + ' 已重试' + maxRetries + '次，仍失败',
        domDebug: domDebug
      };
    }

    // 收集原始 DOM 用于调试
    function _collectDomDebugInfo(scope) {
      scope = scope || document.documentElement;
      try {
        return {
          url: window.location.href,
          timestamp: new Date().toISOString(),
          html: scope.outerHTML || '' // 截断避免过大
        };
      } catch (err) {
        return { error: err.message, url: window.location.href };
      }
    }
    // ========== 重试机制工具函数结束 ==========

    // 内部函数：根据 videoTitle 查找匹配的 feed
    function _findFeedByTitle(targetTitle) {
      targetTitle = _normalizeText(targetTitle);
      console.log('[API客户端] _findFeedByTitle 开始匹配, targetTitle:', targetTitle);
      console.log('[API客户端] 目标标题长度:', targetTitle.length, '内容:', targetTitle.substring(0, 50));

      // 先检测页面类型
      var pageInfo = _detectPageType();

      // 【关键】如果当前是详情页（不是主页），直接返回 null
      // 因为详情页没有 flow-feed-* 容器，点赞按钮应该直接在整个页面中查找
      if (pageInfo.isDetailPage) {
        console.log('[API客户端] 当前在详情页，不使用 feed 匹配逻辑');
        return null;
      }

      // 获取页面完整 DOM
      var fullHtml = document.documentElement.outerHTML;
      // 清理 script 和 style
      fullHtml = fullHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
      fullHtml = fullHtml.replace(/<style[\s\S]*?<\/style>/gi, '');

      // 匹配所有 flow-feed- 容器
      var feedPattern = /id="(flow-feed-\d+)"/g;
      var feedMatches = [...fullHtml.matchAll(feedPattern)];
      console.log('[API客户端] 找到 ' + feedMatches.length + ' 个 feed');

      if (feedMatches.length === 0) {
        console.log('[API客户端] 未找到 flow-feed-* 容器');
        return null;
      }

      // 遍历每个 feed，查找匹配的
      for (var i = 0; i < feedMatches.length; i++) {
        var feedId = feedMatches[i][1];
        var feedStart = feedMatches[i].index;
        var feedEnd = (i + 1 < feedMatches.length) ? feedMatches[i + 1].index : fullHtml.length;
        var feedHtml = fullHtml.substring(feedStart, feedEnd);

        // 提取视频标题（多种选择器尝试）
        var videoTitle = '';
        // 尝试 compute-node 类
        var titleMatch = feedHtml.match(/<div[^>]*class="[^"]*compute-node[^"]*"[^>]*>([^<]+)/);
        if (titleMatch) {
          videoTitle = _normalizeText(titleMatch[1]);
        }
        // 尝试其他可能的标题选择器
        if (!videoTitle) {
          titleMatch = feedHtml.match(/aria-label="([^"]+)"/);
          if (titleMatch) {
            videoTitle = _normalizeText(titleMatch[1]);
          }
        }

        console.log('[API客户端] Feed#' + (i + 1) + ' (' + feedId + '): ' + videoTitle.substring(0, 50));

        // 检查是否匹配（仅匹配 videoTitle）
        var titleOk = !targetTitle || videoTitle.includes(targetTitle);
        if (titleOk && videoTitle) {
          console.log('[API客户端] ✅ 匹配到 feed: id=' + feedId + ', index=' + i + ', title=' + videoTitle);
          // 缓存到全局（feedId 使用完整的 ID，不是数组索引）
          window.__wx_current_feed = {
            videoTitle: videoTitle,
            html: feedHtml,
            feedIndex: i,
            feedId: feedId  // 完整的 feed ID，如 "flow-feed-14897893608660801591"
          };
          return window.__wx_current_feed;
        }
      }

      console.log('[API客户端] ❌ 未找到匹配的 feed');
      return null;
    }

    // 等待页面稳定
    await new Promise(function(resolve) { setTimeout(resolve, 500); });

    // 根据 target 确定选择器
    var selector = '';
    if (target === 'profile' || target === 'video') {
      selector = window.__wx_selectors__.like.unliked;
    } else if (target === 'comment') {
      selector = window.__wx_selectors__.comment.input;
    }

    // 使用 DOM Operator 执行操作
    if (window.__wx_dom_operator__ && typeof window.__wx_dom_operator__.execute === 'function') {
      var result = await window.__wx_dom_operator__.execute(action, selector, content, index);
      return {
        success: result.success || false,
        message: result.message || '',
        action: action,
        target: target,
        result: result
      };
    }

    // 备用方案：直接 DOM 操作
    try {
      // get_url 操作 - 获取当前页面 URL
      if (action === 'get_url') {
        console.log('[API客户端] get_url 请求');
        return {
          success: true,
          message: '获取 URL 成功',
          url: window.location.href
        };
      }

      // get_video_cards 操作 - 获取视频卡片列表
      if (action === 'get_video_cards') {
        console.log('[API客户端] get_video_cards 开始执行');
        var cards = [];
        // 获取视频卡片元素
        var cardElements = window.__wx_parsers__.getCardElements();
        console.log('[API客户端] 找到卡片数量:', cardElements.length);
        for (var i = 0; i < cardElements.length; i++) {
          var el = cardElements[i];
          var feedHtml = el.outerHTML;

          // 解析视频标题（normalize 去除空格换行）
          var videoTitle = _normalizeText(window.__wx_parsers__.parseTitle(feedHtml));

          cards.push({
            index: i,
            title: el.innerText.substring(0, 100),
            html: feedHtml,
            videoTitle: videoTitle
          });
        }
        // 缓存卡片数据供 enter_video 使用
        window.__wx_cached_cards = cards;
        return {
          success: true,
          count: cards.length,
          cards: cards,
          message: '找到 ' + cards.length + ' 个视频卡片'
        };
      }

      // find_feed 操作 - 根据 videoTitle 查找对应的 feed DOM
      if (action === 'find_feed') {
        var targetTitle = _normalizeText(body.videoTitle);
        var feedResult = _findFeedByTitle(targetTitle);

        if (feedResult) {
          return {
            success: true,
            feedHtml: feedResult.html,
            videoTitle: feedResult.videoTitle,
            feedIndex: feedResult.feedIndex,
            feedId: feedResult.feedId,
            message: '找到匹配的 feed #' + (feedResult.feedIndex + 1) + ' (id: ' + feedResult.feedId + ')'
          };
        }
        return { success: false, message: '未找到匹配的 feed', feedHtml: '', feedIndex: -1 };
      }

      // do_like 操作 - 执行点赞（带重试机制）
      if (action === 'do_like') {
        var targetTitle = body.videoTitle ? _normalizeText(body.videoTitle) : '';
        console.log('[API客户端] do_like 开始, targetTitle:', targetTitle);

        // 【关键】先检测页面类型，确保在详情页执行操作
        var pageInfo = _detectPageType();
        console.log('[API客户端] 当前页面类型检测:', pageInfo);

        // 如果检测到是主页，报告警告但继续尝试（可能主页还没完全关闭）
        if (pageInfo.isProfilePage && !pageInfo.isDetailPage) {
          console.warn('[API客户端] ⚠️ 检测到可能仍在主页，等待页面切换...');
          // 等待页面稳定
          await new Promise(function(resolve) { setTimeout(resolve, 2000); });
          // 重新检测
          pageInfo = _detectPageType();
          console.log('[API客户端] 重新检测页面类型:', pageInfo);
        }

        // 定义一次点赞尝试（每次都会重新获取 DOM）
        var likeAttempt = async function() {
          var likeBtn = null;
          var feedDom = null;

          var feedResult = null;
          if (targetTitle) {
            feedResult = _findFeedByTitle(targetTitle);
          }

          if (feedResult) {
            feedDom = document.getElementById(feedResult.feedId);
            if (feedDom) {
              if (window.__wx_parsers__.isLiked(feedDom)) {
                console.log('[API客户端] feed#' + feedResult.feedIndex + ' 已点赞，跳过');
                return { success: true, isLiked: true, message: '该视频已点赞' };
              }
              likeBtn = window.__wx_parsers__.getUnlikeBtn(feedDom);
              console.log('[API客户端] 从 feed#' + feedResult.feedIndex + ' 获取点赞按钮:', likeBtn ? '找到' : '未找到');
            } else {
              console.log('[API客户端] feed DOM 不存在，使用全局查找');
              likeBtn = window.__wx_parsers__.getUnlikeBtn();
            }
          } else {
            console.log('[API客户端] 未找到匹配的 feed，使用全局查找');
            if (window.__wx_parsers__.isLiked()) {
              console.log('[API客户端] 全局检测到已点赞，跳过');
              return { success: true, isLiked: true, message: '该视频已点赞' };
            }
            likeBtn = window.__wx_parsers__.getUnlikeBtn();
          }

          if (likeBtn) {
            likeBtn.click();
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
            return { success: true, isLiked: true, message: '点赞成功' };
          }
          console.log('[API客户端] 未找到点赞按钮');
          return { success: false, message: '未找到点赞按钮' };
        };

        return await _executeWithRetry(likeAttempt, 'do_like');
      }

      // do_follow 操作 - 执行关注（带重试机制）
      if (action === 'do_follow') {
        var targetTitle = body.videoTitle ? _normalizeText(body.videoTitle) : '';
        console.log('[API客户端] do_follow 开始, targetTitle:', targetTitle);

        // 【关键】先检测页面类型，确保在详情页执行操作
        var pageInfoFollow = _detectPageType();
        console.log('[API客户端] do_follow 页面类型检测:', pageInfoFollow);

        // 如果检测到是主页，报告警告
        if (pageInfoFollow.isProfilePage && !pageInfoFollow.isDetailPage) {
          console.warn('[API客户端] ⚠️ 检测到可能仍在主页（do_follow）');
        }

        var followAttempt = async function() {
          var followBtn = null;

          var feedResult = null;
          if (targetTitle) {
            feedResult = _findFeedByTitle(targetTitle);
          }

          if (feedResult) {
            var feedDom = document.getElementById(feedResult.feedId);
            if (feedDom) {
              if (window.__wx_parsers__.isFollowed(feedDom)) {
                console.log('[API客户端] feed#' + feedResult.feedIndex + ' 已关注，跳过');
                return { success: true, isFollowed: true, message: '该作者已关注' };
              }
              followBtn = window.__wx_parsers__.getFollowBtn(feedDom);
              console.log('[API客户端] 从 feed#' + feedResult.feedIndex + ' 获取关注按钮:', followBtn ? '找到' : '未找到');
            }
          }

          if (!followBtn) {
            var bottomArea = document.querySelector('.bottom-area');
            if (bottomArea && window.__wx_parsers__.isFollowed(bottomArea)) {
              console.log('[API客户端] bottom-area 检测到已关注，跳过');
              return { success: true, isFollowed: true, message: '该作者已关注' };
            }
            var areaFollowBtn = bottomArea ? bottomArea.querySelector('[class*="follow-btn"]') : null;
            if (areaFollowBtn) {
              followBtn = areaFollowBtn;
              console.log('[API客户端] bottom-area 范围内找到关注按钮');
            }
          }

          if (followBtn) {
            followBtn.click();
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
            return { success: true, isFollowed: true, message: '关注成功' };
          }
          console.log('[API客户端] 未找到关注按钮');
          return { success: false, message: '未找到关注按钮' };
        };

        return await _executeWithRetry(followAttempt, 'do_follow');
      }

      // do_comment 操作 - 执行评论（带重试机制）
      if (action === 'do_comment') {
        var commentText = body.content || '';

        // 【关键】先检测页面类型，确保在详情页执行操作
        var pageInfoComment = _detectPageType();
        console.log('[API客户端] do_comment 页面类型检测:', pageInfoComment);

        // 如果检测到是主页，报告警告并清除缓存的 feedId
        if (pageInfoComment.isProfilePage && !pageInfoComment.isDetailPage) {
          console.warn('[API客户端] ⚠️ 检测到可能仍在主页（do_comment），清除缓存的 feedId');
          // 清除缓存，避免使用主页的 feedId
          window.__wx_current_feed = null;
        }

        var commentAttempt = async function() {
          var feedInfo = window.__wx_current_feed || {};
          var feedId = feedInfo.feedId;
          // 【关键】如果不在详情页，不使用缓存的 feedId
          var feedDom = (feedId && pageInfoComment.isDetailPage) ? document.getElementById(feedId) : null;

          console.log('[API客户端] 开始评论, title:', feedInfo.videoTitle || '', ', pageType:', pageInfoComment);

          var commentBtn = null;
          if (feedDom) {
            commentBtn = feedDom.querySelector(window.__wx_selectors__.comment.btn);
            if (commentBtn) {
              console.log('[API客户端] 在 feed 中找到评论按钮');
            }
          }
          if (!commentBtn) {
            // 直接在当前页面查找评论按钮（不限于 feed 范围）
            var allCommentBtns = document.querySelectorAll('[aria-label^="评论"]');
            if (allCommentBtns.length > 0) {
              // 优先选择有数字的评论按钮（如"评论，123"）
              for (var i = 0; i < allCommentBtns.length; i++) {
                var label = allCommentBtns[i].getAttribute('aria-label') || '';
                if (/\d/.test(label)) {
                  commentBtn = allCommentBtns[i];
                  console.log('[API客户端] 全局查找评论按钮（带数字）:', label);
                  break;
                }
              }
              // 如果没找到带数字的，用第一个
              if (!commentBtn) {
                commentBtn = allCommentBtns[0];
                console.log('[API客户端] 全局查找评论按钮:', allCommentBtns[0].getAttribute('aria-label'));
              }
            }
          }

          if (!commentBtn) {
            console.log('[API客户端] 未找到评论按钮');
            return { success: false, message: '未找到评论按钮' };
          }

          commentBtn.click();
          await new Promise(function(resolve) { setTimeout(resolve, 3000); });

          window.__wx_parsers__.refreshAllDom();
          await new Promise(function(resolve) { setTimeout(resolve, 1000); });

          console.log('[API客户端] 评论按钮已点击，等待浮层渲染');

          // 轮询查找输入框
          var commentInput = null;
          var pollMax = 5;
          var pollDelay = 800;
          for (var pollI = 0; pollI < pollMax; pollI++) {
            commentInput = window.__wx_parsers__.getCommentInput();
            if (commentInput) {
              console.log('[API客户端] 第' + (pollI + 1) + '次轮询找到评论输入框');
              break;
            }
            window.__wx_parsers__.refreshAllDom();
            await new Promise(function(resolve) { setTimeout(resolve, pollDelay); });
          }

          if (!commentInput) {
            var placeholder = document.querySelector(window.__wx_selectors__.comment.placeholder);
            if (placeholder) {
              console.log('[API客户端] textarea 未就绪，点击占位符触发渲染');
              placeholder.click();
              await new Promise(function(resolve) { setTimeout(resolve, 1500); });
              commentInput = window.__wx_parsers__.getCommentInput();
            }
          }

          if (!commentInput) {
            console.log('[API客户端] 未找到评论输入框，检查页面状态...');
            await new Promise(function(resolve) { setTimeout(resolve, 2000); });
            var commentBtns = document.querySelectorAll('[aria-label^="评论"]');
            if (commentBtns.length === 0) {
              console.log('[API客户端] 评论按钮消失，推测评论已发出');
              return { success: true, isCommented: true, message: '评论已发送' };
            }
            return { success: false, message: '未找到评论输入框' };
          }

          console.log('[API客户端] 找到评论输入框');
          commentInput.focus();
          await new Promise(function(resolve) { setTimeout(resolve, 200); });

          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(commentInput, commentText);
          commentInput.dispatchEvent(new Event('input', { bubbles: true }));
          commentInput.dispatchEvent(new Event('change', { bubbles: true }));
          commentInput.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
          commentInput.dispatchEvent(new Event('keyup', { bubbles: true, cancelable: true }));
          commentInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: commentText }));

          await new Promise(function(resolve) { setTimeout(resolve, 800); });

          window.__wx_parsers__.refreshAllDom();
          await new Promise(function(resolve) { setTimeout(resolve, 1000); });

          var sendBtn = null;
          for (var pollJ = 0; pollJ < pollMax; pollJ++) {
            sendBtn = window.__wx_parsers__.getSendBtn();
            if (sendBtn) {
              console.log('[API客户端] 第' + (pollJ + 1) + '次轮询找到发送按钮');
              break;
            }
            await new Promise(function(resolve) { setTimeout(resolve, pollDelay); });
          }

          if (sendBtn) {
            sendBtn.click();
            await new Promise(function(resolve) { setTimeout(resolve, 2000); });
            window.__wx_parsers__.refreshAllDom();
            var closedCommentBtns = document.querySelectorAll('[aria-label^="评论"]');
            if (closedCommentBtns.length === 0) {
              console.log('[API客户端] 评论浮层已关闭，评论发送成功');
              setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
              return { success: true, isCommented: true, message: '评论已发送' };
            }
            console.log('[API客户端] 评论浮层仍显示，视为发送成功');
            setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
            return { success: true, isCommented: true, message: '评论已发送' };
          }

          console.log('[API客户端] 未找到发送按钮，尝试检测评论是否已发出...');
          var commentBtnsAfter = document.querySelectorAll('[aria-label^="评论"]');
          if (commentBtnsAfter.length === 0) {
            console.log('[API客户端] 评论浮层已关闭，评论已发出');
            setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
            return { success: true, isCommented: true, message: '评论已发送' };
          }
          console.log('[API客户端] 评论浮层未关闭，评论未发出');
          setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
          return { success: false, message: '未找到发送按钮，评论未发出' };
        };

        return await _executeWithRetry(commentAttempt, 'do_comment');
      }

      // get_status 操作 - 获取互动状态（先匹配 feed）
      if (action === 'get_status') {
        var targetTitle = _normalizeText(body.videoTitle);
        console.log('[API客户端] get_status 开始, targetTitle:', targetTitle);

        // 【关键】先检测页面类型，确保在详情页执行操作
        var pageInfoStatus = _detectPageType();
        console.log('[API客户端] get_status 页面类型检测:', pageInfoStatus);

        // 先尝试匹配 feed
        var feedResult = null;
        if (targetTitle && !pageInfoStatus.isDetailPage) {
          feedResult = _findFeedByTitle(targetTitle);
        } else if (pageInfoStatus.isDetailPage) {
          console.log('[API客户端] 详情页模式，不使用 feed 匹配');
        }

        var isLiked = false;
        var isFollowed = false;

        if (feedResult) {
          var feedIndex = feedResult.feedIndex;
          var feedId = feedResult.feedId;
          var feedDom = document.getElementById(feedId);

          if (feedDom) {
            // 传入 DOM 元素，让 isFollowed 扩大检查范围到 bottom-area
            isLiked = window.__wx_parsers__.isLiked(feedDom);
            isFollowed = window.__wx_parsers__.isFollowed(feedDom);

            console.log('[API客户端] 从 feed#' + feedIndex + ' 获取状态: liked=' + isLiked + ', followed=' + isFollowed);
          } else {
            console.log('[API客户端] 找到 feed 但 DOM 不存在，尝试 bottom-area 范围获取');
            var bottomArea = document.querySelector('.bottom-area');
            if (bottomArea) {
              isLiked = window.__wx_parsers__.isLiked(bottomArea);
              isFollowed = window.__wx_parsers__.isFollowed(bottomArea);
            } else {
              isLiked = window.__wx_parsers__.isLiked();
              isFollowed = window.__wx_parsers__.isFollowed();
            }
          }
        } else {
          // 兜底：使用 bottom-area 范围
          console.log('[API客户端] 未找到 feed，使用 bottom-area 范围获取状态');
          var bottomArea = document.querySelector('.bottom-area');
          if (bottomArea) {
            isLiked = window.__wx_parsers__.isLiked(bottomArea);
            isFollowed = window.__wx_parsers__.isFollowed(bottomArea);
          } else {
            isLiked = window.__wx_parsers__.isLiked();
            isFollowed = window.__wx_parsers__.isFollowed();
          }
          console.log('[API客户端] bottom-area 获取状态: liked=' + isLiked + ', followed=' + isFollowed);
        }

        return {
          success: true,
          isLiked: isLiked,
          isFollowed: isFollowed,
          followStatus: isFollowed ? '已关注' : '未关注',
          message: '已点赞:' + isLiked + ', 已关注:' + isFollowed
        };
      }

      // go_back 操作 - 返回上一页
      if (action === 'go_back') {
        window.history.back();
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
        return { success: true, message: '已返回上一页' };
      }

      // close_page 操作 - 关闭当前页面
      if (action === 'close_page') {
        try { window.close(); } catch(e) {}
        return { success: true, method: 'window_close', message: '页面已关闭 (window.close)' };
      }

      // pause_video 操作 - 暂停视频播放（分层降级策略 + currentTime 差值验证）
      if (action === 'pause_video') {
        var maxRetries = 5;
        var retryDelay = 300;

        // 先检查视频是否已在暂停状态（通过 currentTime 差值）
        var initVideos = document.querySelectorAll('video');
        var playingVideos = [];
        for (var av = 0; av < initVideos.length; av++) {
          if (initVideos[av].offsetWidth > 0 && initVideos[av].offsetHeight > 0 && !initVideos[av].paused) {
            playingVideos.push(initVideos[av]);
          }
        }
        if (playingVideos.length === 0) {
          console.log('[API客户端] 没有正在播放的视频，无需暂停');
          return { success: true, isPaused: true, message: '视频已暂停', byMethod: 'already_paused' };
        }

        // 辅助函数：通过 currentTime 差值确认视频真的停止了
        var _isVideoActuallyPaused = function(v) {
          if (!v || v.paused) return false;
          var t1 = v.currentTime;
          var t2 = v.currentTime;
          try { t2 = v.currentTime; } catch(e) {}
          // 等待一帧后再读一次，时间不增长才算真正暂停
          var t3 = t1;
          var dom = v;
          // 使用 Promise 延迟读取
          return new Promise(function(resolve) {
            setTimeout(function() {
              try { t3 = dom.currentTime; } catch(e) {}
              resolve(Math.abs(t3 - t1) < 0.05);
            }, 100);
          });
        };

        // 同步版：通过 double-read 立即判断
        var _checkPausedSync = function(v) {
          if (!v) return false;
          if (v.paused) return true;
          var t1 = 0, t2 = 0;
          try { t1 = v.currentTime; } catch(e) {}
          try { t2 = v.currentTime; } catch(e) {}
          return v.paused || Math.abs(t2 - t1) < 0.05;
        };

        for (var retry = 0; retry < maxRetries; retry++) {
          console.log('[API客户端] 暂停重试 ' + (retry + 1) + '/' + maxRetries);

          // ========== 每次重试前重新查询 DOM ==========
          var targetVideo = null;
          var curVideos = document.querySelectorAll('video');
          for (var vi = 0; vi < curVideos.length; vi++) {
            if (curVideos[vi].offsetWidth > 0 && curVideos[vi].offsetHeight > 0 && !curVideos[vi].paused) {
              targetVideo = curVideos[vi];
              break;
            }
          }

          // ========== 策略 1: video.pause() 直接暂停 ==========
          if (targetVideo) {
            // 记录暂停前的 currentTime 作为基准
            var timeBefore = 0;
            try { timeBefore = targetVideo.currentTime; } catch(e) {}
            targetVideo.pause();
            // 等待视频引擎响应
            await new Promise(function(resolve) { setTimeout(resolve, 300); });
            // 通过 currentTime 差值验证真的暂停了
            var timeAfter = 0;
            try { timeAfter = targetVideo.currentTime; } catch(e) {}
            var isStopped = targetVideo.paused && Math.abs(timeAfter - timeBefore) < 0.1;
            console.log('[API客户端] video.pause() 验证: paused=' + targetVideo.paused + ', timeBefore=' + timeBefore.toFixed(2) + ', timeAfter=' + timeAfter.toFixed(2) + ', isStopped=' + isStopped);
            if (isStopped) {
              console.log('[API客户端] video.pause() 暂停成功');
              return { success: true, isPaused: true, message: '暂停成功 (video.pause)', byMethod: 'video_element' };
            }
            console.log('[API客户端] video.pause() 未生效，尝试按钮');
          } else {
            console.log('[API客户端] 未找到正在播放的视频，等待重试');
          }

          // ========== 策略 2: XPath 按钮 ==========
          var xpathSelectors = [
            '//button[@aria-label="暂停"]',
            '//button[contains(@aria-label, "暂停")]',
            '//div[@role="button"][@aria-label="暂停"]',
            '//svg[@ml-key="flow-video-pause"]',
          ];

          var foundBtn = null;
          for (var x = 0; x < xpathSelectors.length; x++) {
            var result = document.evaluate(xpathSelectors[x], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (result.singleNodeValue) {
              foundBtn = result.singleNodeValue;
              console.log('[API客户端] XPath 找到暂停按钮: ' + xpathSelectors[x]);
              break;
            }
          }

          // ========== 策略 3: CSS 选择器 ==========
          if (!foundBtn) {
            var cssSelectors = ['[aria-label="暂停"]', '[data-action="pause"]', '[class*="pause"][class*="btn"]'];
            for (var ci = 0; ci < cssSelectors.length; ci++) {
              var els = document.querySelectorAll(cssSelectors[ci]);
              for (var cj = 0; cj < els.length; cj++) {
                var aria = els[cj].getAttribute('aria-label') || '';
                if (aria.includes('暂停')) {
                  foundBtn = els[cj];
                  break;
                }
              }
              if (foundBtn) break;
            }
          }

          if (foundBtn) {
            var btnBeforeLabel = (foundBtn.getAttribute('aria-label') || '').trim();
            console.log('[API客户端] 点击前按钮 aria-label: "' + btnBeforeLabel + '"');
            // 只对"暂停"按钮执行点击，跳过已是"播放"状态的按钮
            if (!btnBeforeLabel.includes('暂停')) {
              console.log('[API客户端] 按钮不是暂停按钮（当前为"' + btnBeforeLabel + '"），跳过');
            } else {
              // 记录点击前的 currentTime
              var timeBeforeBtn = 0;
              if (targetVideo) { try { timeBeforeBtn = targetVideo.currentTime; } catch(e) {} }
              foundBtn.click();
              await new Promise(function(resolve) { setTimeout(resolve, 400); });
              // 验证 currentTime 是否停止增长
              var timeAfterBtn = timeBeforeBtn;
              if (targetVideo) { try { timeAfterBtn = targetVideo.currentTime; } catch(e) {} }
              var isVideoStopped = targetVideo ? (targetVideo.paused || Math.abs(timeAfterBtn - timeBeforeBtn) < 0.15) : false;
              var btnAfterLabel = (foundBtn.getAttribute('aria-label') || '').trim();
              var isBtnToggled = btnAfterLabel.includes('播放');
              console.log('[API客户端] 点击后验证: timeBefore=' + timeBeforeBtn.toFixed(2) + ', timeAfter=' + timeAfterBtn.toFixed(2) + ', isVideoStopped=' + isVideoStopped + ', btnLabel="' + btnAfterLabel + '"');
              if (isVideoStopped && isBtnToggled) {
                console.log('[API客户端] 点击按钮暂停成功');
                return { success: true, isPaused: true, message: '暂停成功 (点击按钮)', byMethod: 'button_click' };
              }
              console.log('[API客户端] 点击后未确认暂停，继续重试');
            }
          }

          // ========== 策略 4: 键盘空格键兜底 ==========
          if (targetVideo) {
            targetVideo.focus();
          }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', keyCode: 32, bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', keyCode: 32, bubbles: true }));
          await new Promise(function(resolve) { setTimeout(resolve, 300); });
          var timeKbBefore = 0, timeKbAfter = 0;
          if (targetVideo) {
            try { timeKbBefore = targetVideo.currentTime; } catch(e) {}
          }
          await new Promise(function(resolve) { setTimeout(resolve, 100); });
          if (targetVideo) {
            try { timeKbAfter = targetVideo.currentTime; } catch(e) {}
          }
          var isKbStopped = targetVideo ? (targetVideo.paused || Math.abs(timeKbAfter - timeKbBefore) < 0.15) : false;
          if (isKbStopped) {
            console.log('[API客户端] 空格键暂停成功');
            return { success: true, isPaused: true, message: '暂停成功 (空格键)', byMethod: 'keyboard' };
          }

          if (retry < maxRetries - 1) {
            await new Promise(function(resolve) { setTimeout(resolve, retryDelay); });
          }
        }

        console.log('[API客户端] 暂停失败: 所有策略均未生效');
        return {
          success: false,
          isPaused: false,
          message: '暂停失败: 所有策略均未生效',
          triedMethods: ['video_element', 'xpath_button', 'css_button', 'keyboard']
        };
      }

      // 通用点击操作
      if (action === 'click_element' || action === 'click') {
        var elements = document.querySelectorAll(selector);
        if (elements.length > index) {
          elements[index].click();
          return { success: true, message: '点击成功', action: action, target: target };
        }
        return { success: false, message: '未找到元素', action: action, target: target };
      }

      // 通用输入操作
      if (action === 'input_text' || action === 'input') {
        var inputEl = document.querySelector(selector);
        if (inputEl) {
          inputEl.value = content;
          inputEl.focus();
          return { success: true, message: '输入成功', action: action, target: target };
        }
        return { success: false, message: '未找到输入框', action: action, target: target };
      }

      return { success: false, message: '未知操作: ' + action };
    } catch (err) {
      return { success: false, message: err.message, error: err.message };
    }
  },

  // 发送响应
  sendResponse: function (id, responseData) {
    var self = this;
    console.log('[API客户端] sendResponse 被调用, id:', id, 'data:', JSON.stringify(responseData).substring(0, 200));

    // 【修复】检查 WebSocket 连接状态，如果已断开则通过 HTTP 回调
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[API客户端] WebSocket 未连接，通过 HTTP 回调发送响应');
      this.sendResponseViaHTTP(id, responseData);
      return;
    }

    // 构建响应消息
    // 后端期望的格式: {type: "api_response", data: {id: "xxx", data: {...}, errCode: 0, errMsg: "ok"}}
    var msg = {
      type: 'api_response',
      data: {
        id: id,
        data: responseData,  // 整个 responseData 作为 data 字段
        errCode: responseData.errCode || 0,
        errMsg: responseData.errMsg || 'ok'
      }
    };

    try {
      var msgStr = JSON.stringify(msg);
      console.log('[API客户端] 发送响应消息:', msgStr.substring(0, 200));
      this.ws.send(msgStr);
      console.log('[API客户端] 响应发送成功');
    } catch (err) {
      console.error('[API客户端] 发送响应失败:', err);
      // 【修复】WebSocket 发送失败时，尝试 HTTP 回调
      this.sendResponseViaHTTP(id, responseData);
    }
  },

  // 通过 HTTP 回调发送响应（WebSocket 断开时的备选方案）
  sendResponseViaHTTP: function (id, responseData) {
    var self = this;
    var callbackUrl = 'http://127.0.0.1:2025/__wx_channels_api/response_callback';

    var payload = {
      id: id,
      data: {
        errCode: responseData.errCode || 0,
        errMsg: responseData.errMsg || 'ok',
        data: responseData
      }
    };

    fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      signal: AbortSignal.timeout(5000)
    }).then(function(response) {
      if (response.ok) {
        console.log('[API客户端] HTTP 回调响应发送成功');
      } else {
        console.error('[API客户端] HTTP 回调响应发送失败:', response.status);
      }
    }).catch(function(err) {
      console.error('[API客户端] HTTP 回调失败:', err.message);
    });
  },

  // 启动心跳
  startHeartbeat: function () {
    var self = this;

    // 清除旧的心跳定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // 重置心跳计数
    this.missedHeartbeats = 0;
    this.lastHeartbeatTime = Date.now();

    // 每 30 秒发送一次心跳
    this.heartbeatTimer = setInterval(function () {
      self.sendHeartbeat();
    }, 30000);

    console.log('[API客户端] ✅ 心跳已启动 (30秒间隔)');
  },

  // 停止心跳
  stopHeartbeat: function () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[API客户端] ⏹️ 心跳已停止');
    }
  },

  // 发送心跳
  sendHeartbeat: function () {
    if (!this.connected || !this.ws) {
      console.warn('[API客户端] 无法发送心跳：未连接');
      this.missedHeartbeats++;

      // 连续 3 次心跳失败，触发重连
      if (this.missedHeartbeats >= 3) {
        console.error('[API客户端] 心跳连续失败，触发重连...');
        this.stopHeartbeat();

        // 关闭当前连接
        if (this.ws) {
          try {
            this.ws.close();
          } catch (e) {
            // ignore
          }
        }

        // 立即重连
        this.connected = false;
        this.connect();
      }
      return;
    }

    try {
      var heartbeat = {
        type: 'ping',
        timestamp: Date.now()
      };

      this.ws.send(JSON.stringify(heartbeat));
      this.lastHeartbeatTime = Date.now();

      // 【修复】同时发送 client_state，确保后端有最新的页面路径
      this.sendClientState();
      this.missedHeartbeats = 0;

      console.log('[API客户端] 💓 心跳已发送');
    } catch (err) {
      console.error('[API客户端] 发送心跳失败:', err);
      this.missedHeartbeats++;
    }
  }
};

// 自动初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    window.__wx_api_client.init();
  });
} else {
  window.__wx_api_client.init();
}

// 监听初始化事件，获取用户名
if (window.WXE && window.WXE.onInit) {
  window.WXE.onInit(function (data) {
    if (data && data.mainFinderUsername) {
      window.__wx_username = data.mainFinderUsername;
      console.log('[API客户端] 已获取用户名:', window.__wx_username);
    }
  });
}

if (window.WXE && window.WXE.onAPILoaded) {
  window.WXE.onAPILoaded(function () {
    if (window.__wx_api_client) {
      // 等待 WXU 初始化完成后再发送状态
      setTimeout(function() {
        window.__wx_api_client.sendClientState();
      }, 1000);
    }
  });
}

console.log('[api_client.js] API 客户端模块加载完成');


// ============================================
// 统一的选择器和解析器
// ============================================
window.__wx_selectors__ = {
  card: {
    container: 'div[ml-key="finder-profile-card"]',
    excludeLive: '.living-tag, .live-card',
  },

  // ---------- 点赞按钮 ----------
  like: {
    all: 'div[aria-label*="点赞"]',
    unliked: 'div[aria-label*="点赞"]',
  },

  // ---------- 关注按钮 ----------
  follow: {
    all: '[aria-label*="关注"], button',
  },

  // ---------- 评论 ----------
  comment: {
    btn: '[aria-label^="评论"]',
    placeholder: 'div.placeholder-desc',
    input: 'textarea.weui-textarea',
    inputContainer: '.input-box',
    sendBtn: '.weui-btn.weui-btn_primary',
    sendText: '评论',
  },

  // ---------- 视频控制 ----------
  video: {
    pause: 'button[@aria-label="暂停"]',
  },

  // ---------- 通用 ----------
  common: {
    btn: 'button',
  }
};

// ---------- 正则表达式 ----------
window.__wx_regex__ = {
  REG_AUTHOR: /data-v-e3ad9fac[^>]*>[\s\S]*?<div[^>]*class="[^"]*text-sm[^"]*font-medium[^"]*text-white[^"]*"[^>]*>([^<]+)/g,
  REG_TITLE: /<div[^>]*class="[^"]*compute-node[^"]*"[^>]*>([^<]+)/,
  REG_COMMENT_COUNT: /aria-label="评论(?:，(\d+))?"/,
  REG_CARD_TITLE: /<div[^>]*class="[^"]*profile-object-title[^"]*"[^>]*title="([^"]+)"/,
  // 点赞正则：三种情况全覆盖
  // 1. 点赞（无数字）    - 未点赞
  // 2. 点赞，数字        - 未点赞（数字可能是 123 或 4.6万）
  // 3. 点赞，数字，取消点赞 - 已点赞
  REG_LIKE_UNLIKED: /^点赞$/,
  REG_LIKE_UNLIKED_WITH_NUM: /^点赞，[\d.万\+]+$/,
  REG_LIKE_LIKED: /，取消点赞$/,
};

// ---------- 解析函数 ----------
window.__wx_parsers__ = {
  // ========== 点赞 ==========
  // 统一查找：所有 div[aria-label]
  _getLikeBtns: function(rootEl) {
    return (rootEl || document).querySelectorAll('div[aria-label]');
  },

  // 判断是否已点赞
  isLiked: function(rootEl) {
    return this.getLikedBtn(rootEl) !== null;
  },

  // 获取已点赞按钮
  getLikedBtn: function(rootEl) {
    var btns = this._getLikeBtns(rootEl);
    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].getAttribute('aria-label') || '';
      if (window.__wx_regex__.REG_LIKE_LIKED.test(label)) return btns[i];
    }
    return null;
  },

  // 获取未点赞按钮
  getUnlikeBtn: function(rootEl) {
    var btns = this._getLikeBtns(rootEl);
    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].getAttribute('aria-label') || '';
      if (window.__wx_regex__.REG_LIKE_UNLIKED.test(label)) return btns[i];
      if (window.__wx_regex__.REG_LIKE_UNLIKED_WITH_NUM.test(label)) return btns[i];
    }
    return null;
  },

  // ========== 关注 ==========
  // 未关注正则：<button class="...follow-btn...">文本</button>
  REG_FOLLOW_BTN: /<button[^>]*class=["'][^"']*follow-btn[^"']*["'][^>]*>(.*?)<\/button>/s,
  // 已关注正则：<div class="...bg-white/5...">已关注</div>
  REG_FOLLOWED: /<div[^>]*class="[^"]*bg-white\/5[^"]*"[^>]*>\s*已关注\s*<\/div>/,
  // 互相关注正则：<div class="...bg-white/5...">互相关注</div>
  REG_MUTUAL: /<div[^>]*class="[^"]*bg-white\/5[^"]*"[^>]*>\s*互相关注\s*<\/div>/,

  isFollowed: function(feedDom) {
    // feedDom 可以是 DOM 元素或字符串
    // "已关注" badge 不在 feed 容器内，需要扩大到 bottom-area 区域
    if (feedDom && typeof feedDom === 'object' && feedDom.innerHTML) {
      // feedDom 是 DOM 元素，扩大到 bottom-area 范围
      var bottomArea = feedDom.closest('.bottom-area') || feedDom;
      var html = bottomArea.innerHTML;
      return this.REG_FOLLOWED.test(html) || this.REG_MUTUAL.test(html);
    }
    // feedDom 是字符串（HTML）
    var html = (typeof feedDom === 'string') ? feedDom : document.body.innerHTML;
    return this.REG_FOLLOWED.test(html) || this.REG_MUTUAL.test(html);
  },

  getFollowBtn: function(feedHtml) {
    // feedHtml 可以是字符串或 DOM 元素
    var html;
    var searchRoot;
    if (feedHtml && typeof feedHtml === 'object' && feedHtml.innerHTML) {
      // DOM 元素：取 bottom-area 范围
      var bottomArea = feedHtml.closest('.bottom-area') || feedHtml;
      searchRoot = bottomArea;
      html = bottomArea.innerHTML;
    } else {
      html = feedHtml || document.body.innerHTML;
      searchRoot = document;
    }
    var match = html.match(this.REG_FOLLOW_BTN);
    if (match) {
      // 通过 outerHTML 找到真实 DOM 元素
      var idx = html.indexOf(match[0]);
      var tempDiv = document.createElement('div');
      tempDiv.innerHTML = html.substring(0, idx + match[0].length);
      var btn = tempDiv.querySelector('button.follow-btn, [class*="follow-btn"]');
      if (btn) {
        // 在 searchRoot 范围内精确查找
        return searchRoot.querySelector('[class*="follow-btn"]');
      }
    }
    // 找不到 follow-btn 按钮时，说明已经是"已关注"状态，返回 null
    // 不要盲目用 document 全局查找，那样会匹配到其他 feed 的按钮
    return null;
  },

  // ========== HTML 解析 ==========
  parseAuthor: function(feedHtml) {
    if (!feedHtml) return '';
    var matches = feedHtml.match(window.__wx_regex__.REG_AUTHOR);
    if (matches && matches[0]) {
      var m = matches[0].match(/>([^<]+)$/);
      return m ? m[1].trim() : '';
    }
    return '';
  },

  parseTitle: function(feedHtml) {
    if (!feedHtml) return '';
    var m = feedHtml.match(window.__wx_regex__.REG_CARD_TITLE);
    if (m && m[1]) return m[1].trim();
    m = feedHtml.match(window.__wx_regex__.REG_TITLE);
    if (m && m[1]) return m[1].trim();
    return '';
  },

  parseCardTitle: function(feedHtml) {
    if (!feedHtml) return '';
    var m = feedHtml.match(window.__wx_regex__.REG_CARD_TITLE);
    return (m && m[1]) ? m[1].trim() : '';
  },

  parseCommentCount: function(feedHtml) {
    if (!feedHtml) return null;
    var m = feedHtml.match(window.__wx_regex__.REG_COMMENT_COUNT);
    return (m && m[1]) ? m[1] : null;
  },

  // ========== 评论 ==========
  getCommentBtn: function(feedHtml) {
    var btns = document.querySelectorAll('[aria-label^="评论"]');
    if (!btns.length) return null;
    if (feedHtml) {
      var count = this.parseCommentCount(feedHtml);
      if (count) {
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].getAttribute('aria-label') === '评论，' + count) return btns[i];
        }
      }
    }
    return btns[0];
  },

  getCommentInput: function() {
    return document.querySelector('textarea.weui-textarea');
  },

  getSendBtn: function() {
    // 优先用 aria-label 定位（最可靠）
    var labeled = document.querySelector('[aria-label="评论"][role="button"], [aria-label="发送"][role="button"], [aria-label="发布"]');
    if (labeled) return labeled;

    // 方案1：.input-box 容器内查找
    var container = document.querySelector('.input-box');
    if (container) {
      var btns = container.querySelectorAll('.weui-btn, [role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === '评论' || text === '发送' || text === '发布') return btns[i];
      }
    }

    // 方案2：全局查找评论发送按钮
    var allBtns = document.querySelectorAll('[role="button"], button, a');
    for (var j = 0; j < allBtns.length; j++) {
      var t = allBtns[j].textContent.trim();
      if (t === '评论' || t === '发送' || t === '发布') {
        var parent = allBtns[j].closest('.input-box, .comment-box, [class*="input"], [class*="send"]');
        if (parent) return allBtns[j];
      }
    }

    // 方案3：直接查找主色调按钮
    var primaryBtns = document.querySelectorAll('.weui-btn_primary, [class*="primary"][class*="btn"]');
    for (var k = 0; k < primaryBtns.length; k++) {
      var pt = primaryBtns[k].textContent.trim();
      if (pt === '评论' || pt === '发送') return primaryBtns[k];
    }

    return null;
  },

  // ========== 其他 ==========
  refreshAllDom: function() {
    window.scrollBy(0, 1);
    window.scrollBy(0, -1);
    if (typeof window.__vue__ !== 'undefined') window.__vue__.$forceUpdate();
    return { domReady: true, timestamp: Date.now() };
  },

  getCardElements: function() {
    var cards = [];
    var els = document.querySelectorAll('div[ml-key="finder-profile-card"]');
    for (var i = 0; i < els.length; i++) {
      if (!els[i].querySelector('.living-tag, .live-card')) cards.push(els[i]);
    }
    return cards;
  }
};

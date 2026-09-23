/**
 * @file API 客户端 - 通过 WebSocket 与后端通信
 */

// 日志辅助函数 - 使用 fetch 发送到服务端日志
var __api_log = (function() {
  var levels = { 'INF': 0, 'WRN': 1, 'ERR': 2, 'DBG': 3 };
  var currentLevel = 0; // 0=INF, 1=WRN, 2=ERR, 3=DBG

  return function(level, ...args) {
    if (levels[level] < currentLevel) return;
    var prefix = level === 'DBG' ? 'DBG' : level;
    var message = args.map(function(arg) {
      if (typeof arg === 'object' && arg !== null) {
        try { return JSON.stringify(arg); } catch(e) { return String(arg); }
      }
      return String(arg);
    }).join(' ');

    // 输出到控制台（会被日志面板捕获）
    if (level === 'ERR') {
      console.error('[API客户端] ' + message);
    } else if (level === 'WRN') {
      console.warn('[API客户端] ' + message);
    } else {
      console.log('[API客户端] ' + message);
    }

    // 发送到服务端日志 (使用 fetch 而不是依赖全局 __wx_log)
    fetch("/__wx_channels_api/tip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: prefix + ' ' + message }),
    }).catch(function(err) {
      console.error('[API客户端] 日志发送失败:', err);
    });
  };
})();

console.log('[api_client.js] 加载 API 客户端模块');

// ============================================================
// 评论操作 DOM 选择器配置（V2 版本）
// ============================================================
window.__wx_comment_selectors__ = {
  // 评论行选择器
  commentItemSelectors: [
    'div.comment-item',
    '.comment-list .comment-item',
    '[class*="comment-list"] > [class*="comment"]',
    '.comment-panel .comment-item'
  ],

  // 评论人昵称选择器
  commentUserNameSelector: 'span.comment-user-name',

  // 评论内容选择器
  commentContentSelector: 'div.comment-content',

  // 点赞按钮选择器
  likeButtonSelector: 'div.like-num',

  // 回复按钮容器选择器（需匹配 span 内容为"回复"）
  replyButtonSelectors: ['div.action-item', 'div.click-box'],

  // 回复按钮文本
  replyButtonText: '回复',

  // 回复输入框选择器（placeholder 以"回复 "开头）
  replyInputSelector: 'textarea.weui-textarea',

  // 回复输入框 placeholder 前缀
  replyInputPlaceholderPrefix: '回复 ',

  // 回复发送按钮选择器
  replySendButtonSelector: 'div.weui-btn'
};

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
    console.log('[API客户端] 收到 WebSocket 消息:', JSON.stringify(msg));

    if (msg.type === 'api_call') {
      this.handleAPICall(msg.data);
    } else if (msg.type === 'cmd') {
      console.log('[API客户端] 收到 cmd 指令, data:', JSON.stringify(msg.data));
      this.handleCommand(msg.data);
    } else if (msg.type === 'pong') {
      this.lastHeartbeatTime = Date.now();
    } else if (msg.type === 'ping') {
      // 收到 Hub 的主动探测，回复 pong
      this.ws.send(JSON.stringify({ type: 'pong' }));
      this.lastHeartbeatTime = Date.now();
      console.log('[API客户端] 💓 收到 Hub ping，已回复 pong');
    } else if (msg.type === 'task_progress' || msg.type === 'task_complete') {
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
        var taskData = data.payload || data;
        var snapshotTaskId = taskData.task_id || '';
        console.log('[API客户端] 执行评论采集指令, task_id=' + snapshotTaskId + '...');

        // 设置全局任务ID，dumpAllPiniaStores 会读取并上报
        window.__snapshotTaskId = snapshotTaskId;

        // 监听评论采集完成信号，采集完成后自动保存快照（参考 feed.js 按钮逻辑）
        var originalWxLog = typeof __wx_log === 'function' ? __wx_log : null;
        var snapshotSaved = false;

        function onCollectionDone() {
          if (snapshotSaved) return;
          snapshotSaved = true;
          var savedWxLog = originalWxLog;
          if (savedWxLog) __wx_log = savedWxLog;
          if (typeof window.dumpAllPiniaStores === 'function') {
            window.dumpAllPiniaStores().then(function(path) {
              console.log('[API客户端] 评论快照已保存: ' + (path || '(空)'));
              if (savedWxLog) savedWxLog({ msg: '📸 评论快照已保存: ' + (path || '(空)') });
            });
          }
        }

        __wx_log = function (data) {
          if (originalWxLog) originalWxLog(data);
          if (snapshotSaved) return;
          var msg = data && data.msg;
          if (!msg) return;
          if (msg.indexOf('✅ 评论采集完成') !== -1 || msg.indexOf('⚠️ 采集停止') !== -1 || msg.indexOf('✅ 评论已保存') !== -1) {
            console.log('[API客户端] 检测到采集完成信号: ' + msg);
            onCollectionDone();
          }
        };

        if (typeof window.__start_feed_comment_collection_with_open_panel === 'function') {
          window.__start_feed_comment_collection_with_open_panel();
        } else {
          console.warn('[API客户端] 评论采集函数未就绪，尝试直接调用...');
          if (typeof window.__wx_channels_start_comment_collection === 'function') {
            window.__wx_channels_start_comment_collection();
          }
        }
      }

      // 【open_comment_panel】打开评论区面板
      if (data.action === 'open_comment_panel') {
        console.log('[API客户端] 执行打开评论区面板指令...');
        if (typeof window.__try_open_feed_comment_panel === 'function') {
          window.__try_open_feed_comment_panel();
        }
      }

      // 【dump_pinia_store】触发 Pinia Store 快照采集
      if (data.action === 'dump_pinia_store') {
        var taskData = data.payload || data;
        var snapshotTaskId = taskData.task_id || '';
        console.log('[API客户端] 执行 dump_pinia_store 指令, task_id=' + snapshotTaskId + '...');
        // 设置全局任务ID，dumpAllPiniaStores 会读取并上报
        window.__snapshotTaskId = snapshotTaskId;
        if (typeof window.dumpAllPiniaStores === 'function') {
          window.dumpAllPiniaStores().then(function(path) {
            console.log('[API客户端] dump_pinia_store 完成, task_id=' + snapshotTaskId + ', path=' + path);
          }).catch(function(err) {
            console.error('[API客户端] dump_pinia_store 异常:', err);
          });
        }
      }

      // 精准作品匹配：评论采集 + 边滚动边过滤
      if (data.action === 'finderGetVideoComments') {
        var taskData = data.payload || data;
        console.log('[API客户端] ★★★ 收到 finderGetVideoComments 指令:', JSON.stringify(taskData).substring(0, 200));

        if (typeof window.__sph_get_video_comments !== 'function') {
          console.error('[API客户端] __sph_get_video_comments 函数未就绪');
          if (window.__wx_api_client && window.__wx_api_client.connected) {
            window.__wx_api_client.ws.send(JSON.stringify({
              type: 'task_complete',
              data: {
                task_id: taskData.task_id,
                success: false,
                errMsg: '__sph_get_video_comments 函数未就绪',
                users: [],
                total: 0
              }
            }));
          }
          return;
        }

        window.__sph_get_video_comments({
          target_num: taskData.target_num || 0,
          trigger_words: taskData.trigger_words || [],
          ip_filter: taskData.ip_filter || '',
          time_filter: taskData.time_filter || {},
          block_words: taskData.block_words || [],
          dedup_usernames: taskData.dedup_usernames || [],
          timeout: taskData.timeout || 120,
          task_id: taskData.task_id || '',

          on_progress: function(progress) {
            console.log('[API客户端] ★★★ 采集进度:', progress);
            if (window.__wx_api_client && window.__wx_api_client.connected) {
              window.__wx_api_client.ws.send(JSON.stringify({
                type: 'task_progress',
                data: {
                  task_id: taskData.task_id,
                  comment_count: progress.comment_count,
                  user_count: progress.user_count,
                  target_num: progress.target_num,
                  percent: progress.percent
                }
              }));
            }
            // 同时通过 HTTP 回调通知 Go Hub（供 Node.js hubClient 轮询）
            window.__wx_api_client.sendMatchingProgress(taskData.task_id, progress);
          },

          on_complete: function(result) {
            console.log('[API客户端] ★★★ 采集完成:', result);
            if (window.__wx_api_client && window.__wx_api_client.connected) {
              window.__wx_api_client.ws.send(JSON.stringify({
                type: 'task_complete',
                data: {
                  task_id: taskData.task_id,
                  success: true,
                  reason: result.reason,
                  users: result.users,
                  total: result.total,
                  target_num: result.target_num,
                  comment_count: result.comment_count || 0
                }
              }));
            }
          }
        });
        return;
      }

      // 无状态获取评论：每次调用读取当前评论+触发一次滚动
      if (data.action === 'fetch_video_comments') {
        console.log('[API客户端] ★★★ 收到 fetch_video_comments 指令');

        if (typeof window.__sph_fetch_video_comments !== 'function') {
          console.error('[API客户端] __sph_fetch_video_comments 函数未就绪');
          // 通过 HTTP 回调通知失败
          window.__wx_api_client.sendFetchCommentsCallback(data.task_id || '', {
            success: false,
            message: '__sph_fetch_video_comments 函数未就绪',
            result: null
          });
          return;
        }

        try {
          var result = window.__sph_fetch_video_comments({});

          // 通过 HTTP 回调把结果写入 Go 缓存（Node.js 轮询获取）
          window.__wx_api_client.sendFetchCommentsCallback(data.task_id || '', {
            success: true,
            message: 'ok',
            result: result
          });
        } catch (err) {
          console.error('[API客户端] fetch_video_comments 执行异常:', err);
          window.__wx_api_client.sendFetchCommentsCallback(data.task_id || '', {
            success: false,
            message: err.message,
            result: null
          });
        }
        return;
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

      // 【cancel_comment_collection】取消评论采集任务
      if (data.action === 'cancel_comment_collection') {
        var taskData = data.payload || data;
        var taskId = taskData.task_id || '';
        console.log('[API客户端] 收到取消采集指令, task_id=' + taskId);

        // 停止评论采集函数
        if (typeof window.__stop_feed_comment_collection === 'function') {
          window.__stop_feed_comment_collection();
          console.log('[API客户端] 已调用 __stop_feed_comment_collection');
        }

        // 如果当前的 snapshotTaskId 匹配（精确匹配或前缀匹配），清除它
        // taskId 可能是完整 ID 或前缀（如 "sph_13095_"）
        if (window.__snapshotTaskId && (window.__snapshotTaskId === taskId || window.__snapshotTaskId.startsWith(taskId))) {
          window.__snapshotTaskId = null;
          console.log('[API客户端] 已清除 __snapshotTaskId');
        }
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

  // 手动打开链接独立于任务导航，只确认接收指令，不表示目标页已加载完成。
  openManualLink: function (id, body) {
    this.sendResponse(id, { success: true, message: '正在打开链接' });
    setTimeout(function () {
      window.__wx_cached_cards = null;
      window.__wx_current_feed = null;
      window.location.href = body.url;
    }, 100);
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
      if (key === 'key:channels:dom_action' && body.action === 'open_link') {
        this.openManualLink(id, body);
        return;
      }
      // 等待 WXU.API 和 WXU.API2 初始化
      var maxWait = 10000; // 最多等待10秒
      var startTime = Date.now();

      while ((!window.WXU || !window.WXU.API || !window.WXU.API2) && (Date.now() - startTime < maxWait)) {
        var wxReady = !!(window.WXU && window.WXU.API && window.WXU.API2);
        console.log('[API客户端] ★★★ [诊断] 等待 WXU.API 初始化... WXU=' + (typeof window.WXU) + ', API=' + (window.WXU ? typeof window.WXU.API : 'n/a') + ', API2=' + (window.WXU ? typeof window.WXU.API2 : 'n/a') + ', elapsed=' + (Date.now() - startTime) + 'ms');
        await new Promise(function (resolve) { setTimeout(resolve, 500); });
      }

      if (!window.WXU || !window.WXU.API || !window.WXU.API2) {
        console.error('[API客户端] ★★★ [诊断] WXU.API 初始化超时，未就绪');
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
          // 优先使用作者页缓存（target=author），否则使用搜索页缓存
          var isAuthorTarget = body.target === 'author';
          var cachedCard = isAuthorTarget
            ? (window.__wx_author_cached_cards && window.__wx_author_cached_cards[body.index])
            : (window.__wx_cached_cards && window.__wx_cached_cards[body.index]);
          var videoTitle = cachedCard ? _normalizeText(cachedCard.videoTitle || cachedCard.title) : '';
          this.sendResponseViaHTTP(id, { success: true, message: '已进入视频页面', videoTitle: videoTitle });

          // 延迟执行点击
          var self = this;
          setTimeout(function() {
            var cardIndex = body.index || 0;
            console.log('[API客户端] enter_video 开始, index:', cardIndex, ', target:', body.target);

            var validCards = [];

            // ========== 作者页目标（target=author）：从 .card-grid 中获取卡片 ==========
            if (isAuthorTarget) {
              var cardWrps = document.querySelectorAll('.card-grid .card-wrp');
              console.log('[API客户端] 作者页找到 ' + cardWrps.length + ' 个卡片');

              for (var ai = 0; ai < cardWrps.length; ai++) {
                var cardWrp = cardWrps[ai];
                var clickBox = cardWrp.querySelector('.click-box');
                if (clickBox) {
                  validCards.push(clickBox);
                }
              }
              console.log('[API客户端] 作者页有效卡片: ' + validCards.length);
            }

            // ========== 搜索页目标：使用现有逻辑 ==========
            if (!isAuthorTarget || validCards.length === 0) {
              // 策略：在"动态"区块内获取卡片
              var dongtaiBlock = null;
              var resBlocks = document.querySelectorAll('.res-block');

              for (var rbi = 0; rbi < resBlocks.length; rbi++) {
                var block = resBlocks[rbi];
                var titleEl = block.querySelector('.block-title .title');
                var titleText = titleEl ? (titleEl.innerText || '').trim() : '';

                if (titleText === '动态') {
                  dongtaiBlock = block;
                  console.log('[API客户端] 找到"动态"区块');
                  break;
                }
              }

              if (dongtaiBlock) {
                var cardGrid = dongtaiBlock.querySelector('.card-grid');
                if (cardGrid) {
                  var cardWrps = cardGrid.querySelectorAll(':scope > .card-wrp');
                  console.log('[API客户端] 动态区块找到 ' + cardWrps.length + ' 个卡片');

                  for (var ci = 0; ci < cardWrps.length; ci++) {
                    var cardWrp = cardWrps[ci];
                    // 排除账号卡片和直播卡片
                    if (cardWrp.querySelector('.account-card, [ml-key="search-account-card"], [ml-key="search-live-card"]')) {
                      continue;
                    }
                    // 找内层的 click-box
                    var clickBox = cardWrp.querySelector('.click-box');
                    if (clickBox) {
                      validCards.push(clickBox);
                    }
                  }
                  console.log('[API客户端] 有效卡片: ' + validCards.length);
                }
              }

              // 备用：直接获取所有 object-card 的 click-box
              if (validCards.length === 0) {
                var objectCards = document.querySelectorAll('.object-card');
                console.log('[API客户端] 备用 object-card 找到 ' + objectCards.length + ' 个');
                for (var oi = 0; oi < objectCards.length; oi++) {
                  var card = objectCards[oi];
                  var clickBox = card.closest('.click-box');
                  if (clickBox) {
                    validCards.push(clickBox);
                  }
                }
              }
            }

            if (cardIndex < validCards.length) {
              var el = validCards[cardIndex];
              console.log('[API客户端] 点击卡片 #' + cardIndex);

              // 提取标题用于调试
              var titleEl = el.querySelector('.info-box .title, [class*="title"]');
              var title = titleEl ? (titleEl.innerText || '').trim() : '无标题';
              console.log('[API客户端] 卡片标题: ' + title.substring(0, 50));

              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(function() {
                el.click();
                console.log('[API客户端] 卡片已点击');
              }, 500);
            } else {
              console.error('[API客户端] 未找到索引 ' + cardIndex + ' 的卡片 (总共 ' + validCards.length + ')');
            }
          }, 100);
          return;
        }
        // 无状态获取评论：读取当前评论 + 触发滚动
        if (body.action === 'fetch_video_comments') {
          var fvcTaskId = body.task_id || '';
          var fvcResult = null;

          try {
            var closedNotices = document.querySelectorAll('.comment-panel .text-center.text-fg-3');
            for (var closedNotice of closedNotices) {
              if ((closedNotice.textContent || '').trim() !== '作者已关闭评论' || !closedNotice.getClientRects().length) continue;
              var noticeVisible = true;
              for (var noticeParent = closedNotice; noticeParent; noticeParent = noticeParent.parentElement) {
                var noticeStyle = window.getComputedStyle(noticeParent);
                if (noticeParent.hidden || noticeStyle.display === 'none' || noticeStyle.visibility === 'hidden' || noticeStyle.visibility === 'collapse') {
                  noticeVisible = false;
                  break;
                }
              }
              if (noticeVisible) {
                fvcResult = { reason: 'comments_disabled', _error: '作者已关闭评论', panel_ready: true, comment_count: 0, has_more: false, raw_items: [] };
                break;
              }
            }
            // 等待 Pinia Store 就绪（最多 3 次，每次等 500ms）
            var maxRetries = 3;
            var retryDelay = 500;
            for (var attempt = 1; fvcResult === null && attempt <= maxRetries; attempt++) {
              if (typeof window.__sph_fetch_video_comments === 'function') {
                fvcResult = window.__sph_fetch_video_comments({});
                // 函数执行成功，退出重试循环
                break;
              }
              if (attempt < maxRetries) {
                await new Promise(function(r) { setTimeout(r, retryDelay); });
              }
            }

            if (fvcResult === null) {
              // 多次重试后函数仍不存在，说明评论区还未初始化。
              // has_more=true 告诉 Node.js 继续轮询，而不是误判退出
              fvcResult = { panel_ready: false, items: [], total: 0, comment_count: 0, has_more: true, buffer: '', raw_items: [] };
              console.warn('[API客户端] __sph_fetch_video_comments 未就绪，has_more=true 等待初始化');
            }
          } catch (err) {
            console.error('[API客户端] __sph_fetch_video_comments 执行异常:', err.message);
            fvcResult = { panel_ready: false, items: [], total: 0, comment_count: 0, has_more: true, buffer: '', raw_items: [], _error: err.message };
          } finally {
            // 无论成功/失败/异常，都必须发回调，保证 Hub 缓存有数据
            clearTimeout(fvcTimeout);
            resp({ success: !fvcResult._error, message: fvcResult._error || 'ok', result: fvcResult });
            self.sendFetchCommentsCallback(fvcTaskId, {
              success: !fvcResult._error,
              message: fvcResult._error || 'ok',
              result: fvcResult
            });
          }
          return;
        }

        var fvcTimeout;

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

  playbackVisibleArea: function(element) {
    if (!element || !element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return 0;
    var style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return 0;
    var rect = element.getBoundingClientRect();
    return Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)) *
      Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
  },

  getPlaybackScope: function() {
    var visibleArea = this.playbackVisibleArea;
    var slides = document.querySelectorAll('.slides-item');
    var scope = null;
    var largestArea = 0;
    for (var si = 0; si < slides.length; si++) {
      var area = visibleArea(slides[si]);
      if (area > largestArea) {
        largestArea = area;
        scope = slides[si];
      }
    }
    return slides.length ? scope : document;
  },

  getPlaybackTarget: function(scope) {
    if (scope === undefined) scope = this.getPlaybackScope();
    var feed = scope && scope.querySelector('[id^="flow-feed-"]');
    return {
      scope: scope,
      pagePath: window.location.pathname,
      feedId: feed ? feed.id : '',
      media: scope ? Array.from(scope.querySelectorAll('video, audio')).map(function(element) {
        return { element: element, source: [element.getAttribute('src') || '', element.currentSrc || '',
          Array.from(element.querySelectorAll('source')).map(function(source) { return source.src; }).join('|')].join('|') };
      }) : []
    };
  },

  samePlaybackTarget: function(left, right) {
    return !!left && !!right && left.scope === right.scope && left.pagePath === right.pagePath && left.feedId === right.feedId &&
      left.media.length === right.media.length && left.media.every(function(media, index) {
        return media.element === right.media[index].element && media.source === right.media[index].source;
      });
  },

  readPlaybackState: function(scope) {
    var visibleArea = this.playbackVisibleArea;
    var findControl = function(selector) {
      var controls = scope ? scope.querySelectorAll(selector) : [];
      for (var i = 0; i < controls.length; i++) {
        var control = controls[i].closest('button, [role="button"]') || controls[i];
        if (visibleArea(control) > 0 && !control.disabled && control.getAttribute('aria-disabled') !== 'true') return control;
      }
      return null;
    };
    var media = scope ? Array.from(scope.querySelectorAll('video, audio')).filter(function(element) {
      var visual = element.tagName === 'AUDIO' ? element.closest('[ml-key="flow-image"], .slides-item') : element;
      return visibleArea(visual) > 0;
    }) : [];
    var pauseButton = findControl('[aria-label*="暂停"], [data-action="pause"], [ml-key="flow-video-pause"], [class*="pause"][class*="btn"]');
    var playButton = findControl('[aria-label="播放"], [data-action="play"], [ml-key="flow-video-play"]');
    var nativeVideo = media.some(function(element) { return element.tagName === 'VIDEO'; });
    if (this.pauseButtonClicks && playButton && !pauseButton) this.pauseButtonClicks.delete(scope);
    return {
      media: media, pauseButton: pauseButton, playButton: playButton, nativeVideo: nativeVideo,
      paused: (nativeVideo || !pauseButton) && (media.length ? media.every(function(element) { return element.paused; }) : !!playButton)
    };
  },

  // 不等待按钮渲染或异步确认；播放事件可直接指定切换动画中的媒体。
  pausePlaybackNow: function(scope, eventMedia) {
    var state = this.readPlaybackState(scope);
    var method = 'already_paused';
    // 普通视频直接暂停媒体，避免 UI 标签滞后时切换按钮重新触发播放。
    // 图文还需停止轮播；同一内容只点一次，直到观察到播放按钮或切换作品。
    if (state.pauseButton && !state.nativeVideo) {
      if (!this.pauseButtonClicks) this.pauseButtonClicks = new WeakMap();
      var lastClick = this.pauseButtonClicks.get(scope);
      var target = this.getPlaybackTarget(scope);
      var sameContent = lastClick && lastClick.pagePath === target.pagePath &&
        (target.feedId ? lastClick.feedId === target.feedId : this.samePlaybackTarget(lastClick, target));
      if (!sameContent) {
        this.pauseButtonClicks.set(scope, target);
        try { state.pauseButton.click(); method = 'button_click'; } catch(e) {}
      }
    }
    state = this.readPlaybackState(scope);
    if (eventMedia && eventMedia.isConnected && !state.media.includes(eventMedia)) state.media.push(eventMedia);
    for (var i = 0; i < state.media.length; i++) {
      if (state.media[i].paused) continue;
      try {
        state.media[i].pause();
        method = state.media[i].tagName === 'AUDIO' ? 'audio_element' : 'video_element';
      } catch(e) { console.log('[API客户端] 媒体暂停失败:', e); }
    }
    return method;
  },

  // 只合并同一内容的确认任务，新内容立即开始；旧任务不能清除新任务的状态。
  pauseVideo: function() {
    var target = this.getPlaybackTarget();
    if (this.pausePromise && this.samePlaybackTarget(this.pauseTarget, target) && this.pauseTargetEpoch === (this.pauseEpoch || 0)) {
      this.pausePlaybackNow(target.scope);
      return this.pausePromise;
    }
    var self = this;
    this.pauseEpoch = (this.pauseEpoch || 0) + 1;
    this.pauseTarget = target;
    this.pauseTargetEpoch = this.pauseEpoch;
    var promise = this.pauseCurrentMedia(target, this.pauseEpoch).catch(function(error) {
      return { success: false, isPaused: false, message: error.message };
    }).finally(function() {
      if (self.pausePromise === promise) self.pausePromise = null;
    });
    this.pausePromise = promise;
    return promise;
  },

  pauseCurrentMedia: async function(target, pauseEpoch) {
    var self = this;
    var maxRetries = 5;
    var retryDelay = 300;
    var getPauseScope = this.getPlaybackScope.bind(this);
    var isTargetCurrent = function(scope) {
      return pauseEpoch === (self.pauseEpoch || 0) && scope === getPauseScope() && self.samePlaybackTarget(target, self.getPlaybackTarget(scope));
    };
    var readPauseState = this.readPlaybackState.bind(this);
    // paused 在媒体初始化时也为 true，必须跨多个采样确认，不能读一次就结束。
    var confirmPaused = async function(scope, initial) {
      var firstState = readPauseState(scope);
      if (!firstState.paused) return false;
      var mediaSources = firstState.media.map(function(element) { return element.currentSrc || element.src; });
      for (var sample = 0; sample < 3; sample++) {
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
        if (!isTargetCurrent(scope)) return false;
        var current = readPauseState(scope);
        if (!current.paused || current.media.length !== firstState.media.length) return false;
        for (var pi = 0; pi < current.media.length; pi++) {
          var mediaElement = current.media[pi];
          if (mediaElement !== firstState.media[pi] || (mediaElement.currentSrc || mediaElement.src) !== mediaSources[pi]) return false;
          if (initial && mediaElement.readyState < 2 && !mediaElement.ended) return false;
        }
      }
      return true;
    };
    var pauseDiagnostics = function(scope) {
      var state = readPauseState(scope);
      var feed = scope && scope.querySelector('[id^="flow-feed-"]');
      return {
        version: 'pause-v5-no-toggle',
        pagePath: window.location.pathname,
        feedId: feed ? feed.id : '',
        slideIndex: Array.from(document.querySelectorAll('.slides-item')).indexOf(scope),
        pauseButton: !!state.pauseButton,
        playButton: !!state.playButton,
        media: state.media.map(function(element) {
          return { tag: element.tagName, paused: element.paused, readyState: element.readyState, currentTime: element.currentTime };
        })
      };
    };
    var pauseResult = function(method) {
      return { success: true, isPaused: true, message: '视频已暂停', byMethod: method, diagnostics: pauseDiagnostics(getPauseScope()) };
    };

    for (var retry = 0; retry < maxRetries; retry++) {
      console.log('[API客户端] 暂停重试 ' + (retry + 1) + '/' + maxRetries);

      var scope = getPauseScope();
      if (!isTargetCurrent(scope)) return { success: false, isPaused: false, message: '当前内容已切换', cancelled: true };
      var state = readPauseState(scope);
      if (state.paused) {
        if (await confirmPaused(scope, true)) return pauseResult('already_paused');
        if (!isTargetCurrent(scope)) continue;
        state = readPauseState(scope);
      }

      var method = this.pausePlaybackNow(scope);
      if (!isTargetCurrent(scope)) continue;
      state = readPauseState(scope);
      if (state.paused && await confirmPaused(scope, method === 'already_paused')) return pauseResult(method);
      if (!isTargetCurrent(scope)) continue;

      if (retry < maxRetries - 1) {
        await new Promise(function(resolve) { setTimeout(resolve, retryDelay); });
      }
    }

    console.log('[API客户端] 暂停失败: 所有策略均未生效');
    return {
      success: false,
      isPaused: false,
      message: '暂停失败: 所有策略均未生效',
      triedMethods: ['button_click', 'video_element', 'audio_element'],
      diagnostics: pauseDiagnostics(getPauseScope())
    };
  },

  startAutoPause: function() {
    if (this.stopAutoPause) return;
    var self = this;
    var retryTimer = null;
    var stopped = false;
    var current = null;
    var enabled = function() {
      return !stopped && /^\/web\/pages\/(feed|home)\/?$/.test(window.location.pathname);
    };
    var syncTarget = function() {
      var target = self.getPlaybackTarget();
      if (!current || !self.samePlaybackTarget(current.target, target)) {
        self.pauseEpoch = (self.pauseEpoch || 0) + 1;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
        current = { target: target, attempts: 0, pending: null, confirmed: false, userResumed: false };
      }
      return current;
    };
    var check = function() {
      if (!enabled()) return;
      var context = syncTarget();
      var scope = context.target.scope;
      if (!scope || context.userResumed) return;
      if (!scope.querySelector('video, audio, [ml-key="flow-image"], [ml-key="flow-video-pause"], [aria-label="暂停"]')) return;
      if (context.pending) {
        // 确认期间播放器仍可能自动播放或挂载按钮，动作不等待 Promise。
        self.pausePlaybackNow(scope);
        return;
      }
      if (context.confirmed && self.readPlaybackState(scope).paused) return;
      if (retryTimer !== null || context.attempts >= 3) return;
      context.attempts++;
      context.pending = self.pauseVideo();
      context.pending.then(function(result) {
        context.pending = null;
        if (!enabled() || current !== context || context.userResumed) return;
        if (!self.samePlaybackTarget(context.target, self.getPlaybackTarget())) { check(); return; }
        context.confirmed = result.success === true;
        if (context.confirmed) context.attempts = 0;
        __api_log(result.success ? 'INF' : 'WRN', '[AutoPause]', result);
        if (!context.confirmed && context.attempts < 3) {
          retryTimer = setTimeout(function() {
            retryTimer = null;
            check();
          }, 1000);
        }
      });
    };
    // play 不冒泡；直接处理事件媒体，覆盖尚未成为最大可见滑块的新视频。
    var onPlay = function(event) {
      if (!enabled()) return;
      var media = event.target;
      if (!media || !media.matches || !media.matches('video, audio') || !media.isConnected) return;
      var context = syncTarget();
      var scope = media.closest('.slides-item') || media.closest('[id^="flow-feed-"], .feed-video, [ml-key="flow-image"]');
      if (!scope) {
        if (context.target.scope !== document || self.playbackVisibleArea(media) <= 0) return;
        scope = document;
      }
      if (context.userResumed && context.target.scope && context.target.scope.contains(media)) return;
      // 有限重试只限制后台确认，不能使实际播放事件失去保护。
      self.pausePlaybackNow(scope, media);
      if (!context.pending) check();
    };
    var onUserPlay = function(event) {
      if (!enabled() || !event.isTrusted || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      var element = event.target;
      if (!element.closest || element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.type === 'keydown' && event.key !== ' ' && event.key !== 'Enter') return;
      var context = syncTarget();
      var scope = context.target.scope;
      if (!scope || !scope.contains(element)) return;
      var control = element.closest('button, [role="button"]');
      var playTarget = element.closest('[aria-label="播放"], [data-action="play"], [ml-key="flow-video-play"]') ||
        (control && control.querySelector('[ml-key="flow-video-play"]'));
      if (playTarget || (element.matches('video, audio') && element.paused)) {
        context.userResumed = true;
        self.pauseEpoch = (self.pauseEpoch || 0) + 1;
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    var observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'id', 'src', 'aria-label', 'ml-key'] });
    var unsubscribe = window.WXE && window.WXE.onFeed ? window.WXE.onFeed(check) : null;
    document.addEventListener('play', onPlay, true);
    document.addEventListener('playing', onPlay, true);
    document.addEventListener('click', onUserPlay, true);
    document.addEventListener('keydown', onUserPlay, true);
    document.addEventListener('scroll', check, true);
    document.addEventListener('transitionend', check, true);
    window.addEventListener('pageshow', check);
    window.addEventListener('pagehide', stop);
    function stop() {
      stopped = true;
      self.pauseEpoch = (self.pauseEpoch || 0) + 1;
      if (retryTimer !== null) clearTimeout(retryTimer);
      observer.disconnect();
      if (unsubscribe) unsubscribe();
      document.removeEventListener('play', onPlay, true);
      document.removeEventListener('playing', onPlay, true);
      document.removeEventListener('click', onUserPlay, true);
      document.removeEventListener('keydown', onUserPlay, true);
      document.removeEventListener('scroll', check, true);
      document.removeEventListener('transitionend', check, true);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('pagehide', stop);
      self.stopAutoPause = null;
    }
    this.stopAutoPause = stop;
    check();
  },

  // 执行 DOM Action
  executeDomAction: async function(body, requestId) {
    var self = this;
    var action = body.action || 'click_element';
    if (action === 'pause_video') return this.pauseVideo();
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
          if (result && (result.resultUnknown || result.retryable === false)) return result;
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

      // ========== 搜索页操作 - 行业作品意向匹配 (task_type=1) ==========

      // scroll_search_to_bottom - 滚动搜索页到尽头
      if (action === 'scroll_search_to_bottom') {
        console.log('[API客户端] scroll_search_to_bottom 开始执行');

        var scrollContainer = document.querySelector('.search-result-page');
        if (!scrollContainer) {
          console.error('[API客户端] 未找到搜索页滚动容器 .search-result-page');
          // 即使未找到滚动容器，也尝试同步已有 collector 缓存
          var collector = window.__wx_channels_search_collector;
          if (collector && typeof collector.syncToCachedCards === 'function') {
            collector.syncToCachedCards();
          }
          return { success: false, message: '未找到搜索页滚动容器' };
        }

        var maxScrolls = 50; // 最多滚动次数
        var scrollDelay = 1500; // 每次滚动后等待时间
        var stableThreshold = 3; // 连续几次数量不变认为已到尽头
        var lastCount = 0;
        var stableCount = 0;

        // 优先使用 collector 中的数据量
        var getVideoCount = function() {
          var collector = window.__wx_channels_search_collector;
          if (collector && collector.feeds) {
            // 只计算 media 类型
            return collector.feeds.filter(function(f) { return f && (f.type === 'media' || f.type === 'video'); }).length;
          }
          return 0;
        };

        // 等待 collector 有初始数据（防止页面刚加载时 feeds=[] 导致提前终止）
        var waitForInitialData = async function() {
          var maxWait = 8000;
          var pollInterval = 500;
          var elapsed = 0;
          while (elapsed < maxWait) {
            var count = getVideoCount();
            if (count > 0) {
              console.log('[API客户端] 初始数据已就绪: ' + count + ' 个 (等待 ' + elapsed + 'ms)');
              return count;
            }
            await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
            elapsed += pollInterval;
          }
          console.log('[API客户端] 等待初始数据超时，继续执行，当前: ' + getVideoCount() + ' 个');
          return getVideoCount();
        };

        var doScroll = async function() {
          // ★★★ 关键：等待 collector 有初始数据后再开始计数判断
          await waitForInitialData();
          var lastCount = getVideoCount();

          for (var i = 0; i < maxScrolls; i++) {
            var scrollHeight = scrollContainer.scrollHeight;
            scrollContainer.scrollTop = scrollHeight + 600;
            console.log('[API客户端] 滚动 #' + (i + 1) + ', scrollHeight: ' + scrollHeight);

            await new Promise(function(resolve) { setTimeout(resolve, scrollDelay); });

            // 检查是否还有 loading
            var loading = scrollContainer.querySelector('.loading, [class*="loading"], [class*="spinner"]');
            if (loading) {
              // 等待 loading 消失
              var waitLoading = 0;
              while (waitLoading < 10) {
                await new Promise(function(resolve) { setTimeout(resolve, 1000); });
                loading = scrollContainer.querySelector('.loading, [class*="loading"], [class*="spinner"]');
                if (!loading) break;
                waitLoading++;
              }
            }

            // 检查 disabled 属性
            var disabled = scrollContainer.getAttribute('infinite-scroll-disabled');
            if (disabled === 'true' && !loading) {
              console.log('[API客户端] 已无更多数据 (disabled=true)');
              return { success: true, reason: 'no_more_data', scrollCount: i + 1 };
            }

            // 检查 collector 中的视频数量
            var currentCount = getVideoCount();
            console.log('[API客户端] 当前视频数量 (collector): ' + currentCount);

            if (currentCount === lastCount) {
              stableCount++;
              if (stableCount >= stableThreshold) {
                console.log('[API客户端] 连续 ' + stableCount + ' 次数量不变，已到尽头');
                return { success: true, reason: 'stable', scrollCount: i + 1, totalCards: currentCount };
              }
            } else {
              stableCount = 0;
              lastCount = currentCount;
            }
          }
          return { success: true, reason: 'max_scrolls', scrollCount: maxScrolls, totalCards: lastCount };
        };

        var scrollResult = await doScroll();

        // ★★★ 滚动结束后，将 collector 中的完整数据缓存，供 fetch_search_video_cards 直接消费
        var collector = window.__wx_channels_search_collector;
        if (collector && typeof collector.syncToCachedCards === 'function') {
          collector.syncToCachedCards();
        } else if (collector && collector.feeds && collector.feeds.length > 0) {
          var cached = [];
          collector.feeds.forEach(function(f) {
            if (!f || (f.type !== 'media' && f.type !== 'video')) return;

            // 提取作者信息
            var authorNickname = '';
            var authorUsername = '';
            var authorData = f.author || f.contact || f.authorInfo || {};
            authorNickname = authorData.nickname || authorData.name || f.nickname || '';
            authorUsername = authorData.username || authorData.id || f.username || '';

            cached.push({
              index: cached.length,
              title: (f.content && f.content.title) || f.title || (f.objectDesc && f.objectDesc.description) || '',
              videoTitle: (f.content && f.content.title) || f.title || (f.objectDesc && f.objectDesc.description) || '',
              nickname: authorNickname,
              username: authorUsername,
              author_name: authorNickname,
              feed_id: (f.content && f.content.id) || f.id || '',
              html: (f.content && f.content.html) ? f.content.html.substring(0, 500) : '',
              raw: f
            });
          });
          window.__wx_cached_cards = cached;
          console.log('[API客户端] 滚动结束，缓存 ' + cached.length + ' 个视频到 __wx_cached_cards');
        }

        return scrollResult;
      }

      // fetch_search_video_cards - 采集搜索页"动态"Tab下的视频卡片
      if (action === 'fetch_search_video_cards') {
        console.log('[API客户端] fetch_search_video_cards 开始执行');

        // 1. 优先使用已缓存的数据
        if (window.__wx_cached_cards && window.__wx_cached_cards.length > 0) {
          console.log('[API客户端] 使用 scroll 缓存: ' + window.__wx_cached_cards.length + ' 个视频');
          return {
            success: true,
            videos: window.__wx_cached_cards,
            count: window.__wx_cached_cards.length,
            message: '使用缓存，找到 ' + window.__wx_cached_cards.length + ' 个视频'
          };
        }

        // 2. 尝试从 search_collector 中直接提取并同步
        var collector = window.__wx_channels_search_collector;
        if (collector && typeof collector.syncToCachedCards === 'function') {
          collector.syncToCachedCards();
        } else if (collector && collector.feeds && collector.feeds.length > 0) {
          var fallbackCached = [];
          collector.feeds.forEach(function(f) {
            if (!f || (f.type !== 'media' && f.type !== 'video')) return;
            var authorData = f.author || f.contact || f.authorInfo || {};
            var authorNickname = authorData.nickname || authorData.name || f.nickname || '';
            var authorUsername = authorData.username || authorData.id || f.username || '';
            fallbackCached.push({
              index: fallbackCached.length,
              title: (f.content && f.content.title) || f.title || (f.objectDesc && f.objectDesc.description) || '',
              videoTitle: (f.content && f.content.title) || f.title || (f.objectDesc && f.objectDesc.description) || '',
              nickname: authorNickname,
              username: authorUsername,
              author_name: authorNickname,
              feed_id: (f.content && f.content.id) || f.id || '',
              html: (f.content && f.content.html) ? f.content.html.substring(0, 500) : '',
              raw: f
            });
          });
          window.__wx_cached_cards = fallbackCached;
        }

        if (window.__wx_cached_cards && window.__wx_cached_cards.length > 0) {
          console.log('[API客户端] 成功从 search_collector 提取并同步到缓存: ' + window.__wx_cached_cards.length + ' 个视频');
          return {
            success: true,
            videos: window.__wx_cached_cards,
            count: window.__wx_cached_cards.length,
            message: '从采集器提取，找到 ' + window.__wx_cached_cards.length + ' 个视频'
          };
        }

        // 3. 无缓存且无数据
        console.log('[API客户端] 无缓存数据且未采集到视频，请先执行 scroll_search_to_bottom');
        return {
          success: false,
          videos: [],
          count: 0,
          message: '无缓存数据，请先执行 scroll_search_to_bottom'
        };
      }

      // ========== 作者页操作 - 作者作品意向匹配 (task_type=2) ==========

      // scroll_author_to_bottom - 单次步进滚动，返回当前 DOM 卡片数量
      if (action === 'scroll_author_to_bottom') {
        console.log('[API客户端] scroll_author_to_bottom 开始执行');

        if (!window.location.pathname.includes('/pages/profile')) {
          return { success: false, message: '当前不在作者页' };
        }

        // 确认视频 tab 处于激活状态
        var activeTab = document.querySelector('.tabs .tab--active');
        if (activeTab && !activeTab.textContent.includes('视频')) {
          var allTabs = document.querySelectorAll('.tabs .tab');
          var videoTab = null;
          for (var ti = 0; ti < allTabs.length; ti++) {
            if (allTabs[ti].textContent.includes('视频')) {
              videoTab = allTabs[ti];
              break;
            }
          }
          if (videoTab) {
            videoTab.click();
            await new Promise(function(r) { setTimeout(r, 2000); });
          }
        }

        // 多层兜底查找滚动容器
        function findScrollableContainer() {
          var candidates = [
            document.querySelector('.page-profile > .content'),
            document.querySelector('.page-profile'),
            document.querySelector('.membership-content'),
            document.querySelector('.membership-content__bd'),
            document.documentElement,
            document.body
          ];
          for (var ci = 0; ci < candidates.length; ci++) {
            var el = candidates[ci];
            if (el && el.scrollHeight > el.clientHeight) {
              return el;
            }
          }
          return document.querySelector('.page-profile > .content') || document.documentElement;
        }

        var scroller = findScrollableContainer();
        var SCROLL_STEP = Math.floor(window.innerHeight * 0.8);

        // 执行一次步进滚动
        var prevTop = scroller.scrollTop;
        var prevCards = document.querySelectorAll('.card-wrp').length;
        scroller.scrollTop = prevTop + SCROLL_STEP;
        window.scrollBy(0, SCROLL_STEP);

        console.log('[API客户端] 滚动 ' + prevTop + ' -> ' + scroller.scrollTop + ', cards before: ' + prevCards);

        // 等待加载（减少等待时间以减轻服务器压力）
        await new Promise(function(res) { setTimeout(res, 500); });

        var wc = 0;
        while (wc < 10) {
          var loading = scroller.querySelector('.loading, [class*="loading"], [class*="spinner"]');
          if (!loading) break;
          await new Promise(function(res) { setTimeout(res, 500); });
          wc++;
        }

        var currentCards = document.querySelectorAll('.card-wrp').length;
        var disabled = scroller.getAttribute('infinite-scroll-disabled');

        console.log('[API客户端] scroll_author_to_bottom 返回: cards=' + currentCards + ', disabled=' + disabled);

        return {
          success: true,
          totalCards: currentCards,
          loaded: currentCards > prevCards,
          noMore: disabled === 'true'
        };
      }

      // fetch_author_video_cards - 采集作者页视频卡片列表
      if (action === 'fetch_author_video_cards') {
        console.log('[API客户端] fetch_author_video_cards 开始执行');

        var cards = document.querySelectorAll('.card-grid .card-wrp');
        if (!cards || cards.length === 0) {
          console.log('[API客户端] 未找到作者页视频卡片');
          return { success: false, videos: [], count: 0, message: '未找到视频卡片' };
        }

        console.log('[API客户端] 找到 ' + cards.length + ' 个作者页视频卡片');

        var authorVideos = [];
        cards.forEach(function(card, idx) {
          var clickBox = card.querySelector('.click-box');

          // 提取标题
          var titleEl = card.querySelector('.title');
          var title = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim() : '';

          // 提取作者昵称
          var nicknameEl = card.querySelector('.nickname');
          var nickname = nicknameEl ? (nicknameEl.textContent || '').trim() : '';

          // 提取统计数据（点赞/评论/转发）
          var statsEl = card.querySelector('.stats, [class*="stats"]');
          var statsText = statsEl ? (statsEl.textContent || '').trim() : '';

          // 提取封面图
          var coverEl = card.querySelector('.cover, [class*="cover"] img, video');
          var coverUrl = '';
          if (coverEl) {
            coverUrl = coverEl.src || coverEl.getAttribute('data-src') || '';
          }

          authorVideos.push({
            index: idx,
            title: title,
            nickname: nickname,
            stats: statsText,
            coverUrl: coverUrl,
            clickable: !!clickBox
          });
        });

        console.log('[API客户端] 解析出 ' + authorVideos.length + ' 个视频信息');

        // 缓存供 enter_video 使用
        window.__wx_author_cached_cards = authorVideos;

        return {
          success: true,
          videos: authorVideos,
          count: authorVideos.length,
          message: '找到 ' + authorVideos.length + ' 个视频'
        };
      }

      // click_search_video_card - 点击搜索结果中的视频卡片
      // 策略：在"动态"区块内获取卡片
      if (action === 'click_search_video_card') {
        var cardIndex = body.index || 0;
        console.log('[API客户端] click_search_video_card 开始执行, index:', cardIndex);

        await new Promise(function(resolve) { setTimeout(resolve, 800); });

        var validCards = [];

        // 策略：在"动态"区块内获取卡片
        var dongtaiBlock = null;
        var resBlocks = document.querySelectorAll('.res-block');

        for (var rbi = 0; rbi < resBlocks.length; rbi++) {
          var block = resBlocks[rbi];
          var titleEl = block.querySelector('.block-title .title');
          var titleText = titleEl ? (titleEl.innerText || '').trim() : '';

          if (titleText === '动态') {
            dongtaiBlock = block;
            console.log('[API客户端] 找到"动态"区块');
            break;
          }
        }

        if (dongtaiBlock) {
          var cardGrid = dongtaiBlock.querySelector('.card-grid');
          if (cardGrid) {
            var cardWrps = cardGrid.querySelectorAll(':scope > .card-wrp');
            console.log('[API客户端] 动态区块找到 ' + cardWrps.length + ' 个卡片');

            for (var ci = 0; ci < cardWrps.length; ci++) {
              var cardWrp = cardWrps[ci];
              if (cardWrp.querySelector('.account-card, [ml-key="search-account-card"], [ml-key="search-live-card"]')) {
                continue;
              }
              var clickBox = cardWrp.querySelector('.click-box');
              if (clickBox) {
                validCards.push(clickBox);
              }
            }
            console.log('[API客户端] 有效卡片: ' + validCards.length);
          }
        }

        // 备用：直接获取所有 object-card 的 click-box
        if (validCards.length === 0) {
          var objectCards = document.querySelectorAll('.object-card');
          for (var oi = 0; oi < objectCards.length; oi++) {
            var card = objectCards[oi];
            var clickBox = card.closest('.click-box');
            if (clickBox) {
              validCards.push(clickBox);
            }
          }
          console.log('[API客户端] 备用 object-card 找到 ' + validCards.length + ' 个');
        }

        console.log('[API客户端] 最终有效卡片: ' + validCards.length);

        if (cardIndex < validCards.length) {
          var targetEl = validCards[cardIndex];
          console.log('[API客户端] 点击卡片 #' + cardIndex);

          var titleEl = targetEl.querySelector('.info-box .title, [class*="title"]');
          var title = titleEl ? (titleEl.innerText || '').trim() : '无标题';
          console.log('[API客户端] 卡片标题: ' + title.substring(0, 50));

          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(function(resolve) { setTimeout(resolve, 500); });

          targetEl.click();
          console.log('[API客户端] 点击完成');

          return {
            success: true,
            message: '卡片已点击',
            index: cardIndex
          };
        }

        console.error('[API客户端] 未找到索引 ' + cardIndex + ' 的卡片');
        return { success: false, message: '未找到可点击的视频元素' };
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

      // do_follow_on_profile 操作 - 在主页执行关注（用于用户无视频时）
      if (action === 'do_follow_on_profile') {
        console.log('[API客户端] do_follow_on_profile 开始');

        var followAttempt = async function() {
          // 判断按钮是否表示已关注状态
          function isFollowedState(text) {
            return (text || '').includes('已关注') || (text || '').includes('互相关注');
          }

          // 辅助函数：收集容器内所有关注相关的按钮
          function collectFollowBtns(container) {
            if (!container) return [];
            var result = [];
            var allBtns = container.querySelectorAll('button');
            for (var i = 0; i < allBtns.length; i++) {
              var t = (allBtns[i].innerText || '').trim();
              if (t === '关注' || isFollowedState(t)) result.push(allBtns[i]);
            }
            return result;
          }

          var profileBtn = null;

          // 第一层：.opr-area（主页固定头部，精确优先）
          var oprArea = document.querySelector('.opr-area');
          if (oprArea) {
            var oprBtns = oprArea.querySelectorAll('button');
            for (var m = 0; m < oprBtns.length; m++) {
              var mt = (oprBtns[m].innerText || '').trim();
              if (mt === '关注' || isFollowedState(mt)) {
                profileBtn = oprBtns[m];
                break;
              }
            }
          }

          // 第二层：.floating-avatar-area（浮动头部）
          if (!profileBtn) {
            var floatingArea = document.querySelector('.floating-avatar-area');
            if (floatingArea) {
              var floatBtns = floatingArea.querySelectorAll('button');
              for (var n = 0; n < floatBtns.length; n++) {
                var nt = (floatBtns[n].innerText || '').trim();
                if (nt === '关注' || isFollowedState(nt)) {
                  profileBtn = floatBtns[n];
                  break;
                }
              }
            }
          }

          // 第三层兜底：全局遍历页面所有按钮
          if (!profileBtn) {
            var allBtns = document.querySelectorAll('button');
            for (var j = 0; j < allBtns.length; j++) {
              var bt = (allBtns[j].innerText || '').trim();
              if (bt === '关注' || isFollowedState(bt)) {
                profileBtn = allBtns[j];
                break;
              }
            }
          }

          if (!profileBtn) {
            console.log('[API客户端] do_follow_on_profile 未找到关注相关按钮');
            return { success: false, message: '未找到主页关注按钮' };
          }

          var text = (profileBtn.innerText || '').trim();
          console.log('[API客户端] 主页关注按钮文本:', text);

          // 已关注状态 → 直接返回成功
          if (isFollowedState(text)) {
            console.log('[API客户端] 该作者已关注，跳过');
            return { success: true, isFollowed: true, message: '该作者已关注' };
          }

          // 未关注 → 执行点击
          if (text === '关注') {
            profileBtn.click();
            console.log('[API客户端] 主页关注按钮已点击');
            await new Promise(function(resolve) { setTimeout(resolve, 1500); });

            var textAfter = (profileBtn.innerText || '').trim();
            var followed = isFollowedState(textAfter);
            console.log('[API客户端] 点击后按钮文本:', textAfter, 'followed:', followed);

            if (followed) {
              return { success: true, isFollowed: true, message: '主页关注成功' };
            } else {
              return { success: false, isFollowed: false, message: '主页关注失败，按钮状态未变化' };
            }
          }

          // 兜底：文字既不是"关注"也不是"已关注"，尝试点击
          profileBtn.click();
          console.log('[API客户端] 主页按钮（非标准文字）已点击:', text);
          await new Promise(function(resolve) { setTimeout(resolve, 1500); });
          var textAfter2 = (profileBtn.innerText || '').trim();
          var followed2 = isFollowedState(textAfter2);
          if (followed2) {
            return { success: true, isFollowed: true, message: '主页关注成功' };
          }
          return { success: false, isFollowed: false, message: '主页关注失败，按钮状态未变化' };
        };

        return await _executeWithRetry(followAttempt, 'do_follow_on_profile');
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

        var commentStarted = Date.now();
        var commentAttemptNumber = 0;
        var commentSubmitted = false;
        function getCommentDisabledResult() {
          // 只匹配评论面板的可见状态提示，避免把评论正文或隐藏旧面板误判为关闭评论。
          var notices = document.querySelectorAll('.comment-panel .text-center.text-fg-3');
          for (var noticeIndex = 0; noticeIndex < notices.length; noticeIndex++) {
            var notice = notices[noticeIndex];
            if ((notice.textContent || '').trim() !== '作者已关闭评论' || !notice.getClientRects().length) continue;
            var visible = true;
            for (var ancestor = notice; ancestor; ancestor = ancestor.parentElement) {
              var style = window.getComputedStyle(ancestor);
              if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
                visible = false;
                break;
              }
            }
            if (visible) {
              logCommentStage('comments_disabled');
              return { success: false, isCommented: false, retryable: false, reason: 'comments_disabled', message: '作者已关闭评论' };
            }
          }
          return null;
        }
        function logCommentStage(stage, details) {
          __api_log('INF', '[CommentOperation]', {
            operation_id: body.operation_id || '', request_id: requestId,
            stage: stage, attempt: commentAttemptNumber,
            elapsed_ms: Date.now() - commentStarted, page: window.location.pathname,
            details: details || {}
          });
        }
        var commentAttempt = async function() {
          // A click may have sent the comment even if a later DOM read throws.
          if (commentSubmitted) return { success: false, resultUnknown: true, message: '评论已点击发送，结果待核实' };
          commentAttemptNumber++;
          logCommentStage('attempt');
          var disabledResult = getCommentDisabledResult();
          if (disabledResult) return disabledResult;
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
            logCommentStage('comment_button_missing');
            console.log('[API客户端] 未找到评论按钮');
            return { success: false, message: '未找到评论按钮' };
          }

          logCommentStage('comment_button_found', { visible: !!commentBtn.getClientRects().length });
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
            disabledResult = getCommentDisabledResult();
            if (disabledResult) return disabledResult;
            commentInput = window.__wx_parsers__.getCommentInput();
            if (commentInput) {
              console.log('[API客户端] 第' + (pollI + 1) + '次轮询找到评论输入框');
              break;
            }
            window.__wx_parsers__.refreshAllDom();
            await new Promise(function(resolve) { setTimeout(resolve, pollDelay); });
          }

          disabledResult = getCommentDisabledResult();
          if (disabledResult) return disabledResult;
          if (!commentInput) {
            var placeholder = document.querySelector(window.__wx_selectors__.comment.placeholder);
            if (placeholder) {
              console.log('[API客户端] textarea 未就绪，点击占位符触发渲染');
              placeholder.click();
              await new Promise(function(resolve) { setTimeout(resolve, 1500); });
              commentInput = window.__wx_parsers__.getCommentInput();
            }
          }

          disabledResult = getCommentDisabledResult();
          if (disabledResult) return disabledResult;
          if (!commentInput) {
            logCommentStage('input_missing');
            console.log('[API客户端] 未找到评论输入框，检查页面状态...');
            await new Promise(function(resolve) { setTimeout(resolve, 2000); });
            var commentBtns = document.querySelectorAll('[aria-label^="评论"]');
            if (commentBtns.length === 0) {
              return { success: false, message: '评论输入框未找到，页面状态已变化，未发送评论' };
            }
            return { success: false, message: '未找到评论输入框' };
          }

          logCommentStage('input_found');
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
            disabledResult = getCommentDisabledResult();
            if (disabledResult) return disabledResult;
            sendBtn = window.__wx_parsers__.getSendBtn();
            if (sendBtn) {
              console.log('[API客户端] 第' + (pollJ + 1) + '次轮询找到发送按钮');
              break;
            }
            await new Promise(function(resolve) { setTimeout(resolve, pollDelay); });
          }

          disabledResult = getCommentDisabledResult();
          if (disabledResult) return disabledResult;
          if (sendBtn) {
            commentSubmitted = true;
            logCommentStage('send_click');
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

          logCommentStage('send_button_missing');
          console.log('[API客户端] 未找到发送按钮，尝试检测评论是否已发出...');
          var commentBtnsAfter = document.querySelectorAll('[aria-label^="评论"]');
          if (commentBtnsAfter.length === 0) {
            return { success: false, message: '未找到发送按钮，页面状态已变化，未发送评论' };
          }
          console.log('[API客户端] 评论浮层未关闭，评论未发出');
          setTimeout(function() { try { window.close(); } catch(e) {} }, 500);
          return { success: false, message: '未找到发送按钮，评论未发出' };
        };

        var commentResult;
        try {
          commentResult = await _executeWithRetry(commentAttempt, 'do_comment');
        } catch (commentError) {
          if (!commentSubmitted) throw commentError;
          commentResult = { success: false, resultUnknown: true, message: '评论已点击发送，结果待核实' };
        }
        if (commentSubmitted && !commentResult.success) {
          commentResult = { success: false, resultUnknown: true, message: '评论已点击发送，结果待核实' };
        }
        logCommentStage('finished', { success: commentResult.success, result_unknown: !!commentResult.resultUnknown });
        return commentResult;
      }

      // get_comment_count 操作 - 从 Pinia Store 获取当前视频的评论总数
      if (action === 'get_comment_count') {
        var commentCountAttempt = async function() {
          console.log('[API客户端] get_comment_count 开始执行');
          var commentCount = 0;
          try {
            var app = document.querySelector('[data-v-app]') || document.getElementById('app');
            var vue = app && (app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component));
            var appContext = vue && (vue.appContext || (vue.ctx && vue.ctx.appContext));
            var globalProperties = appContext && appContext.config && appContext.config.globalProperties;
            var pinia = globalProperties && globalProperties.$pinia;
            if (!pinia || !pinia._s) {
              console.log('[API客户端] get_comment_count: pinia 未就绪');
              return { success: false, message: 'pinia 未就绪', count: 0 };
            }

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
          } catch (e) {
            console.error('[API客户端] get_comment_count 异常:', e);
            return { success: false, message: e.message, count: 0 };
          }

          console.log('[API客户端] get_comment_count: 评论总数=' + commentCount);
          return { success: true, count: commentCount };
        };

        return await _executeWithRetry(commentCountAttempt, 'get_comment_count');
      }

      // do_like_comment 操作 - 在评论区定位指定评论并点赞
      if (action === 'do_like_comment') {
        var targetContent = body.content || '';
        console.log('[API客户端] do_like_comment 开始, targetContent:', targetContent);

        var likeCommentAttempt = async function() {
          if (!targetContent) {
            return { success: false, message: '评论内容为空' };
          }

          // 在评论区列表中遍历查找匹配的评论行
          var selectors = [
            '.comment-list .comment-row',
            '.comment-list .comment-item',
            '[class*="comment-list"] > [class*="comment"]',
            '.comment-panel .comment-item'
          ];

          var commentRows = [];
          for (var si = 0; si < selectors.length; si++) {
            var nodes = document.querySelectorAll(selectors[si]);
            if (nodes && nodes.length > 0) {
              for (var ni = 0; ni < nodes.length; ni++) {
                commentRows.push(nodes[ni]);
              }
            }
          }

          if (commentRows.length === 0) {
            console.log('[API客户端] do_like_comment: 未找到评论行');
            return { success: false, message: '未找到评论列表' };
          }

          console.log('[API客户端] do_like_comment: 找到 ' + commentRows.length + ' 条评论');

          // 遍历每条评论，找匹配的内容
          for (var i = 0; i < commentRows.length; i++) {
            var row = commentRows[i];
            var rowText = (row.textContent || '').replace(/[\s\n\r]+/g, ' ').trim();

            // 全文匹配（包含目标内容）
            if (rowText.indexOf(targetContent) !== -1) {
              console.log('[API客户端] do_like_comment: 定位到目标评论 #' + i);

              // 在该行内查找点赞按钮（div.like-num）
              var likeBtn = row.querySelector('div.like-num');
              if (!likeBtn) {
                // 备用选择器
                var altSelectors = [
                  '[class*="like-num"]',
                  '[class*="like_num"]',
                  '[class*="like"] > span',
                  '[class*="digg"]'
                ];
                for (var ai = 0; ai < altSelectors.length; ai++) {
                  likeBtn = row.querySelector(altSelectors[ai]);
                  if (likeBtn) break;
                }
              }

              if (likeBtn) {
                console.log('[API客户端] do_like_comment: 找到点赞按钮，准备点击');
                // 滚动到可见区域
                likeBtn.scrollIntoViewIfNeeded && likeBtn.scrollIntoViewIfNeeded();
                await new Promise(function(resolve) { setTimeout(resolve, 300); });
                likeBtn.click();
                await new Promise(function(resolve) { setTimeout(resolve, 1000); });
                return { success: true, isLiked: true, message: '评论点赞成功' };
              } else {
                console.log('[API客户端] do_like_comment: 在评论行内未找到点赞按钮');
                return { success: false, message: '未找到点赞按钮' };
              }
            }
          }

          console.log('[API客户端] do_like_comment: 未找到匹配的评论内容');
          return { success: false, message: '未找到匹配的评论' };
        };

        return await _executeWithRetry(likeCommentAttempt, 'do_like_comment');
      }

      // do_reply_comment 操作 - 在评论区定位指定评论并回复
      if (action === 'do_reply_comment') {
        var targetContent = body.content || '';
        var replyContent = body.replyContent || '';
        __api_log('INF', 'do_reply_comment 开始, targetContent:', targetContent.slice(0, 50), ', replyContent:', replyContent.slice(0, 50));

        var replyCommentAttempt = async function() {
          if (!targetContent) {
            return { success: false, message: '评论内容为空' };
          }

          // 在评论区列表中遍历查找匹配的评论行
          var selectors = [
            '.comment-list .comment-row',
            '.comment-list .comment-item',
            '[class*="comment-list"] > [class*="comment"]',
            '.comment-panel .comment-item'
          ];

          var commentRows = [];
          for (var si = 0; si < selectors.length; si++) {
            var nodes = document.querySelectorAll(selectors[si]);
            if (nodes && nodes.length > 0) {
              for (var ni = 0; ni < nodes.length; ni++) {
                commentRows.push(nodes[ni]);
              }
            }
          }

          if (commentRows.length === 0) {
            __api_log('WRN', 'do_reply_comment: 未找到评论行');
            return { success: false, message: '未找到评论列表' };
          }

          __api_log('INF', 'do_reply_comment: 找到 ' + commentRows.length + ' 条评论');

          // 遍历每条评论，找匹配的内容
          for (var i = 0; i < commentRows.length; i++) {
            var row = commentRows[i];
            var rowText = (row.textContent || '').replace(/[\s\n\r]+/g, ' ').trim();

            if (rowText.indexOf(targetContent) !== -1) {
              __api_log('INF', 'do_reply_comment: 定位到目标评论 #' + i);

              // 在该行内查找"回复"按钮（span，内容为"回复"）
              var replyBtn = null;
              var allSpans = row.querySelectorAll('span');
              for (var si2 = 0; si2 < allSpans.length; si2++) {
                var spanText = (allSpans[si2].textContent || '').replace(/[\s\n\r]+/g, '').trim();
                if (spanText === '回复') {
                  replyBtn = allSpans[si2];
                  break;
                }
              }

              if (!replyBtn) {
                // 备用：找包含"回复"文本的元素
                var altReplySelectors = [
                  '[class*="reply"]',
                  '[class*="replay"]',
                  '[class*="comment-action"]'
                ];
                for (var ai2 = 0; ai2 < altReplySelectors.length; ai2++) {
                  var altNodes = row.querySelectorAll(altReplySelectors[ai2]);
                  for (var an = 0; an < altNodes.length; an++) {
                    var altText = (altNodes[an].textContent || '').replace(/[\s\n\r]+/g, '').trim();
                    if (altText.indexOf('回复') !== -1) {
                      replyBtn = altNodes[an];
                      break;
                    }
                  }
                  if (replyBtn) break;
                }
              }

              if (!replyBtn) {
                __api_log('WRN', 'do_reply_comment: 在评论行内未找到回复按钮');
                return { success: false, message: '未找到回复按钮' };
              }

              __api_log('INF', 'do_reply_comment: 找到回复按钮，准备点击');
              replyBtn.scrollIntoViewIfNeeded && replyBtn.scrollIntoViewIfNeeded();
              await new Promise(function(resolve) { setTimeout(resolve, 300); });
              replyBtn.click();

              // 等待回复输入框出现
              var pollMax = 8;
              var pollDelay = 500;
              var replyInput = null;

              for (var pi = 0; pi < pollMax; pi++) {
                await new Promise(function(resolve) { setTimeout(resolve, pollDelay); });

                // 查找回复输入框
                replyInput = document.querySelector('textarea[placeholder*="回复"], textarea[placeholder*="写回复"]');
                if (!replyInput) {
                  replyInput = document.querySelector('input[placeholder*="回复"], input[placeholder*="写回复"]');
                }
                if (!replyInput) {
                  var allTextareas = document.querySelectorAll('textarea');
                  for (var ti = 0; ti < allTextareas.length; ti++) {
                    var ph = allTextareas[ti].getAttribute('placeholder') || '';
                    if (ph.indexOf('回复') !== -1) {
                      replyInput = allTextareas[ti];
                      break;
                    }
                  }
                }
                if (!replyInput) {
                  var allInputs = document.querySelectorAll('input');
                  for (var ini = 0; ini < allInputs.length; ini++) {
                    var iph = allInputs[ini].getAttribute('placeholder') || '';
                    if (iph.indexOf('回复') !== -1) {
                      replyInput = allInputs[ini];
                      break;
                    }
                  }
                }

                if (replyInput) {
                  __api_log('INF', 'do_reply_comment: 第' + (pi + 1) + '次轮询找到回复输入框');
                  break;
                }
              }

              if (!replyInput) {
                __api_log('ERR', 'do_reply_comment: 未找到回复输入框');
                return { success: false, message: '未找到回复输入框' };
              }

              // 输入回复内容
              replyInput.scrollIntoViewIfNeeded && replyInput.scrollIntoViewIfNeeded();
              await new Promise(function(resolve) { setTimeout(resolve, 200); });
              replyInput.focus();

              var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
              if (nativeSetter) {
                nativeSetter.call(replyInput, replyContent);
                replyInput.dispatchEvent(new Event('input', { bubbles: true }));
                replyInput.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                replyInput.value = replyContent;
                replyInput.dispatchEvent(new Event('input', { bubbles: true }));
              }

              await new Promise(function(resolve) { setTimeout(resolve, 500); });

              // 提交：优先按 Enter
              replyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
              await new Promise(function(resolve) { setTimeout(resolve, 2000); });

              // 检查是否提交成功（输入框消失或内容清空）
              var stillOpen = document.querySelector('textarea[placeholder*="回复"], input[placeholder*="回复"]');
              if (!stillOpen) {
                __api_log('INF', 'do_reply_comment: 回复输入框已关闭，回复成功');
                return { success: true, isCommented: true, message: '回复成功' };
              }

              // 备用：点击发送按钮
              var sendBtnSelectors = [
                'button[class*="send"]',
                'button[class*="submit"]',
                'button[class*="comment"]',
                'span[class*="send"]',
                '[class*="send-btn"]'
              ];
              for (var sbi = 0; sbi < sendBtnSelectors.length; sbi++) {
                var sb = document.querySelector(sendBtnSelectors[sbi]);
                if (sb) {
                  sb.click();
                  await new Promise(function(resolve) { setTimeout(resolve, 1500); });
                  break;
                }
              }

              return { success: true, isCommented: true, message: '回复已发送' };
            }
          }

          __api_log('WRN', 'do_reply_comment: 未找到匹配的评论内容');
          return { success: false, message: '未找到匹配的评论' };
        };

        return await _executeWithRetry(replyCommentAttempt, 'do_reply_comment');
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

  // 通过 HTTP 回调发送精准匹配任务完成结果
  // Node.js hubClient 通过 GET /matching_result 轮询 Go HTTP 服务获取结果，
  // 因此浏览器端必须通过 HTTP POST 将结果写入 Go 的 Hub 缓存。
  sendMatchingCallback: function (taskID, result) {
    var callbackUrl = 'http://127.0.0.1:2025/__wx_channels_api/matching_callback';
    var payload = {
      task_id: taskID,
      success: result.success !== false,
      reason: result.reason || '',
      users: result.users || [],
      total: result.total || 0,
      target_num: result.target_num || 0,
      comment_count: result.comment_count || 0
    };

    fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      signal: AbortSignal.timeout(5000)
    }).then(function(response) {
      if (response.ok) {
        console.log('[API客户端] matching_callback 发送成功: task_id=' + taskID);
      } else {
        console.error('[API客户端] matching_callback 发送失败:', response.status);
      }
    }).catch(function(err) {
      console.error('[API客户端] matching_callback 失败:', err.message);
    });
  },

  // 通过 HTTP 回调发送精准匹配任务进度更新
  sendMatchingProgress: function (taskID, progress) {
    var callbackUrl = 'http://127.0.0.1:2025/__wx_channels_api/matching_progress';
    var payload = {
      task_id: taskID,
      comment_count: progress.comment_count || 0,
      user_count: progress.user_count || 0,
      target_num: progress.target_num || 0,
      percent: progress.percent || 0
    };

    fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      signal: AbortSignal.timeout(5000)
    }).catch(function(err) {
      console.error('[API客户端] matching_progress 失败:', err.message);
    });
  },

  // 通过 HTTP 回调发送 fetch_video_comments 结果（Node.js 通过轮询 fetch_comments_result 获取）
  sendFetchCommentsCallback: function (taskID, data) {
    var callbackUrl = 'https://127.0.0.1:2025/__wx_channels_api/fetch_comments_callback';
    var result = data.result || data || {};
    var payload = {
      task_id: taskID,
      success: data.success !== false,
      message: data.message || '',
      result: {
        panel_ready: !!result.panel_ready,
        items: result.items || null,
        total: result.total || 0,
        comment_count: result.comment_count || 0,
        has_more: !!result.has_more,
        buffer: result.buffer || '',
        raw_items: result.raw_items || []
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
        console.log('[API客户端] ★★★ [诊断] HTTP POST 成功: task_id=' + taskID + ', HTTP=' + response.status);
      } else {
        console.error('[API客户端] ★★★ [诊断] HTTP POST 失败: task_id=' + taskID + ', HTTP=' + response.status);
        response.text().then(function(text) {
          console.error('[API客户端] ★★★ [诊断]   响应体:', text);
        });
      }
    }).catch(function(err) {
      console.error('[API客户端] ★★★ [诊断] HTTP POST 异常: task_id=' + taskID + ', err=' + err.message);
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
window.__wx_api_client.startAutoPause();
window.addEventListener('pageshow', function() { window.__wx_api_client.startAutoPause(); });
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    window.__wx_api_client.startAutoPause();
    window.__wx_api_client.init();
  });
} else {
  window.__wx_api_client.startAutoPause();
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

    // 搜索页：在"动态"区块内获取卡片
    var dongtaiBlock = null;
    var resBlocks = document.querySelectorAll('.res-block');

    for (var rbi = 0; rbi < resBlocks.length; rbi++) {
      var block = resBlocks[rbi];
      var titleEl = block.querySelector('.block-title .title');
      var titleText = titleEl ? (titleEl.innerText || '').trim() : '';

      if (titleText === '动态') {
        dongtaiBlock = block;
        break;
      }
    }

    if (dongtaiBlock) {
      var cardGrid = dongtaiBlock.querySelector('.card-grid');
      if (cardGrid) {
        var cardEls = cardGrid.querySelectorAll('.object-card');
        for (var i = 0; i < cardEls.length; i++) {
          if (!cardEls[i].querySelector('[class*="live"], [ml-key="search-live-card"]')) {
            cards.push(cardEls[i]);
          }
        }
        return cards;
      }
    }

    // 作者页使用 finder-profile-card
    var els = document.querySelectorAll('div[ml-key="finder-profile-card"]');
    for (var i = 0; i < els.length; i++) {
      if (!els[i].querySelector('.living-tag, .live-card')) {
        cards.push(els[i]);
      }
    }
    return cards;
  }
};

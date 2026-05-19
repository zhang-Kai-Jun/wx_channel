视频号 (SPH) 模块完整架构文档
一、模块定位与任务类型
文件	任务类型	platform	task_type	核心功能
keyPost.js	行业词作者集	5	14	关键词搜索 -> 滚动采集作者 -> 入库
keyUser.js	行业词用户集	5	5	联系人搜索 -> HTTP API 直调 -> 入库
actionService.js	Agent 互动	5	7/8	打开主页 -> 点赞/关注/评论
二、三层架构总览
┌─────────────────────────────────────────────────────────────────┐│                     Electron 主进程 (Node.js)                    ││                                                                  ││  missionApi.js          任务调度总控                               ││   ├─ sphKeyPost()      作者集入口（keyPost.js）                   ││   ├─ sphKeyUser()      联系人入口（keyUser.js）                   ││   └─ actionService     互动服务                                   ││           │                                                      ││           ▼                                                      ││  hubClient.js          WS客户端（HTTP代理转发）                    ││   └─ POST http://127.0.0.1:2025/__wx_channels_api/action         │└────────────────────────────┬──────────────────────────────────────┘                             │                             ▼┌─────────────────────────────────────────────────────────────────┐│                    wx_channel (Go 服务，端口 2025)                 ││                                                                  ││  hub.go               WS Hub 中央协调器                           ││   ├─ 管理客户端连接                                               ││   ├─ API 路由（SendToSearchClients）                             ││   ├─ 任务状态广播（BroadcastTaskProgress）                        ││   └─ activeTaskClient 路由保障                                   ││                                                                  ││  handlers/api.go      HTTP Handler                               ││   └─ DOM 操作请求分发                                             ││                                                                  ││  api/task.go          任务 API（创建/查询/开始/暂停/删除）          ││   └─ SearchTaskService 任务持久化                                 ││                                                                  ││  database/            SQLite 数据库                               ││   └─ search_tasks / search_videos 表                            │└────────────────────────────┬──────────────────────────────────────┘                             │                             ▼ WebSocket / HTTP Callback┌─────────────────────────────────────────────────────────────────┐│                 微信视频号浏览器 (Chromium 嵌入式)                  ││                                                                  ││  api_client.js        WS通信 + 指令分发                           ││   └─ handleAPICall() 根据 key 路由到对应处理                      ││                                                                  ││  search.js            任务采集器                                   ││   └─ __wx_channels_search_task_collector                          ││       ├─ watchVideo()    初始化任务监听                           ││       ├─ startScroll()   开始滚动采集                             ││       └─ _triggerScrollWithTargetCount() 核心滚动逻辑             ││                                                                  ││  WXU.API2             微信内部 JS API                            ││   └─ finderSearch() / finderUserPage() / finderGetCommentDetail()└─────────────────────────────────────────────────────────────────┘
三、任务执行链路详解
3.1 作者集任务 (keyPost.js) 完整链路
用户点击"开始任务"  │  ▼missionApi.createMission() ──→ 写入 t_mission (status=1)  │  ▼missionApi.preCheckStartMission()  ├─ 获客/互动任务：检查账号是否已被占用（t_account.status=2）  ├─ 洞察任务：最多10个并发，不占账号锁  └─ 匿名任务：同类最多5个并发  │  ▼sphKeyPost() 主入口  │  ├─ ① closeAllSphWindows()    [wxApi.js] 关闭所有微信窗口  │     └─ Python win32gui 循环 Ctrl+W  │  ├─ ② launchSph()            [wxApi.js] 启动微信视频号  │     └─ Windows: start weixin://launchfinder  │  ├─ ③ hubClient.waitForClientReady(60s) 等待WS连接就绪  │     └─ 轮询 GET /__wx_channels_api/health  │  ├─ ④ 关键词主循环  │     │  │     ├─ 4.1 关闭 → 启动 → 等待连接（同上）  │     │  │     ├─ 4.2 executeSphOcrSearch() [sphOcr.js]  │     │     └─ hubClient.openWXUrl(searchUrl) 导航到搜索页  │     │     └─ hubClient.waitForPageReady("/web/pages/s")  │     │  │     ├─ 4.3 executeKeywordTask() 单关键词执行  │     │     │  │     │     ├─ 4.3.1 sphApi.createExternalTask(keyword, target)  │     │     │     └─ POST /api/v1/tasks/start  │     │     │     └─ Go: SearchTaskService.StartSearchTask() → listening 状态  │     │     │     └─ 返回 task_id  │     │     │  │     │     ├─ 4.3.2 sphApi.startExternalScroll(task_id)  │     │     │     └─ POST /api/v1/scroll/{id}/start  │     │     │     └─ Go: Hub.SendToSearchClients("watch_video", ...)  │     │     │     └─ (50ms后) Hub.SendToSearchClients("start_scroll", ...)  │     │     │     └─ task status → "running"  │     │     │  │     │     ├─ 4.3.3 pollSingleExternalTask() 【轮询引擎，核心】  │     │     │     └─ sphApi.getExternalTaskStatus(task_id)  │     │     │     └─ GET /api/v1/tasks/{id}  │     │     │     └─ 返回 {status, video_list, current_count}  │     │     │  │     │     │     ┌─ 每次轮询处理逻辑：  │     │     │     ├─ video_list.length > lastProcessedCount?  │     │     │     │     └─ upsertAuthors() → t_custom 表（50条/批）  │     │     │     ├─ status = RUNNING → 继续轮询  │     │     │     ├─ status = LISTENING → 5次轮询检查一次URL  │     │     │     │     └─ 不在搜索页 → 重新发 start_scroll  │     │     │     ├─ 连续10次数量不变 → 重试滚动  │     │     │     ├─ 连续3次为0 → 重试滚动  │     │     │     └─ 任意退出点 → checkAndFlushRemaining() 强制入库  │     │     │  │     │     └─ 4.3.4 sphApi.deleteExternalTask(task_id)  │     │           └─ DELETE /api/v1/tasks/{id}  │     │  │     └─ 4.4 关键词间切换：closeCurrentSphWindow()  │  └─ ⑤ stopMission() / pauseMission()        └─ t_mission.status → 4(完成) / 3(暂停)        └─ 账号解锁 t_account.status → 0
3.2 联系人任务 (keyUser.js) 完整链路
用户点击"开始任务"  │  ▼missionApi.createMission() ──→ 写入 t_mission (status=1)  │  ▼sphKeyUser() 主入口  │  ├─ ① 打开视频号窗口（流程同上）  │  ├─ ② 关键词主循环  │     ├─ 2.1 fetchAllKeywordUsers() 单关键词  │     │     │  │     │     ├─ 2.1.1 sphChannelsContactSearch(keyword)  │     │     │     └─ GET /channels/contact/search?keyword=xxx&type=3  │     │     │     └─ HTTP 代理转发到 inject  │     │     │     └─ 返回 infoList[]  │     │     │     └─ 重试: 最多5次，每次30s超时，2s固定间隔  │     │     │  │     │     ├─ 2.1.2 全局去重（seenUsernames Set）  │     │     ├─ 2.1.3 屏蔽词过滤（kws_no / kws_no_name）  │     │     └─ 2.1.4 batchSaveUsers() → saveCustomData() → t_custom  │     │  │     └─ 2.2 重复直到达到目标数量或达到最大重试  │  └─ ③ 关闭视频号窗口
3.3 Agent 互动任务 (actionService.js) 完整链路
missionApi.startMission() → task_type=7/8  │  ▼actionService.execute()  │  ├─ ① hubClient.openProfile(custom.author_url) 打开主页  │     └─ POST __wx_channels_api/action  │     └─ Go → Hub.CallAPI("key:channels:dom_action")  │     └─ inject → WXU.API2.finderUserPage() 或 window.location.href  │  ├─ ② hubClient.getCurrentUrl() × 5 验证URL  │     └─ 提取 username 参数对比目标  │  ├─ ③ hubClient.enterVideo(videoIndex) 进入视频  │     └─ 同上，但验证包含 oid/nid/nonceId  │  ├─ ④ hubClient.doLike() / doFollow() / doComment()  │     └─ 每个操作后都验证 DOM 状态  │     └─ 评论: getNextComment() 轮换评论内容  │  └─ ⑤ missionApi.updateMissionLog() 记录日志
四、关键交互点详解
4.1 Hub 路由保障机制 (activeTaskClient)
Hub 维护一个指向当前活跃任务客户端的指针：
// watch_video 时记录该客户端func (h *Hub) handleWatchVideo(client *Client, taskId string) {    h.activeTaskClient = client}// 后续所有该任务的指令必定发往同一客户端func (h *Hub) SendToSearchClients(action string, payload map[string]any) {    // 优先使用 activeTaskClient，防止多标签页混乱    if h.activeTaskClient != nil {        h.activeTaskClient.Send(msg)    }}
作用：防止用户打开多个视频号标签页时，指令被路由到错误的客户端。
4.2 导航操作的双通道响应
open_profile 和 enter_video 会触发页面跳转，导致 WebSocket 断开。为避免响应丢失，采用双通道机制：
Inject 检测到导航操作  │  ├─ 立即调用 POST http://127.0.0.1:2025/__wx_channels_api/response_callback  │     └─ 返回 "navigating" 让 Electron 端快速拿到响应  │  └─ 执行 window.location.href 导航        │        └─ WS 断开，inject 尝试重连              └─ WS 重连成功                    └─ 正常 WebSocket 响应通道恢复
4.3 滚动采集策略 (_triggerScrollWithTargetCount)
_triggerScrollWithTargetCount() {    // 1. 触发滚动（scrollHeight + 600，触发懒加载）    this._scrollTo(this._lastScrollHeight + 600);        // 2. 轮询等待 loading 节点消失（最多15秒）    this._pollForLoading(() => {        // 3. 同步新视频        this._syncCollectorFeeds();                // 4. 有新增 → 继续滚动        if (this._newFeedsCount > 0) return true;                // 5. 无新增 → 重试3次（间隔1/2/3秒）        // 6. 3次无新增 → 等待3秒确认        // 7. 确认无数据 → _reportTaskComplete()    });}
4.4 DB + 内存双重防重
数据库层：search_videos 表有 (task_id, video_index) 唯一索引，重复写入会报错
内存层：__wx_channels_search_task_collector._matchedVideos Set 去重
4.5 强制入库兜底机制 (checkAndFlushRemaining)
keyPost.js 在任何退出点之前都调用此函数：
// 退出路径包括：// - 状态变为 COMPLETED/FAILED// - 连续10次数量不变// - 连续3次为0// - 用户暂停/停止任务// - 轮询超时// - LISTENING 状态超时// 所有路径统一调用：await checkAndFlushRemaining();// → 确保 video_list 中所有未入库的数据全部写入 t_custom
4.6 联系人搜索的双模式
keyUser.js 实际存在但有未导出函数的问题。核心 HTTP API：
// sphApi.js 中存在sphChannelsContactSearch(keyword)  → GET /channels/contact/search?keyword=xxx&type=3  → inject 拦截并调用 WXU.API2.finderSearch  → 返回 infoList[]  → 重试: 5次 × 30s超时 × 2s间隔
五、任务稳定性保障体系
5.1 层级化重试策略
层级	范围	策略	触发条件
单次请求重试	HTTP 请求	最多5次，固定2s间隔	网络错误 / 超时
关键词级重试	整个关键词	3次（每次等5s后重试）	关键词连续失败
关键词降级重试	目标减半	失败后目标数÷2重试1次	关键词级重试耗尽
滚动重试	滚动过程	最多3次	连续数量不变 / 连续为0
5.2 指数退避（待实施）
当前固定2s间隔，建议改为：
delay = 2000 × 2^(attempt-1)→ 2s → 4s → 8s → 16s → 32s
5.3 分段获取（待实施）
当前一次请求目标60条，改为分段：
目标60条 → 分3批，每批20条失败时最多损失20条，而非全部60条
5.4 空结果兜底（待实施）
两次请求确认：
sphChannelsContactSearch(keyword)  ↓ code=0, infoList=[空]等待5ssphChannelsContactSearch(keyword)  // 再试一次  ↓ 有数据 → 继续  ↓ 仍为空 → 放弃该关键词
5.5 浏览器预检
导航后额外等待：
// 当前const pageReady = await hubClient.waitForPageReady("/web/pages/s", 60);// 建议改为：预检搜索框元素是否存在const searchBox = await hubClient.evaluate(    "document.querySelector('.search_input') !== null");if (!searchBox) {    // 重新触发搜索    await hubClient.evaluate(        "document.querySelector('.search_input').value = keyword"    );}
5.6 Hub 会话重置原子性
resetHubSession 执行流程：  ① Hub.ResetSession()     关闭所有WS + 清理pending请求  ② 轮询等待 clientCount === 0（最多15s）  ③ launchSph()            启动新微信窗口  ④ Hub 检测到新客户端注册  ⑤ Hub 更新 lastClient  ⑥ 后续指令发往新客户端
六、数据流汇总
t_custom 入库数据字段映射
作者集 (keyPost.js):  username      → user_id, author_url  nickname      → nick_name  signature     → signature (最多200字)  headUrl       → avatar_url  extInfo       → ip_label (省+市)  keyword       → kw_text  videoCount    → (存 comment 或 extra)联系人集 (keyUser.js):  username      → user_id, author_url  nickname      → nick_name  signature     → signature  headUrl       → avatar_url  extInfo       → ip_label, wechat, mobile  keyword       → kw_text
任务状态流转
t_mission.status:  1 (排队) ──────────────────────┐  2 (运行) ──→ 3 (暂停) ────────┤  4 (完成) ←─────────────────────┘search_tasks.status (Go端):  pending ──→ listening ──→ running ──→ completed/failed                        ↕                      paused

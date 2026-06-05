package handlers

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"wx_channel/internal/config"
	"wx_channel/internal/utils"

	"wx_channel/pkg/util"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	sunnyPublic "github.com/qtgolang/SunnyNet/public"
)

// ScriptHandler JavaScript注入处理器
type ScriptHandler struct {
	coreJS          []byte
	decryptJS       []byte
	downloadJS      []byte
	homeJS          []byte
	feedJS          []byte
	profileJS       []byte
	searchJS        []byte
	batchDownloadJS []byte
	zipJS           []byte
	fileSaverJS     []byte
	mittJS          []byte
	eventbusJS      []byte
	utilsJS         []byte
	apiClientJS     []byte
	keepAliveJS     []byte
	version         string
}

// NewScriptHandler 创建脚本处理器
func NewScriptHandler(cfg *config.Config, coreJS, decryptJS, downloadJS, homeJS, feedJS, profileJS, searchJS, batchDownloadJS, zipJS, fileSaverJS, mittJS, eventbusJS, utilsJS, apiClientJS, keepAliveJS []byte, version string) *ScriptHandler {
	return &ScriptHandler{
		coreJS:          coreJS,
		decryptJS:       decryptJS,
		downloadJS:      downloadJS,
		homeJS:          homeJS,
		feedJS:          feedJS,
		profileJS:       profileJS,
		searchJS:        searchJS,
		batchDownloadJS: batchDownloadJS,
		zipJS:           zipJS,
		fileSaverJS:     fileSaverJS,
		mittJS:          mittJS,
		eventbusJS:      eventbusJS,
		utilsJS:         utilsJS,
		apiClientJS:     apiClientJS,
		keepAliveJS:     keepAliveJS,
		version:         version,
	}
}

// getConfig 获取当前配置（动态获取最新配置）
func (h *ScriptHandler) getConfig() *config.Config {
	return config.Get()
}

// Handle implements router.Interceptor
func (h *ScriptHandler) Handle(Conn *SunnyNet.HttpConn) bool {

	if Conn.Type != sunnyPublic.HttpResponseOK {
		return false
	}

	// 防御性检查
	if Conn.Request == nil || Conn.Request.URL == nil {
		return false
	}

	// 只有响应成功且有内容才处理
	if Conn.Response == nil || Conn.Response.Body == nil {
		return false
	}

	// 读取响应体
	// 注意：这里读取了Body，如果未被修改，需要重新赋值回去
	body, err := io.ReadAll(Conn.Response.Body)
	if err != nil {
		return false
	}
	_ = Conn.Response.Body.Close()

	host := Conn.Request.URL.Hostname()
	path := Conn.Request.URL.Path

	// 记录所有JS文件的加载（简略日志）
	if strings.HasSuffix(path, ".js") {
		contentType := strings.ToLower(Conn.Response.Header.Get("content-type"))
		utils.LogFileInfo("[响应] Path=%s | ContentType=%s", path, contentType)
	}

	if h.HandleHTMLResponse(Conn, host, path, body) {
		return true
	}

	if h.HandleJavaScriptResponse(Conn, host, path, body) {
		return true
	}

	// 如果没有处理，恢复Body
	Conn.Response.Body = io.NopCloser(bytes.NewBuffer(body))
	return false
}

// HandleHTMLResponse 处理HTML响应，注入JavaScript代码
func (h *ScriptHandler) HandleHTMLResponse(Conn *SunnyNet.HttpConn, host, path string, body []byte) bool {
	contentType := strings.ToLower(Conn.Response.Header.Get("content-type"))
	if contentType != "text/html; charset=utf-8" {
		return false
	}

	html := string(body)

	// 添加版本号到JS引用
	scriptReg1 := regexp.MustCompile(`src="([^"]{1,})\.js"`)
	html = scriptReg1.ReplaceAllString(html, `src="$1.js`+h.version+`"`)
	scriptReg2 := regexp.MustCompile(`href="([^"]{1,})\.js"`)
	html = scriptReg2.ReplaceAllString(html, `href="$1.js`+h.version+`"`)
	Conn.Response.Header.Set("__debug", "append_script")

	if host == "channels.weixin.qq.com" && (path == "/web/pages/feed" || path == "/web/pages/home" || path == "/web/pages/profile" || path == "/web/pages/s" || path == "/web/pages/account/like") {
		// 根据页面路径注入不同的脚本
		injectedScripts := h.buildInjectedScripts(path)
		html = strings.Replace(html, "<head>", "<head>\n"+injectedScripts, 1)
		utils.LogFileInfo("页面已成功加载！")
		utils.LogFileInfo("已添加视频缓存监控和提醒功能")
		utils.LogFileInfo("[页面加载] 视频号页面已加载 | Host=%s | Path=%s", host, path)
		Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(html)))
		return true
	}

	Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(html)))
	return true
}

// HandleJavaScriptResponse 处理JavaScript响应，修改JavaScript代码
func (h *ScriptHandler) HandleJavaScriptResponse(Conn *SunnyNet.HttpConn, host, path string, body []byte) bool {
	contentType := strings.ToLower(Conn.Response.Header.Get("content-type"))
	if contentType != "application/javascript" {
		return false
	}

	// 记录所有JS文件的加载（用于调试）
	utils.LogFileInfo("[JS文件] %s", path)

	// 保存关键的 JS 文件到本地以便分析
	h.saveJavaScriptFile(path, body)

	content := string(body)

	// 添加版本号到JS引用
	depReg := regexp.MustCompile(`"js/([^"]{1,})\.js"`)
	fromReg := regexp.MustCompile(`from {0,1}"([^"]{1,})\.js"`)
	lazyImportReg := regexp.MustCompile(`import\("([^"]{1,})\.js"\)`)
	importReg := regexp.MustCompile(`import {0,1}"([^"]{1,})\.js"`)
	content = fromReg.ReplaceAllString(content, `from"$1.js`+h.version+`"`)
	content = depReg.ReplaceAllString(content, `"js/$1.js`+h.version+`"`)
	content = lazyImportReg.ReplaceAllString(content, `import("$1.js`+h.version+`")`)
	content = importReg.ReplaceAllString(content, `import"$1.js`+h.version+`"`)
	Conn.Response.Header.Set("__debug", "replace_script")

	// 处理不同的JS文件
	content, handled := h.handleIndexPublish(path, content)
	if handled {
		Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(content)))
		return true
	}
	content, handled = h.handleVirtualSvgIcons(path, content)
	if handled {
		Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(content)))
		return true
	}

	content, handled = h.handleWorkerRelease(path, content)
	if handled {
		Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(content)))
		return true
	}
	content, handled = h.handleConnectPublish(Conn, path, content)
	if handled {
		return true
	}

	Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(content)))
	return true
}

// buildInjectedScripts 构建所有需要注入的脚本（根据页面路径注入不同脚本）
func (h *ScriptHandler) buildInjectedScripts(path string) string {
	// 日志面板脚本（必须在最前面，以便拦截所有console输出）- 所有页面都需要
	logPanelScript := h.getLogPanelScript()

	// 事件系统脚本（mitt + eventbus + utils）- 必须在主脚本之前加载
	mittScript := fmt.Sprintf(`<script>%s</script>`, string(h.mittJS))
	eventbusScript := fmt.Sprintf(`<script>%s</script>`, string(h.eventbusJS))
	utilsScript := fmt.Sprintf(`<script>%s</script>`, string(h.utilsJS))

	// API 客户端脚本 - 必须在其他脚本之前加载
	apiClientScript := fmt.Sprintf(`<script>%s</script>`, string(h.apiClientJS))

	// 页面保活脚本 - 防止页面休眠
	keepAliveScript := fmt.Sprintf(`<script>%s</script>`, string(h.keepAliveJS))

	// 模块化脚本 - 按依赖顺序加载
	coreScript := fmt.Sprintf(`<script>%s</script>`, string(h.coreJS))
	decryptScript := fmt.Sprintf(`<script>%s</script>`, string(h.decryptJS))
	downloadScript := fmt.Sprintf(`<script>%s</script>`, string(h.downloadJS))
	batchDownloadScript := fmt.Sprintf(`<script>%s</script>`, string(h.batchDownloadJS))
	feedScript := fmt.Sprintf(`<script>%s</script>`, string(h.feedJS))
	profileScript := fmt.Sprintf(`<script>%s</script>`, string(h.profileJS))
	searchScript := fmt.Sprintf(`<script>%s</script>`, string(h.searchJS))
	homeScript := fmt.Sprintf(`<script>%s</script>`, string(h.homeJS))

	// 预加载FileSaver.js库 - 所有页面都需要
	preloadScript := h.getPreloadScript()

	// 下载记录功能 - 所有页面都需要
	downloadTrackerScript := h.getDownloadTrackerScript()

	// 捕获URL脚本 - 所有页面都需要
	captureUrlScript := h.getCaptureUrlScript()

	// 保存页面内容脚本 - 所有页面都需要（用于保存快照）
	savePageContentScript := h.getSavePageContentScript()

	// 基础脚本（所有页面都需要）
	baseScripts := logPanelScript + mittScript + eventbusScript + utilsScript + apiClientScript + keepAliveScript + coreScript + decryptScript + downloadScript + batchDownloadScript + feedScript + profileScript + searchScript + homeScript + preloadScript + downloadTrackerScript + captureUrlScript + savePageContentScript

	// 根据页面路径决定是否注入特定脚本
	var pageSpecificScripts string

	switch path {
	case "/web/pages/home":
		// Home页面：新版部分链接会渲染成详情页模式，因此同时注入评论采集脚本
		pageSpecificScripts = h.getVideoCacheNotificationScript() + h.getCommentCaptureScript()
		utils.LogFileInfo("[脚本] Home页面 - 注入视频缓存监控和评论采集脚本")

	case "/web/pages/profile":
		// Profile页面（视频列表）：不需要特定脚本
		pageSpecificScripts = ""
		utils.LogFileInfo("[脚本] Profile页面 - 仅注入基础脚本")

	case "/web/pages/account/like":
		// 赞过页面会加载被全局改写的公共 bundle，需要基础脚本环境避免 WXU/WXE 未定义
		pageSpecificScripts = ""
		utils.LogFileInfo("[脚本] Account Like页面 - 注入基础脚本以兼容公共 JS 事件")

	case "/web/pages/feed":
		// Feed页面（视频详情）：注入视频缓存监控、评论采集、精准匹配脚本、获取评论脚本
		pageSpecificScripts = h.getVideoCacheNotificationScript() + h.getCommentCaptureScript() + h.getVideoCommentsMatchingScript() + h.getFetchVideoCommentsScript()
		utils.LogFileInfo("[脚本] Feed页面 - 注入视频缓存监控、评论采集、精准匹配和获取评论脚本")

	case "/web/pages/s":
		// 搜索页面：注入搜索模块
		pageSpecificScripts = searchScript
		utils.LogInfo("[脚本] 搜索页面 - 注入搜索模块（事件系统）")

	default:
		// 其他页面：不注入页面特定脚本
		pageSpecificScripts = ""
		utils.LogInfo("[脚本] 其他页面 - 仅注入基础脚本")
	}

	// 初始化脚本（延迟执行）
	initScript := `<script>
console.log('[init] 开始初始化...');
setTimeout(function() {
	console.log('[init] 执行 insert_download_btn');
	if (typeof insert_download_btn === 'function') {
		insert_download_btn();
	} else {
		console.error('[init] insert_download_btn 函数未定义');
	}
}, 800);
</script>`

	return baseScripts + pageSpecificScripts + initScript
}

// getPreloadScript 获取预加载FileSaver.js库的脚本
func (h *ScriptHandler) getPreloadScript() string {
	return `<script>
	// 预加载FileSaver.js库
	(function() {
		const script = document.createElement('script');
		script.src = '/FileSaver.min.js';
		document.head.appendChild(script);
	})();
	</script>`
}

// getDownloadTrackerScript 获取下载记录功能的脚本
func (h *ScriptHandler) getDownloadTrackerScript() string {
	return `<script>
	// 确保FileSaver.js库已加载
	if (typeof saveAs === 'undefined') {
		console.log('加载FileSaver.js库');
		const script = document.createElement('script');
		script.src = '/FileSaver.min.js';
		script.onload = function() {
			console.log('FileSaver.js库加载成功');
		};
		document.head.appendChild(script);
	}

	// 跟踪已记录的下载，防止重复记录
	window.__wx_channels_recorded_downloads = {};

	// 添加下载记录功能
	window.__wx_channels_record_download = function(data) {
		// 检查是否已经记录过这个下载
		const recordKey = data.id;
		if (window.__wx_channels_recorded_downloads[recordKey]) {
			console.log("已经记录过此下载，跳过记录");
			return;
		}
		
		// 标记为已记录
		window.__wx_channels_recorded_downloads[recordKey] = true;
		
		// 发送到记录API
		fetch("/__wx_channels_api/record_download", {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(data)
		});
	};
	
	// 暂停视频的辅助函数（只暂停，不阻止自动切换）
	// 分层降级策略：Video.js API → video.pause() → XPath按钮 → CSS按钮 → 键盘空格键
	window.__wx_channels_pause_video__ = function() {
		console.log('[视频助手] 暂停视频（下载期间）...');
		try {
			const pausedVideos = [];

			// === 同步块：立即暂停可见视频，立即返回 ===
			if (typeof videojs !== 'undefined') {
				const players = videojs.getAllPlayers?.() || [];
				for (const player of players) {
					if (player && typeof player.pause === 'function' && !player.paused()) {
						player.pause();
						pausedVideos.push({ type: 'videojs', player });
					}
				}
			}
			const allVideos = Array.from(document.querySelectorAll('video'));
			for (const video of allVideos) {
				if (!video.paused) {
					video.pause();
					pausedVideos.push({ type: 'native', video });
				}
			}
			console.log('[视频助手] 立即暂停完成，共', pausedVideos.length, '个视频');
			// 立即返回，不阻塞
			return pausedVideos;
		} catch (e) {
			console.error('[视频助手] 暂停视频失败:', e);
			return [];
		}
	};

	// 恢复视频播放的辅助函数
	// 分层降级策略：player.play() → video.play() → 键盘空格键
	window.__wx_channels_resume_video__ = function(pausedVideos) {
		if (!pausedVideos || pausedVideos.length === 0) return;
		console.log('[视频助手] 恢复视频播放，共', pausedVideos.length, '个');
		try {
			for (const item of pausedVideos) {
				if (item.type === 'videojs' && item.player) {
					try { item.player.play(); }
					catch (e) { console.log('[视频助手] Video.js play 失败:', e.message); }
				} else if (item.type === 'native' && item.video) {
					try { item.video.play(); }
					catch (e) { console.log('[视频助手] native play 失败:', e.message); }
				}
			}
			// 备用：尝试键盘空格键
			setTimeout(() => {
				const videos = Array.from(document.querySelectorAll('video')).filter(v => v.offsetWidth > 0);
				if (videos.length > 0) videos[0].focus();
				document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', keyCode: 32, bubbles: true }));
				document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', keyCode: 32, bubbles: true }));
			}, 200);
		} catch (e) {
			console.error('[视频助手] 恢复视频失败:', e);
		}
	};
	
	// 覆盖原有的下载处理函数
	const originalHandleClick = window.__wx_channels_handle_click_download__;
	if (originalHandleClick) {
		window.__wx_channels_handle_click_download__ = function(sp) {
			// 暂停视频
			const pausedVideos = window.__wx_channels_pause_video__();
			
			// 调用原始函数进行下载
			originalHandleClick(sp);
			
			// 注意：不再手动记录下载，因为后端API已经处理了记录保存
			// 移除重复的记录调用以避免CSV中出现重复记录
			
			// 3秒后恢复播放（给下载一些时间开始）
			setTimeout(() => {
				window.__wx_channels_resume_video__(pausedVideos);
			}, 5000);
		};
	}
	
	// 覆盖当前视频下载函数
	const originalDownloadCur = window.__wx_channels_download_cur__;
	if (originalDownloadCur) {
		window.__wx_channels_download_cur__ = function() {
			// 暂停视频
			const pausedVideos = window.__wx_channels_pause_video__();
			
			// 调用原始函数进行下载
			originalDownloadCur();
			
			// 注意：不再手动记录下载，因为后端API已经处理了记录保存
			// 移除重复的记录调用以避免CSV中出现重复记录
			
			// 3秒后恢复播放（给下载一些时间开始）
			setTimeout(() => {
				window.__wx_channels_resume_video__(pausedVideos);
			}, 3000);
		};
	}
	
	// 优化封面下载函数：使用后端API保存到服务器
	window.__wx_channels_handle_download_cover = function() {
		if (window.__wx_channels_store__ && window.__wx_channels_store__.profile) {
			const profile = window.__wx_channels_store__.profile;
			// 优先使用thumbUrl，然后是fullThumbUrl，最后才是coverUrl
			const coverUrl = profile.thumbUrl || profile.fullThumbUrl || profile.coverUrl;
			
			if (!coverUrl) {
				// alert("未找到封面图片");
				return;
			}
			
			// 记录日志
			if (window.__wx_log) {
				window.__wx_log({
					msg: '正在保存封面到服务器...\n' + coverUrl
				});
			}
			
			// 构建请求数据
			const requestData = {
				coverUrl: coverUrl,
				videoId: profile.id || '',
				title: profile.title || '',
				author: profile.nickname || (profile.contact && profile.contact.nickname) || '未知作者',
				forceSave: false
			};
			
			// 添加授权头
			const headers = {
				'Content-Type': 'application/json'
			};
			if (window.__WX_LOCAL_TOKEN__) {
				headers['X-Local-Auth'] = window.__WX_LOCAL_TOKEN__;
			}
			
			// 发送到后端API保存封面
			fetch('/__wx_channels_api/save_cover', {
				method: 'POST',
				headers: headers,
				body: JSON.stringify(requestData)
			})
			.then(response => response.json())
			.then(data => {
				if (data.success) {
					const msg = data.message || '封面已保存';
					const path = data.relativePath || data.path || '';
					if (window.__wx_log) {
						window.__wx_log({
							msg: '✓ ' + msg
						});
					}
					console.log('✓ [封面下载] 封面已保存:', path);
				} else {
					const errorMsg = data.error || '保存封面失败';
					if (window.__wx_log) {
						window.__wx_log({
							msg: '❌ ' + errorMsg
						});
					}
					// alert('保存封面失败: ' + errorMsg);
				}
			})
			.catch(error => {
				console.error("保存封面失败:", error);
				if (window.__wx_log) {
					window.__wx_log({
						msg: '❌ 保存封面失败: ' + error.message
					});
				}
				// alert("保存封面失败: " + error.message);
			});
		} else {
			// alert("未找到视频信息");
		}
	};
	</script>`
}

// getCaptureUrlScript 获取捕获完整URL的脚本
func (h *ScriptHandler) getCaptureUrlScript() string {
	return `<script>
	setTimeout(function() {
		// 获取完整的URL
		var fullUrl = window.location.href;
		// 发送到我们的API端点
		fetch("/__wx_channels_api/page_url", {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				url: fullUrl
			})
		});
	}, 2000); // 延迟2秒执行，确保页面完全加载
	</script>`
}

// getSavePageContentScript 获取保存页面内容的脚本
func (h *ScriptHandler) getSavePageContentScript() string {
	return `<script>
	// 简单的字符串哈希函数 (djb2算法)
	function computeHash(str) {
		var hash = 5381;
		var i = str.length;
		while(i) {
			hash = (hash * 33) ^ str.charCodeAt(--i);
		}
		return hash >>> 0; // 强制转换为无符号32位整数
	}

	// 状态变量
	window.__wx_last_saved_hash = 0;
	window.__wx_save_timer = null;

	// 保存当前页面完整内容的函数 (带去重和防抖)
	window.__wx_channels_save_page_content = function(force) {
		try {
			// 清除之前的定时器
			if (window.__wx_save_timer) {
				clearTimeout(window.__wx_save_timer);
				window.__wx_save_timer = null;
			}

			// 获取当前完整的HTML内容
			var fullHtml = document.documentElement.outerHTML;
			
			// 计算哈希
			var currentHash = computeHash(fullHtml);

			// 如果不是强制保存，且哈希值与上次相同，则跳过
			if (!force && currentHash === window.__wx_last_saved_hash) {
				// console.log("[PageSave] 内容未变化，跳过保存");
				return;
			}

			var currentUrl = window.location.href;
			
			// 发送到保存API
			fetch("/__wx_channels_api/save_page_content", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					url: currentUrl,
					html: fullHtml,
					timestamp: new Date().getTime()
				})
			}).then(response => {
				if (response.ok) {
					console.log("[PageSave] 页面内容已保存");
					window.__wx_last_saved_hash = currentHash;
				}
			}).catch(error => {
				console.error("[PageSave] 保存页面内容失败:", error);
			});
		} catch (error) {
			console.error("[PageSave] 获取页面内容失败:", error);
		}
	};
	
	// 触发带防抖的保存 (默认延迟2秒)
	window.__wx_trigger_save_page = function(delay) {
		if (typeof delay === 'undefined') delay = 2000;
		
		if (window.__wx_save_timer) {
			clearTimeout(window.__wx_save_timer);
		}
		
		window.__wx_save_timer = setTimeout(function() {
			window.__wx_channels_save_page_content(false);
		}, delay);
	};

	// 监听URL变化，自动保存页面内容
	let currentPageUrl = window.location.href;
	const checkUrlChange = () => {
		if (window.location.href !== currentPageUrl) {
			currentPageUrl = window.location.href;
			// URL变化后延迟保存，等待内容加载
			window.__wx_trigger_save_page(5000);
		}
	};
	
	// 定期检查URL变化（适用于SPA）
	setInterval(checkUrlChange, 1000);
	
	// 监听历史记录变化
	window.addEventListener('popstate', () => {
		window.__wx_trigger_save_page(3000);
	});
	
	// 在页面加载完成后也保存一次
	setTimeout(() => {
		window.__wx_trigger_save_page(2000);
	}, 8000);
	</script>`
}

// getVideoCacheNotificationScript 获取视频缓存监控脚本
func (h *ScriptHandler) getVideoCacheNotificationScript() string {
	return `<script>
	// 初始化视频缓存监控
	window.__wx_channels_video_cache_monitor = {
		isBuffering: false,
		lastBufferTime: 0,
		totalBufferSize: 0,
		videoSize: 0,
		completeThreshold: 0.98, // 认为98%缓冲完成时视频已缓存完成
		checkInterval: null,
		notificationShown: false, // 防止重复显示通知
		
		// 开始监控缓存
		startMonitoring: function(expectedSize) {
			console.log('=== 开始启动视频缓存监控 ===');
			
			// 检查播放器状态
			const vjsPlayer = document.querySelector('.video-js');
			const video = vjsPlayer ? vjsPlayer.querySelector('video') : document.querySelector('video');
			
			if (!video) {
				console.error('未找到视频元素，无法启动监控');
				return;
			}
			
			console.log('视频元素状态:');
			console.log('- readyState:', video.readyState);
			console.log('- duration:', video.duration);
			console.log('- buffered.length:', video.buffered ? video.buffered.length : 0);
			
			if (this.checkInterval) {
				clearInterval(this.checkInterval);
			}
			
			this.isBuffering = true;
			this.lastBufferTime = Date.now();
			this.totalBufferSize = 0;
			this.videoSize = expectedSize || 0;
			this.notificationShown = false; // 重置通知状态
			
			console.log('视频缓存监控已启动');
			console.log('- 视频大小:', (this.videoSize / (1024 * 1024)).toFixed(2) + 'MB');
			console.log('- 监控间隔: 2秒');
			
			// 定期检查缓冲状态 - 增加检查频率
			this.checkInterval = setInterval(() => this.checkBufferStatus(), 2000);
			
			// 添加可见的缓存状态指示器
			this.addStatusIndicator();
			
			// 监听视频播放完成事件
			this.setupVideoEndedListener();
			
			// 延迟开始监控，让播放器有时间初始化
			setTimeout(() =>{
				this.monitorNativeBuffering();
			}, 1000);
		},
		
		// 监控Video.js播放器和原生视频元素的缓冲状态
		monitorNativeBuffering: function() {
			let firstCheck = true; // 标记是否是第一次检查
			const checkBufferedProgress = () => {
				// 优先检查Video.js播放器
				const vjsPlayer = document.querySelector('.video-js');
				let video = null;
				
				if (vjsPlayer) {
					// 从Video.js播放器中获取video元素
					video = vjsPlayer.querySelector('video');
					if (firstCheck) {
						console.log('找到Video.js播放器，开始监控');
						firstCheck = false;
					}
				} else {
					// 回退到查找普通video元素
					const videoElements = document.querySelectorAll('video');
					if (videoElements.length > 0) {
						video = videoElements[0];
						if (firstCheck) {
							console.log('使用普通video元素监控');
							firstCheck = false;
						}
					}
				}
				
				if (video) {
					// 获取预加载进度条数据
					if (video.buffered && video.buffered.length > 0 && video.duration) {
						// 获取最后缓冲时间范围的结束位置
						const bufferedEnd = video.buffered.end(video.buffered.length - 1);
						// 计算缓冲百分比
						const bufferedPercent = (bufferedEnd / video.duration) * 100;
						
						// 更新页面指示器
						const indicator = document.getElementById('video-cache-indicator');
						if (indicator) {
							indicator.innerHTML = '<div>视频缓存中: ' + bufferedPercent.toFixed(1) + '% (Video.js播放器)</div>';
							
							// 高亮显示接近完成的状态
							if (bufferedPercent >= 95) {
								indicator.style.backgroundColor = 'rgba(0,128,0,0.8)';
							}
						}
						
						// 检查Video.js播放器的就绪状态（只在第一次检查时输出）
						if (vjsPlayer && typeof vjsPlayer.readyState !== 'undefined' && firstCheck) {
							console.log('Video.js播放器就绪状态:', vjsPlayer.readyState);
						}
						
						// 检查是否缓冲完成
						if (bufferedPercent >= 98) {
							console.log('根据Video.js播放器数据，视频已缓存完成 (' + bufferedPercent.toFixed(1) + '%)');
							this.showNotification();
							this.stopMonitoring();
							return true; // 缓存完成，停止监控
						}
					}
				}
				return false; // 继续监控
			};
			
			// 立即检查一次
			if (!checkBufferedProgress()) {
				// 每秒检查一次预加载进度
				const bufferCheckInterval = setInterval(() => {
					if (checkBufferedProgress() || !this.isBuffering) {
						clearInterval(bufferCheckInterval);
					}
				}, 1000);
			}
		},
		
		// 设置Video.js播放器和视频播放结束监听
		setupVideoEndedListener: function() {
			// 尝试查找Video.js播放器和视频元素
			setTimeout(() => {
				const vjsPlayer = document.querySelector('.video-js');
				let video = null;
				
				if (vjsPlayer) {
					// 从Video.js播放器中获取video元素
					video = vjsPlayer.querySelector('video');
					console.log('为Video.js播放器设置事件监听');
					
					// 尝试监听Video.js特有的事件
					if (vjsPlayer.addEventListener) {
						vjsPlayer.addEventListener('ended', () => {
							console.log('Video.js播放器播放结束，标记为缓存完成');
							this.showNotification();
							this.stopMonitoring();
						});
						
						vjsPlayer.addEventListener('loadeddata', () => {
							console.log('Video.js播放器数据加载完成');
						});
					}
				} else {
					// 回退到查找普通video元素
					const videoElements = document.querySelectorAll('video');
					if (videoElements.length > 0) {
						video = videoElements[0];
						console.log('为普通video元素设置事件监听');
					}
				}
				
				if (video) {
					// 监听视频播放结束事件
					video.addEventListener('ended', () => {
						console.log('视频播放已结束，标记为缓存完成');
						this.showNotification();
						this.stopMonitoring();
					});
					
					// 如果视频已在播放中，添加定期检查播放状态
					if (!video.paused) {
						const playStateInterval = setInterval(() => {
							// 如果视频已经播放完或接近结束（剩余小于2秒）
							if (video.ended || (video.duration && video.currentTime > 0 && video.duration - video.currentTime < 2)) {
								console.log('视频接近或已播放完成，标记为缓存完成');
								this.showNotification();
								this.stopMonitoring();
								clearInterval(playStateInterval);
							}
						}, 1000);
					}
				}
			}, 3000); // 延迟3秒再查找视频元素，确保Video.js播放器完全初始化
		},
		
		// 添加缓冲状态指示器
		addStatusIndicator: function() {
			console.log('正在创建缓存状态指示器...');
			
			// 移除现有指示器
			const existingIndicator = document.getElementById('video-cache-indicator');
			if (existingIndicator) {
				console.log('移除现有指示器');
				existingIndicator.remove();
			}
			
			// 创建新指示器
			const indicator = document.createElement('div');
			indicator.id = 'video-cache-indicator';
			indicator.style.cssText = "position:fixed;bottom:20px;left:20px;background-color:rgba(0,0,0,0.8);color:white;padding:10px 15px;border-radius:6px;z-index:99999;font-size:14px;font-family:Arial,sans-serif;border:2px solid rgba(255,255,255,0.3);";
			indicator.innerHTML = '<div>🔄 视频缓存中: 0%</div>';
			document.body.appendChild(indicator);
			
			console.log('缓存状态指示器已创建并添加到页面');
			
			// 初始化进度跟踪变量
			this.lastLoggedProgress = 0;
			this.stuckCheckCount = 0;
			this.maxStuckCount = 30; // 30秒不变则认为停滞
			
			// 每秒更新进度
			const updateInterval = setInterval(() => {
				if (!this.isBuffering) {
					clearInterval(updateInterval);
					indicator.remove();
					return;
				}
				
				let progress = 0;
				let progressSource = 'unknown';
				
				// 优先方案：从video元素实时读取（最准确）
				const vjsPlayer = document.querySelector('.video-js');
				let video = vjsPlayer ? vjsPlayer.querySelector('video') : null;
				
				if (!video) {
					const videoElements = document.querySelectorAll('video');
					if (videoElements.length > 0) {
						video = videoElements[0];
					}
				}
				
				if (video && video.buffered && video.buffered.length > 0) {
					try {
						const bufferedEnd = video.buffered.end(video.buffered.length - 1);
						const duration = video.duration;
						if (duration > 0 && !isNaN(duration) && isFinite(duration)) {
							progress = (bufferedEnd / duration) * 100;
							progressSource = 'video.buffered';
						}
					} catch (e) {
						// 忽略读取错误
					}
				}
				
				// 备用方案：使用 totalBufferSize
				if (progress === 0 && this.videoSize > 0 && this.totalBufferSize > 0) {
					progress = (this.totalBufferSize / this.videoSize) * 100;
					progressSource = 'totalBufferSize';
				}
				
				// 限制进度范围
				progress = Math.min(Math.max(progress, 0), 100);
				
				// 检测进度是否停滞
				const progressChanged = Math.abs(progress - this.lastLoggedProgress) >= 0.1;
				
				if (!progressChanged) {
					this.stuckCheckCount++;
				} else {
					this.stuckCheckCount = 0;
				}
				
				// 更新指示器
				if (progress > 0) {
					// 根据停滞状态显示不同的图标
					let icon = '🔄';
					let statusText = '视频缓存中';
					
					if (this.stuckCheckCount >= this.maxStuckCount) {
						icon = '⏸️';
						statusText = '缓存暂停';
						indicator.style.backgroundColor = 'rgba(128,128,128,0.8)';
					} else if (progress >= 95) {
						icon = '✅';
						statusText = '缓存接近完成';
						indicator.style.backgroundColor = 'rgba(0,128,0,0.8)';
					} else if (progress >= 50) {
						indicator.style.backgroundColor = 'rgba(255,165,0,0.8)';
					} else {
						indicator.style.backgroundColor = 'rgba(0,0,0,0.8)';
					}
					
					indicator.innerHTML = '<div>' + icon + ' ' + statusText + ': ' + progress.toFixed(1) + '%</div>';
					
					// 只在进度变化≥1%时输出日志
					if (Math.abs(progress - this.lastLoggedProgress) >= 1) {
						console.log('缓存进度更新:', progress.toFixed(1) + '% (来源:' + progressSource + ')');
						this.lastLoggedProgress = progress;
					}
					
					// 停滞提示（只输出一次）
					if (this.stuckCheckCount === this.maxStuckCount) {
						console.log('⏸️ 缓存进度长时间未变化 (' + progress.toFixed(1) + '%)，可能原因：');
						console.log('  - 视频已暂停播放');
						console.log('  - 网络速度慢或连接中断');
						console.log('  - 浏览器缓存策略限制');
						console.log('  提示：继续播放视频可能会恢复缓存');
					}
				} else {
					indicator.innerHTML = '<div>⏳ 等待视频数据...</div>';
				}
				
				// 如果进度达到98%以上，检查是否完成
				if (progress >= 98) {
					this.checkCompletion();
				}
			}, 1000);
		},
		
		// 添加缓冲块
		addBuffer: function(buffer) {
			if (!this.isBuffering) return;
			
			// 更新最后缓冲时间
			this.lastBufferTime = Date.now();
			
			// 累计缓冲大小
			if (buffer && buffer.byteLength) {
				this.totalBufferSize += buffer.byteLength;
				
				// 输出调试信息到控制台
				if (this.videoSize > 0) {
					const percent = ((this.totalBufferSize / this.videoSize) * 100).toFixed(1);
					console.log('视频缓存进度: ' + percent + '% (' + (this.totalBufferSize / (1024 * 1024)).toFixed(2) + 'MB/' + (this.videoSize / (1024 * 1024)).toFixed(2) + 'MB)');
				}
			}
			
			// 检查是否接近完成
			this.checkCompletion();
		},
		
		// 检查Video.js播放器和原生视频的缓冲状态
		checkBufferStatus: function() {
			if (!this.isBuffering) return;
			
			// 优先检查Video.js播放器
			const vjsPlayer = document.querySelector('.video-js');
			let video = null;
			
			if (vjsPlayer) {
				// 从Video.js播放器中获取video元素
				video = vjsPlayer.querySelector('video');
				
				// 检查Video.js播放器特有的状态（只在状态变化时输出日志）
				if (vjsPlayer.classList.contains('vjs-has-started')) {
					if (!this._vjsStartedLogged) {
						console.log('Video.js播放器已开始播放');
						this._vjsStartedLogged = true;
					}
				}
				
				if (vjsPlayer.classList.contains('vjs-waiting')) {
					if (!this._vjsWaitingLogged) {
						console.log('Video.js播放器正在等待数据');
						this._vjsWaitingLogged = true;
					}
				} else {
					this._vjsWaitingLogged = false; // 重置标记，以便下次等待时再次输出
				}
				
				if (vjsPlayer.classList.contains('vjs-ended')) {
					console.log('Video.js播放器播放结束，标记为缓存完成');
					this.checkCompletion(true);
					return;
				}
			} else {
				// 回退到查找普通video元素
				const videoElements = document.querySelectorAll('video');
				if (videoElements.length > 0) {
					video = videoElements[0];
				}
			}
			
			if (video) {
				if (video.buffered && video.buffered.length > 0 && video.duration) {
					// 获取最后缓冲时间范围的结束位置
					const bufferedEnd = video.buffered.end(video.buffered.length - 1);
					// 计算缓冲百分比
					const bufferedPercent = (bufferedEnd / video.duration) * 100;
					
					// 如果预加载接近完成，触发完成检测（只输出一次日志）
					if (bufferedPercent >= 95 && !this._preloadNearCompleteLogged) {
						console.log('检测到视频预加载接近完成 (' + bufferedPercent.toFixed(1) + '%)');
						this._preloadNearCompleteLogged = true;
						this.checkCompletion(true);
					}
				}
				
				// 只在readyState为4且缓冲百分比较高时才认为完成
				if (video.readyState >= 4 && video.buffered && video.buffered.length > 0 && video.duration) {
					const bufferedEnd = video.buffered.end(video.buffered.length - 1);
					const bufferedPercent = (bufferedEnd / video.duration) * 100;
					if (bufferedPercent >= 98 && !this._readyStateCompleteLogged) {
						console.log('视频readyState为4且缓冲98%以上，标记为缓存完成');
						this._readyStateCompleteLogged = true;
						this.checkCompletion(true);
					}
				}
			}
			
			// 如果超过10秒没有新的缓冲数据且已经缓冲了部分数据，可能表示视频已暂停或缓冲完成
			const timeSinceLastBuffer = Date.now() - this.lastBufferTime;
			if (timeSinceLastBuffer > 10000 && this.totalBufferSize > 0) {
				this.checkCompletion(true);
			}
		},
		
		// 检查是否完成
		checkCompletion: function(forcedCheck) {
			if (!this.isBuffering) return;
			
			let isComplete = false;
			
			// 优先检查Video.js播放器是否已播放完成
			const vjsPlayer = document.querySelector('.video-js');
			let video = null;
			
			if (vjsPlayer) {
				video = vjsPlayer.querySelector('video');
				
				// 检查Video.js播放器的完成状态
				if (vjsPlayer.classList.contains('vjs-ended')) {
					console.log('Video.js播放器已播放完毕，认为缓存完成');
					isComplete = true;
				}
			} else {
				// 回退到查找普通video元素
				const videoElements = document.querySelectorAll('video');
				if (videoElements.length > 0) {
					video = videoElements[0];
				}
			}
			
			if (video && !isComplete) {
				// 如果视频已经播放完毕或接近结束，直接认为完成
				if (video.ended || (video.duration && video.currentTime > 0 && video.duration - video.currentTime < 2)) {
					console.log('视频已播放完毕或接近结束，认为缓存完成');
					isComplete = true;
				}
				
				// 只在readyState为4且缓冲百分比较高时才认为完成
				if (video.readyState >= 4 && video.buffered && video.buffered.length > 0 && video.duration) {
					const bufferedEnd = video.buffered.end(video.buffered.length - 1);
					const bufferedPercent = (bufferedEnd / video.duration) * 100;
					if (bufferedPercent >= 98) {
						console.log('视频readyState为4且缓冲98%以上，认为缓存完成');
						isComplete = true;
					}
				}
			}
			
			// 如果未通过播放状态判断完成，再检查缓冲大小
			if (!isComplete) {
				// 如果知道视频大小，则根据百分比判断
				if (this.videoSize > 0) {
					const ratio = this.totalBufferSize / this.videoSize;
					// 对短视频降低阈值要求
					const threshold = this.videoSize < 5 * 1024 * 1024 ? 0.9 : this.completeThreshold; // 5MB以下视频降低阈值到90%
					isComplete = ratio >= threshold;
				} 
				// 强制检查：如果长时间没有新数据且视频元素可以播放到最后，也认为已完成
				else if (forcedCheck && video) {
					if (video.readyState >= 3 && video.buffered.length > 0) {
						const bufferedEnd = video.buffered.end(video.buffered.length - 1);
						const duration = video.duration;
						isComplete = duration > 0 && (bufferedEnd / duration) >= 0.95; // 降低阈值到95%
						
						if (isComplete) {
							console.log('强制检查：根据缓冲数据判断视频缓存完成');
						}
					}
				}
			}
			
			// 如果完成，显示通知
			if (isComplete) {
				this.showNotification();
				this.stopMonitoring();
			}
		},
		
		// 显示通知
		showNotification: function() {
			// 防止重复显示通知
			if (this.notificationShown) {
				console.log('通知已经显示过，跳过重复显示');
				return;
			}
			
			console.log('显示缓存完成通知');
			this.notificationShown = true;
			
			// 移除进度指示器
			const indicator = document.getElementById('video-cache-indicator');
			if (indicator) {
				indicator.remove();
			}
			
			// 创建桌面通知
			if ("Notification" in window && Notification.permission === "granted") {
				new Notification("视频缓存完成", {
					body: "视频已缓存完成，可以进行下载操作",
					icon: window.__wx_channels_store__?.profile?.coverUrl
				});
			}
			
			// 在页面上显示通知
			const notification = document.createElement('div');
			notification.style.cssText = "position:fixed;bottom:20px;right:20px;background-color:rgba(0,128,0,0.9);color:white;padding:15px 25px;border-radius:8px;z-index:99999;animation:fadeInOut 12s forwards;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-size:16px;font-weight:bold;";
			notification.innerHTML = '<div style="display:flex;align-items:center;"><span style="font-size:24px;margin-right:12px;">🎉</span> <span>视频缓存完成，可以下载了！</span></div>';
			
			// 添加动画样式 - 延长显示时间到12秒
			const style = document.createElement('style');
			style.textContent = '@keyframes fadeInOut {0% {opacity:0;transform:translateY(20px);} 8% {opacity:1;transform:translateY(0);} 85% {opacity:1;} 100% {opacity:0;}}';
			document.head.appendChild(style);
			
			document.body.appendChild(notification);
			
			// 12秒后移除通知
			setTimeout(() => {
				notification.remove();
			}, 12000);
			
			// 发送通知事件
			fetch("/__wx_channels_api/tip", {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					msg: "视频缓存完成，可以下载了！"
				})
			});
			
			console.log("视频缓存完成通知已显示");
		},
		
		// 停止监控
		stopMonitoring: function() {
			console.log('停止视频缓存监控');
			if (this.checkInterval) {
				clearInterval(this.checkInterval);
				this.checkInterval = null;
			}
			this.isBuffering = false;
			// 注意：不重置notificationShown，保持通知状态直到下次startMonitoring
		}
	};
	
	// 请求通知权限
	if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
		// 用户操作后再请求权限
		document.addEventListener('click', function requestPermission() {
			Notification.requestPermission();
			document.removeEventListener('click', requestPermission);
		}, {once: true});
	}
	</script>`
}

// handleIndexPublish 处理index.publish JS文件
func (h *ScriptHandler) handleIndexPublish(path string, content string) (string, bool) {
	if !util.Includes(path, "/t/wx_fed/finder/web/web-finder/res/js/index.publish") {
		return content, false
	}

	utils.LogFileInfo("[Home数据采集] 正在处理 index.publish 文件")

	regexp1 := regexp.MustCompile(`this.sourceBuffer.appendBuffer\(h\),`)
	replaceStr1 := `(() => {
if (window.__wx_channels_store__) {
window.__wx_channels_store__.buffers.push(h);
// 添加缓存监控
if (window.__wx_channels_video_cache_monitor) {
    window.__wx_channels_video_cache_monitor.addBuffer(h);
}
}
})(),this.sourceBuffer.appendBuffer(h),`
	if regexp1.MatchString(content) {
		utils.LogFileInfo("视频播放已成功加载！")
		utils.LogFileInfo("视频缓冲将被监控，完成时会有提醒")
		utils.LogFileInfo("[视频播放] 视频播放器已加载 | Path=%s", path)
	}
	content = regexp1.ReplaceAllString(content, replaceStr1)
	regexp2 := regexp.MustCompile(`if\(f.cmd===re.MAIN_THREAD_CMD.AUTO_CUT`)
	replaceStr2 := `if(f.cmd==="CUT"){
	if (window.__wx_channels_store__) {
	// console.log("CUT", f, __wx_channels_store__.profile.key);
	window.__wx_channels_store__.keys[__wx_channels_store__.profile.key]=f.decryptor_array;
	}
}
if(f.cmd===re.MAIN_THREAD_CMD.AUTO_CUT`
	content = regexp2.ReplaceAllString(content, replaceStr2)

	return content, true
}

// handleVirtualSvgIcons 处理virtual_svg-icons-register JS文件
func (h *ScriptHandler) handleVirtualSvgIcons(path string, content string) (string, bool) {
	if !util.Includes(path, "/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register") {
		return content, false
	}

	// 2026-03-13: 首页改版后，finderPcFlow/finderStream/finderGetRecommend 所在链路
	// 对首屏当前标签的初始化更敏感。这里暂时停用首页流相关的源码重写，
	// 先保证 Home 页面刷新和首屏加载稳定，保留 feed/profile/search 等稳定链路。
	if strings.Contains(content, "finderPcFlow(") {
		utils.LogFileInfo("[API拦截] ⏭️ 跳过 finderPcFlow 重写，避免干扰新版 Home 首屏初始化")
	}
	if strings.Contains(content, "finderStream(") {
		utils.LogFileInfo("[API拦截] ⏭️ 跳过 finderStream 重写，避免干扰新版 Home 首屏初始化")
	}

	// 拦截 finderGetCommentDetail - 视频详情（参考 wx_channels_download 项目）
	feedProfileRegex := regexp.MustCompile(`(?s)async\s+finderGetCommentDetail\s*\(([^)]+)\)\s*\{(.*?)\}\s*async`)
	if feedProfileRegex.MatchString(content) {
		utils.LogFileInfo("[API拦截] ✅ 在virtual_svg-icons-register中成功拦截 finderGetCommentDetail 函数")
		feedProfileReplace := `async finderGetCommentDetail($1){var result=await(async()=>{$2})();var feed=result.data.object;console.log("[API拦截] finderGetCommentDetail 触发 FeedProfileLoaded");WXU.emit(WXU.Events.FeedProfileLoaded,feed);return result;}async`
		content = feedProfileRegex.ReplaceAllString(content, feedProfileReplace)
	}

	// 拦截 Profile 页面的视频列表数据 - 使用事件系统（参考 wx_channels_download 项目）
	profileListRegex := regexp.MustCompile(`(?s)async\s+finderUserPage\s*\(([^)]+)\)\s*\{return(.*?)\}\s*async`)
	if profileListRegex.MatchString(content) {
		utils.LogFileInfo("[API拦截] ✅ 在virtual_svg-icons-register中成功拦截 finderUserPage 函数")
		profileListReplace := `async finderUserPage($1){console.log("[Profile API] finderUserPage 调用参数:",$1);var result=await(async()=>{return$2})();console.log("[Profile API] finderUserPage 原始结果:",result);if(result&&result.data&&result.data.object){var feeds=result.data.object;console.log("[Profile API] 提取到",feeds.length,"个视频");WXU.emit(WXU.Events.UserFeedsLoaded,feeds);}else{console.warn("[Profile API] result.data.object 为空",result);}return result;}async`
		content = profileListRegex.ReplaceAllString(content, profileListReplace)
	}

	// 拦截 Profile 页面的直播回放列表数据 - 使用事件系统
	liveListRegex := regexp.MustCompile(`(?s)async\s+finderLiveUserPage\s*\(([^)]+)\)\s*\{return(.*?)\}\s*async`)
	if liveListRegex.MatchString(content) {
		utils.LogFileInfo("[API拦截] ✅ 在virtual_svg-icons-register中成功拦截 finderLiveUserPage 函数")
		liveListReplace := `async finderLiveUserPage($1){console.log("[Profile API] finderLiveUserPage 调用参数:",$1);var result=await(async()=>{return$2})();console.log("[Profile API] finderLiveUserPage 原始结果:",result);if(result&&result.data&&result.data.object){var feeds=result.data.object;console.log("[Profile API] 提取到",feeds.length,"个直播回放");WXU.emit(WXU.Events.UserLiveReplayLoaded,feeds);}else{console.warn("[Profile API] result.data.object 为空",result);}return result;}async`
		content = liveListRegex.ReplaceAllString(content, liveListReplace)
	}

	if strings.Contains(content, "finderGetRecommend(") {
		utils.LogFileInfo("[API拦截] ⏭️ 跳过 finderGetRecommend 重写，避免干扰新版 Home 首屏初始化")
	}

	// 拦截搜索API - finderPCSearch（PC端搜索）
	// 函数格式: async finderPCSearch(n){...return(...),t}async
	// 在最后的 return 之前插入代码，然后保持 ,t}async 不变
	searchPCRegex := regexp.MustCompile(`(async finderPCSearch\([^)]+\)\{.*?)(,t\}async)`)

	if searchPCRegex.MatchString(content) {
		utils.LogFileInfo("[API拦截] ✅ 在virtual_svg-icons-register中成功拦截 finderPCSearch 函数")
		// 在 ,t 之前插入代码，保持 ,t}async 完整
		// 从 acctList 中提取正在直播的账号，添加调试日志
		searchPCReplace := `$1,t&&t.data&&(function(){var lives=t.data.liveObjectList||[];var accounts=[];var liveCount=0;if(t.data.acctList){t.data.acctList.forEach(function(info){if(info.liveStatus===1){liveCount++;console.log("[搜索API] 发现直播账号:",info.contact?info.contact.nickname:"未知",info.liveStatus,info.liveInfo);}if(info.liveStatus===1&&info.liveInfo){lives.push({id:info.contact.username,objectId:info.contact.username,nickname:info.contact.nickname,username:info.contact.username,description:info.liveInfo.description||"",streamUrl:info.liveInfo.streamUrl,coverUrl:info.liveInfo.media&&info.liveInfo.media[0]?info.liveInfo.media[0].thumbUrl:"",thumbUrl:info.liveInfo.media&&info.liveInfo.media[0]?info.liveInfo.media[0].thumbUrl:"",liveInfo:info.liveInfo,type:"live"});}accounts.push(info);});}if(liveCount>0){console.log("[搜索API] 共发现",liveCount,"个直播账号，成功提取",lives.length,"个");}var searchData={feeds:t.data.objectList||[],accounts:accounts,lives:lives};WXU.emit("SearchResultLoaded",searchData);})()$2`
		content = searchPCRegex.ReplaceAllString(content, searchPCReplace)
	} else {
		utils.LogFileInfo("[API拦截] ❌ 在virtual_svg-icons-register中未找到 finderPCSearch 函数")
	}

	// 拦截搜索API - finderSearch（移动端搜索）
	// 使用非贪婪匹配，匹配到最后的 ,t}async 模式
	searchRegex := regexp.MustCompile(`(async finderSearch\([^)]+\)\{.*?)(,t\}async)`)

	if searchRegex.MatchString(content) {
		utils.LogFileInfo("[API拦截] ✅ 在virtual_svg-icons-register中成功拦截 finderSearch 函数")
		// 从 infoList 中提取正在直播的账号，添加调试日志
		searchReplace := `$1,t&&t.data&&(function(){var lives=[];var accounts=[];var liveCount=0;if(t.data.infoList){t.data.infoList.forEach(function(info){if(info.liveStatus===1){liveCount++;console.log("[搜索API] 发现直播账号:",info.contact?info.contact.nickname:"未知",info.liveStatus,info.liveInfo);}if(info.liveStatus===1&&info.liveInfo){lives.push({id:info.contact.username,objectId:info.contact.username,nickname:info.contact.nickname,username:info.contact.username,description:info.liveInfo.description||"",streamUrl:info.liveInfo.streamUrl,coverUrl:info.liveInfo.media&&info.liveInfo.media[0]?info.liveInfo.media[0].thumbUrl:"",thumbUrl:info.liveInfo.media&&info.liveInfo.media[0]?info.liveInfo.media[0].thumbUrl:"",liveInfo:info.liveInfo,type:"live"});}accounts.push(info);});}if(liveCount>0){console.log("[搜索API] 共发现",liveCount,"个直播账号，成功提取",lives.length,"个");}var searchData={feeds:t.data.objectList||[],accounts:accounts,lives:lives};WXU.emit("SearchResultLoaded",searchData);})()$2`
		content = searchRegex.ReplaceAllString(content, searchReplace)
	} else {
		utils.LogFileInfo("[API拦截] ❌ 在virtual_svg-icons-register中未找到 finderSearch 函数")
	}

	// 拦截 export 语句，提取所有导出的 API 函数
	// 格式: export{xxx as yyy,zzz as www,...}
	exportBlockRegex := regexp.MustCompile(`export\s*\{([^}]+)\}`)
	exportRegex := regexp.MustCompile(`export\s*\{`)

	if exportBlockRegex.MatchString(content) {
		utils.LogFileInfo("[API拦截] ✅ 在virtual_svg-icons-register中找到 export 语句")

		// 提取 export 块中的内容
		matches := exportBlockRegex.FindStringSubmatch(content)
		if len(matches) >= 2 {
			exportContent := matches[1]
			utils.LogFileInfo("[API拦截] Export 内容: %s", exportContent[:min(100, len(exportContent))])

			// 解析导出的函数名
			items := strings.Split(exportContent, ",")
			var locals []string
			for _, item := range items {
				p := strings.TrimSpace(item)
				if p == "" {
					continue
				}
				// 处理 "xxx as yyy" 格式
				idx := strings.Index(p, " as ")
				local := p
				if idx != -1 {
					local = strings.TrimSpace(p[:idx])
				}
				if local != "" && local != " " {
					locals = append(locals, local)
				}
			}

			if len(locals) > 0 {
				utils.LogFileInfo("[API拦截] 提取到 %d 个导出函数", len(locals))
				apiMethods := "{" + strings.Join(locals, ",") + "}"
				// 转义 $ 符号
				apiMethodsEscaped := strings.ReplaceAll(apiMethods, "$", "$$")

				// 在 export 之前插入 API 加载事件
				jsWXAPI := ";WXU.emit(WXU.Events.APILoaded," + apiMethodsEscaped + ");export{"
				content = exportRegex.ReplaceAllString(content, jsWXAPI)
				utils.LogFileInfo("[API拦截] ✅ 已注入 APILoaded 事件")
			}
		}
	} else {
		utils.LogFileInfo("[API拦截] ❌ 在virtual_svg-icons-register中未找到 export 语句")
	}

	return content, true
}

// min 返回两个整数中的较小值
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// handleWorkerRelease 处理worker_release JS文件
func (h *ScriptHandler) handleWorkerRelease(path string, content string) (string, bool) {
	if !util.Includes(path, "worker_release") {
		return content, false
	}

	regex := regexp.MustCompile(`fmp4Index:p.fmp4Index`)
	replaceStr := `decryptor_array:p.decryptor_array,fmp4Index:p.fmp4Index`
	content = regex.ReplaceAllString(content, replaceStr)
	return content, true
}

// handleConnectPublish 处理connect.publish JS文件（参考 wx_channels_download 项目的实现）
func (h *ScriptHandler) handleConnectPublish(Conn *SunnyNet.HttpConn, path string, content string) (string, bool) {
	if !util.Includes(path, "connect.publish") {
		return content, false
	}

	utils.LogFileInfo("[Home数据采集] ✅ 正在处理 connect.publish 文件")
	utils.LogFileInfo("[Home数据采集] ⏭️ 跳过 goToNextFlowFeed/goToPrevFlowFeed 重写，避免干扰新版 Home 状态机")

	// 禁用浏览器缓存，确保每次都能拦截到最新的代码
	Conn.Response.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	Conn.Response.Header.Set("Pragma", "no-cache")
	Conn.Response.Header.Set("Expires", "0")

	Conn.Response.Body = io.NopCloser(bytes.NewBuffer([]byte(content)))
	return content, true
}

// getCommentCaptureScript 获取评论采集脚本 (优化版 - 基于 Pinia 订阅)
func (h *ScriptHandler) getCommentCaptureScript() string {
	return `<script>
(function() {
	'use strict';
	
	console.log('[评论采集] 初始化新版采集系统 (Pinia Store订阅模式 v3)...');
	
	// 状态变量
	var autoScrollTimer = null;
	var lastCommentCount = 0;
	var noChangeCount = 0;
	var isCollecting = false;
	var currentFeedId = '';
	var saveDebounceTimer = null;
	var stableDataCount = 0;
	var lastProgressText = '';
	
	// 工具函数：查找 Vue/Pinia Store
	function findFeedStore() {
		try {
			var app = document.querySelector('[data-v-app]') || document.getElementById('app');
			if (!app) return null;
			
			var vue = app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component);
			if (!vue) return null;
			
			var appContext = vue.appContext || (vue.ctx && vue.ctx.appContext);
			if (!appContext || !appContext.config || !appContext.config.globalProperties) return null;
			
			var pinia = appContext.config.globalProperties.$pinia;
			if (!pinia) return null;
			
			// 尝试从不同路径获取 feed store
			if (pinia._s && pinia._s.feed) return pinia._s.feed;
			if (pinia.state && pinia.state._value && pinia.state._value.feed) return pinia.state._value.feed;
			if (pinia._s && typeof pinia._s.forEach === 'function') {
				var matchedStore = null;
				pinia._s.forEach(function(candidate) {
					if (matchedStore) return;
					try {
						var state = (candidate && candidate.$state) || candidate;
						if (!state || typeof state !== 'object') return;
						if (state.commentList || state.comments || state.replyList || state.commentData) {
							matchedStore = candidate;
						}
					} catch (_) {}
				});
				if (matchedStore) return matchedStore;
			}
			
			return null;
		} catch (e) {
			console.error('[评论采集] 查找Store失败:', e);
			return null;
		}
	}

	function isCommentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (!('content' in item) && !('text' in item) && !('commentId' in item) && !('id' in item)) return false;
		return !!(
			item.author ||
			item.nickname ||
			item.userInfo ||
			item.commentId ||
			item.levelTwoComment ||
			item.replyList ||
			item.replyCommentList ||
			item.subCommentList ||
			item.children
		);
	}

	function getReplyList(item) {
		if (!item || typeof item !== 'object') return [];
		var replyKeys = ['levelTwoComment', 'replyList', 'replyCommentList', 'subCommentList', 'children', 'subComments', 'replies'];
		for (var i = 0; i < replyKeys.length; i++) {
			var value = item[replyKeys[i]];
			if (Array.isArray(value)) return value;
			if (value && Array.isArray(value.items)) return value.items;
			if (value && value.dataList && Array.isArray(value.dataList.items)) return value.dataList.items;
		}
		return [];
	}

	function parseCommentTotalFromDOM() {
		var selectors = [
			'.comment-drawer [class*="header"]',
			'.comment-panel [class*="header"]',
			'.comment-list [class*="header"]',
			'[class*="drawer"] [class*="header"]',
			'.drawer-header',
			'.comment-header'
		];
		var best = 0;

		for (var i = 0; i < selectors.length; i++) {
			var nodes = document.querySelectorAll(selectors[i]);
			for (var j = 0; j < nodes.length; j++) {
				var node = nodes[j];
				if (!node || node.offsetParent === null) continue;
				var text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
				if (!text || text.length > 60) continue;
				var match = text.match(/评论[^\d]{0,8}(\d+)/);
				if (match) {
					var value = parseInt(match[1], 10) || 0;
					if (value > best) best = value;
				}
			}
		}

		if (best > 0) return best;

		var bodyText = document.body ? (document.body.innerText || '') : '';
		var allMatches = bodyText.match(/评论[^\d]{0,8}(\d+)/g) || [];
		for (var k = 0; k < allMatches.length; k++) {
			var parsed = parseInt((allMatches[k].match(/(\d+)/) || [])[1], 10) || 0;
			if (parsed > best) best = parsed;
		}
		return best;
	}

	function getCommentTextFromNode(node) {
		if (!node) return '';
		var clone = node.cloneNode(true);
		var extraNodes = clone.querySelectorAll('.comment-row.actions, .comment-item__extra, .context-menu-wrp, .hover-show');
		for (var i = 0; i < extraNodes.length; i++) {
			extraNodes[i].remove();
		}
		return (clone.textContent || '').replace(/\s+/g, ' ').trim();
	}

	function parseCommentNode(node) {
		if (!node) return null;
		var contentNode = node.querySelector('.comment-content');
		var userNode = node.querySelector('.comment-user-name');
		if (!contentNode || !userNode) return null;

		var regionNodes = node.querySelectorAll('.region-text');
		var likeNode = node.querySelector('.like-num');
		var avatarNode = node.querySelector('.comment-avatar');
		var authorLikedNode = node.querySelector('.author-liked');
		var replyNodes = node.querySelectorAll(':scope > .comment-item__extra > .comment-reply-list > .comment-item');
		var replies = [];
		for (var i = 0; i < replyNodes.length; i++) {
			var parsedReply = parseCommentNode(replyNodes[i]);
			if (parsedReply) replies.push(parsedReply);
		}

		return {
			id: node.getAttribute('data-comment-id') || node.getAttribute('comment-id') || '',
			content: getCommentTextFromNode(contentNode),
			createTime: regionNodes[1] ? regionNodes[1].textContent.trim() : '',
			likeCount: likeNode ? parseInt((likeNode.textContent || '').replace(/[^\d]/g, ''), 10) || 0 : 0,
			nickname: userNode.textContent.trim(),
			headUrl: avatarNode ? avatarNode.src || '' : '',
			ipLocation: regionNodes[0] ? regionNodes[0].textContent.trim() : '',
			authorLiked: !!authorLikedNode,
			levelTwoComment: replies,
			expandCommentCount: replies.length
		};
	}

	function extractCommentPayloadFromDOM() {
		var roots = document.querySelectorAll('.comment-item');
		if (!roots || !roots.length) return null;

		var topLevel = [];
		for (var i = 0; i < roots.length; i++) {
			var node = roots[i];
			if (node.closest('.comment-reply-list .comment-item')) continue;
			var parsed = parseCommentNode(node);
			if (parsed) topLevel.push(parsed);
		}

		if (!topLevel.length) return null;

		var loadingNode = document.querySelector('.loading-icon');
		return {
			container: document.querySelector('.comment-list, [class*="drawer"], [class*="comment"]') || document.body,
			items: topLevel,
			total: parseCommentTotalFromDOM(),
			buffer: loadingNode ? '__dom_loading__' : '',
			hasMore: !!loadingNode
		};
	}

	function findCommentState(root, depth, seen) {
		if (!root || typeof root !== 'object') return null;
		if (depth > 5) return null;
		if (!seen) seen = [];
		if (seen.indexOf(root) >= 0) return null;
		seen.push(root);

		var directCandidates = [
			root.commentList,
			root.comments,
			root.commentData,
			root.replyList,
			root.comment,
			root.feedComment,
			root.commentPanel
		];
		for (var i = 0; i < directCandidates.length; i++) {
			var candidate = directCandidates[i];
			if (!candidate || typeof candidate !== 'object') continue;
			var payload = extractCommentPayload(candidate, true);
			if (payload && payload.items.length) return payload;
		}

		var keys = Object.keys(root);
		for (var j = 0; j < keys.length; j++) {
			var key = keys[j];
			var value = root[key];
			if (!value || typeof value !== 'object') continue;
			var nestedPayload = extractCommentPayload(value, true);
			if (nestedPayload && nestedPayload.items.length) return nestedPayload;
			var deeper = findCommentState(value, depth + 1, seen);
			if (deeper && deeper.items.length) return deeper;
		}

		return null;
	}

	function extractCommentPayload(source, shallowOnly) {
		if (!source || typeof source !== 'object') return null;

		var listCandidates = [
			source.dataList,
			source.list,
			source.commentList,
			source.comments,
			source.replyList,
			source.commentData,
			source
		];

		for (var i = 0; i < listCandidates.length; i++) {
			var candidate = listCandidates[i];
			if (!candidate || typeof candidate !== 'object') continue;

			var arrays = [];
			if (Array.isArray(candidate)) arrays.push(candidate);
			if (Array.isArray(candidate.items)) arrays.push(candidate.items);
			if (candidate.dataList && Array.isArray(candidate.dataList.items)) arrays.push(candidate.dataList.items);
			if (candidate.list && Array.isArray(candidate.list.items)) arrays.push(candidate.list.items);
			if (candidate.comments && Array.isArray(candidate.comments)) arrays.push(candidate.comments);
			if (candidate.commentList && Array.isArray(candidate.commentList)) arrays.push(candidate.commentList);

			for (var j = 0; j < arrays.length; j++) {
				var items = arrays[j];
				if (!Array.isArray(items) || !items.length) continue;
				if (!isCommentItem(items[0])) continue;
				return {
					container: candidate,
					items: items,
					total: candidate.totalCount !== undefined ? candidate.totalCount :
						(candidate.total !== undefined ? candidate.total :
						(source.totalCount !== undefined ? source.totalCount :
						(source.total !== undefined ? source.total :
						(source.commentCount !== undefined ? source.commentCount : 0)))),
					buffer: candidate.lastBuffer ||
						(candidate.nextBuffer || '') ||
						(candidate.cursor || '') ||
						(candidate.buffers && (candidate.buffers.lastBuffer || candidate.buffers.nextBuffer)) ||
						(source.lastBuffer || source.nextBuffer || ''),
					hasMore: !!(
						candidate.lastBuffer ||
						candidate.nextBuffer ||
						candidate.cursor ||
						(candidate.buffers && (candidate.buffers.lastBuffer || candidate.buffers.nextBuffer)) ||
						source.lastBuffer ||
						source.nextBuffer
					)
				};
			}
		}

		if (shallowOnly) return null;
		var nested = findCommentState(source, 0, []);
		if (nested && nested.items && nested.items.length) return nested;
		return extractCommentPayloadFromDOM();
	}

	// 从所有 Pinia store 中查找 flowCommentList 的原始引用（保留所有字段）
	function findFlowCommentListInStores() {
		try {
			var app = document.querySelector('[data-v-app]') || document.getElementById('app');
			if (!app) return null;
			var vue = app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component);
			if (!vue) return null;
			var appContext = vue.appContext || (vue.ctx && vue.ctx.appContext);
			if (!appContext || !appContext.config || !appContext.config.globalProperties) return null;
			var pinia = appContext.config.globalProperties.$pinia;
			if (!pinia || !pinia._s) return null;

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

				if (flowCommentList && flowCommentList.dataList && flowCommentList.dataList.items && flowCommentList.dataList.items.length) {
					return { store: s, home: home, flowCommentList: flowCommentList };
				}

				// 也检查 store.$state
				var state = s.$state || s;
				if (state.home && state.home.flowCommentList && state.home.flowCommentList.dataList && state.home.flowCommentList.dataList.items && state.home.flowCommentList.dataList.items.length) {
					return { store: s, home: state.home, flowCommentList: state.home.flowCommentList };
				}

				result = iterator.next();
			}
		} catch (e) {
			console.warn('[评论采集] 遍历Pinia stores查找flowCommentList失败:', e);
		}
		return null;
	}

	// 直接从 Store flowCommentList 读取评论（保留所有原始字段）
	// 替代 extractCommentPayload，适用于 home.flowCommentList.dataList 结构
	function extractStoreComments(store) {
		var found = findFlowCommentListInStores();
		if (!found) return null;

		var fcl = found.flowCommentList;
		var dataList = fcl.dataList;
		if (!dataList || !Array.isArray(dataList.items) || !dataList.items.length) return null;

		var buffers = dataList.buffers || {};
		var lastBuffer = buffers.lastBuffer || buffers.nextBuffer || '';

		// 优先从 flowCommentList.commentCount 获取总数（备用）
		var total = fcl.commentCount || 0;
		// 其次从 store.feed 或 home.feed 获取
		if (!total) {
			var feed = found.home && found.home.feed;
			if (!feed && found.store) {
				feed = found.store.feed || (found.store.home && found.store.home.feed);
			}
			if (feed && feed.commentCount !== undefined) total = feed.commentCount;
		}

		// 计算当前已加载的评论总数（一级 + 二级）
		if (!window.__sph_lastTotalCount) window.__sph_lastTotalCount = 0;
		var currentTotalCount = 0;
		for (var i = 0; i < dataList.items.length; i++) {
			currentTotalCount++;
			if (dataList.items[i].levelTwoComment && Array.isArray(dataList.items[i].levelTwoComment)) {
				currentTotalCount += dataList.items[i].levelTwoComment.length;
			}
		}
		var prevTotal = window.__sph_lastTotalCount;
		var isGrowing = prevTotal > 0 && currentTotalCount > prevTotal;

		// 连续无增长计数器（用于防止网络波动导致误判）
		if (!window.__sph_noGrowthCount) window.__sph_noGrowthCount = 0;

		// hasMore 判断：只依赖增量判断和无增长兜底
		// 不使用 fcl.commentCount 作为 platformTotal（它可能是当前分页数而非总数，容易误判）
		var hasMore = true;
		if (currentTotalCount < prevTotal) {
			// 数量变小（视频切换等异常），重置追踪，继续等待加载
			hasMore = !!lastBuffer;
			window.__sph_noGrowthCount = 0;
		} else if (!isGrowing && prevTotal > 0 && currentTotalCount === prevTotal) {
			// 数量停止增长，累计计数器
			window.__sph_noGrowthCount++;
			// 连续15次无增长才判定为结束（给网络波动留有余地）
			if (window.__sph_noGrowthCount >= 15) {
				hasMore = false;
			}
		} else {
			// 有增量，重置计数器
			window.__sph_noGrowthCount = 0;
		}

		// 无论是否有更多，都更新追踪状态
		window.__sph_lastTotalCount = currentTotalCount;

		return {
			items: dataList.items,
			total: total,
			buffer: lastBuffer,
			hasMore: hasMore,
			store: found.store,
			home: found.home
		};
	}

	// 格式化评论数据：直接保留 Store 原始字段（新增字段如 authorReactionInfo, contentInfo, reportJson, username 等）
	function formatComments(items) {
		if (!items || !Array.isArray(items)) return [];

		function formatItem(item) {
			var levelTwo = [];
			var replyList = item.levelTwoComment;
			if (replyList && Array.isArray(replyList) && replyList.length) {
				levelTwo = replyList.map(formatItem);
			}

			// IP 属地优先使用 ipRegionInfo
			var ipLocation = '';
			if (item.ipRegionInfo && item.ipRegionInfo.regionText) {
				ipLocation = item.ipRegionInfo.regionText;
			}

			return {
				// 基础字段（兼容旧结构）
				id: item.commentId || item.id || '',
				content: item.content || item.text || '',
				createTime: item.createtime || item.createTime || item.create_time || item.time || '',
				likeCount: item.likeCount || item.like_num || item.diggCount || 0,
				nickname: item.nickname || (item.author && item.author.nickname) || (item.userInfo && item.userInfo.nickname) || '',
				headUrl: item.headUrl || (item.author && item.author.headUrl) || (item.userInfo && (item.userInfo.avatar || item.userInfo.headUrl)) || '',
				ipLocation: ipLocation,
				replyCommentId: item.replyCommentId || (item.replyComment && item.replyComment.id) || (item.replyInfo && item.replyInfo.commentId) || '',
				replyNickname: item.replyNickname || (item.replyComment && item.replyComment.nickname) || (item.replyInfo && item.replyInfo.nickname) || '',
				levelTwoComment: levelTwo,
				expandCommentCount: item.expandCommentCount || item.replyCount || item.commentCount || (replyList && replyList.length) || 0,
				authorLiked: !!(item.authorLiked || (item.authorReactionInfo && item.authorReactionInfo.authorLikeTime)),

				// 完整保留 Store 原始字段（新增高价值字段）
				commentId: item.commentId || item.id || '',
				contentType: item.contentType,
				createtime: item.createtime || '',
				dislikeCount: item.dislikeCount || 0,
				displayFlag: item.displayFlag,
				extFlag: item.extFlag,
				continueFlag: item.continueFlag,
				upContinueFlag: item.upContinueFlag,
				likeFlag: item.likeFlag,

				// 用户信息（完整保留）
				username: item.username || (item.authorContact && item.authorContact.username) || '',
				authorContact: item.authorContact || null,

				// IP 信息
				ipRegionInfo: item.ipRegionInfo || null,

				// 内容详情（表情包、图片等）
				contentInfo: item.contentInfo || null,

				// 作者是否点赞该评论
				authorReactionInfo: item.authorReactionInfo || null,

				// 推荐系统数据
				reportJson: item.reportJson || '',
				searchKeywordInfo: item.searchKeywordInfo || [],
				interactionLabelList: item.interactionLabelList || [],
				mentionedUserInfo: item.mentionedUserInfo || [],

				// 二级回复引用内容（被回复的那条评论内容）
				replyContent: item.replyContent || '',

				// 分页标记
				lastBuffer: item.lastBuffer || ''
			};
		}

		return items.map(formatItem);
	}

	// 获取视频信息
	function getVideoInfo(store) {
		var info = { id: '', title: '' };
		var currentProfile = window.__wx_channels_store__ && window.__wx_channels_store__.profile;
		
		// 0. 优先使用当前已同步的视频 profile
		if (currentProfile) {
			info.id = currentProfile.id || currentProfile.objectId || '';
			info.title = currentProfile.title || currentProfile.description || currentProfile.desc || '';
		}
		
		// 1. 尝试从 store.feed 获取 (根据 Log Keys: [ "feed", ... ])
		if (!info.id && store && store.feed) {
			info.id = store.feed.id || store.feed.objectId || store.feed.exportId || '';
			info.title = store.feed.description || store.feed.desc || '';
		}
		
		// 2. 尝试从 store.currentFeed 获取
		if (!info.id && store && store.currentFeed) {
			info.id = store.currentFeed.id || store.currentFeed.objectId || '';
			info.title = store.currentFeed.description || store.currentFeed.desc || '';
		}
		
		// 3. 尝试从 store.profile 获取
		if (!info.id && store && store.profile) {
			info.id = store.profile.id || store.profile.objectId || '';
			info.title = store.profile.description || store.profile.desc || '';
		}
		
		// 4. 尝试从 URL 获取
		if (!info.id) {
			// 匹配 /feed/export/ID 或 /feed/ID
			var match = window.location.pathname.match(/\/feed\/([^/?]+)/);
			if (match) info.id = match[1];
		}

		if (!info.id) {
			var activeFeedNode = document.querySelector('[id^="flow-feed-"]');
			if (activeFeedNode && activeFeedNode.id) {
				info.id = activeFeedNode.id.replace(/^flow-feed-/, '');
			}
		}
		
		// 5. 尝试从 document title 获取
		if (!info.title) {
			var descNode = document.querySelector('.collapsed-text .ctn, .content .ctn, .compute-node');
			if (descNode) info.title = descNode.textContent.trim();
		}

		if (!info.title) {
			info.title = document.title || '';
		}

		if (info.title === '视频号') {
			info.title = '';
		}

		if (!info.title && currentProfile) {
			info.title = currentProfile.nickname || '';
		}
		
		return info;
	}

	// 保存评论数据到后端
	function saveComments(comments, totalExpected) {
		if (!comments || comments.length === 0) return;

		var videoInfo = { id: '', title: '' };

		// 先从 extractStoreComments 获取 store（包含 feed.contact）
		var storeData = findFlowCommentListInStores();
		var feed = null;
		if (storeData) {
			feed = storeData.home && storeData.home.feed;
			if (!feed) feed = storeData.store && (storeData.store.feed || (storeData.store.home && storeData.store.home.feed));
		}

		// 获取视频ID和标题
		var currentProfile = window.__wx_channels_store__ && window.__wx_channels_store__.profile;
		if (currentProfile) {
			videoInfo.id = currentProfile.id || currentProfile.objectId || '';
			videoInfo.title = currentProfile.title || currentProfile.description || currentProfile.desc || '';
		}
		if (!videoInfo.id && feed) {
			videoInfo.id = feed.id || feed.objectId || '';
		}
		if (!videoInfo.title && feed && feed.objectDesc) {
			videoInfo.title = feed.objectDesc.description || feed.objectDesc.desc || '';
		}
		if (!videoInfo.id) {
			var activeFeedNode = document.querySelector('[id^="flow-feed-"]');
			if (activeFeedNode && activeFeedNode.id) videoInfo.id = activeFeedNode.id.replace(/^flow-feed-/, '');
		}
		if (!videoInfo.title) videoInfo.title = document.title || '';
		if (videoInfo.title === '视频号') videoInfo.title = '';

		// 如果 ID 变了，说明切换了视频，重置计数
		if (videoInfo.id && currentFeedId && videoInfo.id !== currentFeedId) {
			console.log('[评论采集] 检测到视频切换: ' + currentFeedId + ' -> ' + videoInfo.id);
			lastCommentCount = 0;
		}
		currentFeedId = videoInfo.id;

		// 从 feed.contact 提取作者信息
		var authorNickname = '';
		var authorUsername = '';
		var authorHeadUrl = '';
		var authorSignature = '';
		var authorId = videoInfo.id;

		if (feed) {
			var contact = feed.contact || {};
			authorNickname = contact.nickname || '';
			authorUsername = contact.username || '';
			authorHeadUrl = contact.headUrl || '';
			authorSignature = contact.signature || '';
		}

		console.log('[评论采集] 发送数据: ' + comments.length + ' 条评论 (期望总数: ' + totalExpected + ') | ID: ' + videoInfo.id + ' | 作者: ' + authorNickname);

		// TODO: 暂时禁用保存到文件，仅保留日志输出
		// fetch('/__wx_channels_api/save_comment_data', {
		// 	method: 'POST',
		// 	headers: {'Content-Type': 'application/json'},
		// 	body: JSON.stringify({
		// 		comments: comments,
		// 		videoId: videoInfo.id,
		// 		videoTitle: videoInfo.title,
		// 		originalCommentCount: totalExpected || 0,
		// 		timestamp: Date.now(),
		// 		isFullUpdate: true,
		// 		authorId: authorId,
		// 		authorNickname: authorNickname,
		// 		authorUsername: authorUsername,
		// 		authorHeadUrl: authorHeadUrl,
		// 		authorSignature: authorSignature,
		// 		profileUrl: authorUsername ? 'https://channels.weixin.qq.com/profile/' + authorUsername.replace(/@finder$/, '').replace(/@stranger$/, '') : ''
		// 	})
		// }).catch(function(err) {
		// 	console.error('[评论采集] 保存失败:', err);
		// });
	}

	// 触发保存（带防抖）
	function triggerSave(comments, totalCount) {
		if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
		
		// 检查是否"完成"
		var isComplete = totalCount > 0 && comments.length >= totalCount;
		
		// 如果已完成，快速保存
		// 如果未完成，等待较长时间以合并更新，减少文件生成
		var delay = isComplete ? 1000 : 5000;
		
		saveDebounceTimer = setTimeout(function() {
			saveComments(comments, totalCount);
		}, delay);
	}

	function updateProgressHint(loaded, total, phase) {
		var text = '评论采集中: ' + loaded + (total > 0 ? '/' + total : '') + (phase ? ' | ' + phase : '');
		if (text === lastProgressText) return;
		lastProgressText = text;
		if (typeof __wx_log === 'function') {
			__wx_log({ msg: '💬 ' + text });
		}
	}

	// 尝试调用 Store 的加载更多方法 (增强版: 遍历所有Store查找)
	function tryTriggerStoreLoadMore(store) {
		// 常见的加载更多方法名
		var candidates = ['loadMoreComment', 'loadMoreComments', 'fetchComment', 'fetchComments', 'getCommentHere', 'getCommentList', 'nextPage', 'loadMore', 'fetchMore', 'loadNext', 'loadNextPage', 'loadMoreData'];
		
		// 1. 如果传入的 explicit store 有效，先尝试它
		if (store) {
			if (checkAndCall(store, candidates, 'CurrentStore')) return true;
		}

		// 2. 扫描 Pinia 所有 Stores
		try {
			var app = document.querySelector('[data-v-app]') || document.getElementById('app');
			if (app) {
				var vue = app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component);
				var pinia = vue && vue.appContext && vue.appContext.config && vue.appContext.config.globalProperties && vue.appContext.config.globalProperties.$pinia;
				
				if (pinia && pinia._s) {
					// 遍历 Map
					var stores = pinia._s;
					var iterator = stores.keys();
					var result = iterator.next();
					while (!result.done) {
						var id = result.value;
						var s = stores.get(id);
						// console.log('[评论采集] 扫描Store: ' + id);
						
						// 检查是否包含 comment 相关数据，如果是，大概率是目标 store
						if (s.commentList || s.comments || (s.$state && s.$state.commentList)) {
							// console.log('[评论采集] 发现疑似目标Store: ' + id);
							if (checkAndCall(s, candidates, 'Store(' + id + ')')) return true;
						}
						
						result = iterator.next();
					}
				}
			}
		} catch (e) {
			// console.error('[评论采集] 扫描Store失败:', e);
		}
		
		return false;
	}

	// 辅助函数: 检查并调用方法
	function checkAndCall(obj, methods, contextName) {
		// 1. 直接查方法
		for (var i = 0; i < methods.length; i++) {
			var name = methods[i];
			if (typeof obj[name] === 'function') {
				// console.log('[评论采集] 调用 ' + contextName + ' 方法: ' + name);
				try {
					obj[name]();
					return true;
				} catch (e) {
					// console.error('[评论采集] 调用失败:', e);
				}
			}
		}
		
		// 2. 查 Actions (Pinia)
		if (obj._a || obj.$actions) {
			var actions = obj._a || obj.$actions;
			for (var i = 0; i < methods.length; i++) {
				var name = methods[i];
				if (typeof actions[name] === 'function') {
					// console.log('[评论采集] 调用 ' + contextName + ' Action: ' + name);
					try {
						actions[name]();
						return true;
					} catch (e) {
						// console.error('[评论采集] 调用失败:', e);
					}
				}
			}
		}
		
		return false;
	}

	// 查找并滚动评论容器
	function scrollCommentList() {
		var preferredSelectors = [
			'.comment-list',
			'.comment-panel',
			'.comment-drawer',
			'[class*="comment-list"]',
			'[class*="comment-panel"]',
			'[class*="comment-drawer"]',
			'[class*="reply-list"]'
		];

		for (var p = 0; p < preferredSelectors.length; p++) {
			var preferredNodes = document.querySelectorAll(preferredSelectors[p]);
			for (var q = 0; q < preferredNodes.length; q++) {
				var preferred = preferredNodes[q];
				if (!preferred || preferred.offsetParent === null) continue;
				if (preferred.scrollHeight > preferred.clientHeight + 20) {
					preferred.scrollTop = preferred.scrollHeight;
					return true;
				}
			}
		}

		// 1. 尝试找到包含评论的滚动容器
		var walkers = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
			acceptNode: function(node) {
				// 忽略日志面板本身
				if (node.id === 'log-content' || node.classList.contains('log-window')) return NodeFilter.FILTER_SKIP;
				// 检查是否有滚动条
				var style = window.getComputedStyle(node);
				var isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
				return isScrollable ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
			}
		});

		var node;
		var scrollableContainers = [];
		while(node = walkers.nextNode()) {
			scrollableContainers.push(node);
		}
		
		// 倒序遍历（通常我们需要最内层的滚动容器，或者根据包含内容判断）
		var found = false;
		for (var i = scrollableContainers.length - 1; i >= 0; i--) {
			var container = scrollableContainers[i];
			// 简单的判断：容器高度大于一定值，且包含一些文本
			var text = container.innerText || '';
			var className = container.className || '';
			var looksLikeCommentPanel = className.indexOf('comment') >= 0 || className.indexOf('reply') >= 0 || text.indexOf('回复') >= 0;
			if (container.scrollHeight > 300 && text.length > 50 && looksLikeCommentPanel) {
				// 滚动它
				// console.log('[评论采集] 📜 滚动容器:', container.className || container.tagName);
				container.scrollTop = container.scrollHeight;
				return true;
			}
		}
		
		return found;
	}

	// 主逻辑：订阅 Store 变化
	function initObserver() {
		var storeData = findFlowCommentListInStores();
		if (!storeData) {
			setTimeout(initObserver, 1000);
			return;
		}

		window.__wx_feed_store = storeData.store;
		console.log('[评论采集] Store 连接成功!');

		// 优先使用直接读取，保留原始字段
		storeData.store.$subscribe(function(mutation, state) {
			var payload = extractStoreComments(storeData.store);
			if (!payload || !payload.items || !payload.items.length) {
				payload = extractCommentPayload(state, false) || extractCommentPayload(storeData.store, false);
			}
			if (payload && payload.items && payload.items.length) {
				var items = payload.items;
				var total = payload.total || 0;
				if (!total && storeData.home && storeData.home.feed && storeData.home.feed.commentCount !== undefined) {
					total = storeData.home.feed.commentCount;
				}

				var currentLoadedCount = getCommentStats(items).total;
				if (currentLoadedCount !== lastCommentCount) {
					var stats = getCommentStats(items);
					console.log('[评论采集] 评论更新: ' + stats.total + ' (总数: ' + total + ')');
					lastCommentCount = currentLoadedCount;
					noChangeCount = 0;
					updateProgressHint(stats.total, total, '已加载');
					var formatted = formatComments(items);
					triggerSave(formatted, total);
				} else {
					noChangeCount++;
				}
			}
		}, { detached: true });

		isCollecting = true;
		startAutoScroll();
	}

	// 增强版自动滚动
	function startAutoScroll() {
		if (autoScrollTimer) clearInterval(autoScrollTimer);
		
		autoScrollTimer = setInterval(function() {
			var store = window.__wx_feed_store;
			
			// 1. 优先尝试调用 Store 的加载方法
			var calledStore = tryTriggerStoreLoadMore(store);
			
			// 2. 查找并滚动所有可能的容器
			var scrollableFound = false;
			var containers = document.querySelectorAll('.comment-list, .recycle-list, [class*="comments"], [class*="container"]');
			
			for (var i = 0; i < containers.length; i++) {
				var el = containers[i];
				// 检查是否可滚动
				if (el.scrollHeight > el.clientHeight) {
					// 滚动到底部
					el.scrollTop = el.scrollHeight;
					scrollableFound = true;
				}
			}
			
			if (!scrollableFound) {
				window.scrollTo(0, document.body.scrollHeight);
			}
			
			// 3. 点击"更多"按钮
			var buttons = document.querySelectorAll('div, span, p, button');
			for (var i = 0; i < buttons.length; i++) {
				var btn = buttons[i];
				var text = btn.innerText || '';
				if (text.includes('查看更多') || text.includes('展开更多') || text === '更多评论') {
					// console.log('[评论采集] 点击 "更多" 按钮');
					btn.click();
					break;
				}
			}
			
		}, 1000); // 1秒一次
	}

	// 辅助函数：获取评论统计信息
	function getCommentStats(items) {
		var total = 0;
		var topLevel = 0;
		var replies = 0;
		var missingReplies = 0; // 未展开的二级回复数量
		
		if (!items || !Array.isArray(items)) {
			return { total: 0, topLevel: 0, replies: 0, missingReplies: 0 };
		}

		items.forEach(function(item) {
			topLevel++;
			total++;
			if (item.levelTwoComment && Array.isArray(item.levelTwoComment)) {
				replies += item.levelTwoComment.length;
				total += item.levelTwoComment.length;
			}
			// 如果有 expandCommentCount 但 levelTwoComment 数量不匹配，说明有未展开的
			if (item.expandCommentCount > 0 && (!item.levelTwoComment || item.levelTwoComment.length < item.expandCommentCount)) {
				missingReplies += (item.expandCommentCount - (item.levelTwoComment ? item.levelTwoComment.length : 0));
			}
		});
		return { total: total, topLevel: topLevel, replies: replies, missingReplies: missingReplies };
	}




	// 校验二级评论展开情况
	function verifyCommentAllExpanded(items) {
		console.log('=== 二级评论展开校验报告 ===');
		var totalWithReplies = 0;
		var notFullyExpanded = 0;
		var totalExpected = 0;
		var totalActual = 0;

		items.forEach(function(item) {
			// 修正: 原始数据的字段通常是 expandCommentCount 或 replyCount
			var expected = item.expandCommentCount || item.replyCount || item.commentCount || 0;
			
			if (expected > 0) { // 预期有回复
				totalWithReplies++;
				totalExpected += expected;
				
				var actualReplies = 0;
				if (item.levelTwoComment && item.levelTwoComment.length > 0) {
					actualReplies = item.levelTwoComment.length;
				}
				totalActual += actualReplies;

				// 允许少量误差
				if (expected > actualReplies) { 
					console.warn('❌ [未完全展开] 用户: ' + (item.nickname||'') + ' | 预期: ' + expected + ' | 实际: ' + actualReplies + ' | 内容: ' + (item.content||'').substring(0, 30) + '...');
					notFullyExpanded++;
				} else {
					console.log('✅ [已展开] 用户: ' + (item.nickname||'') + ' | 回复数: ' + actualReplies);
				}
			}
		});

		console.log('--------------------------------');
		console.log('总计发现含回复评论: ' + totalWithReplies);
		console.log('未完全展开数: ' + notFullyExpanded);
		if (totalExpected > 0) {
			console.log('回复总完成率: ' + totalActual + '/' + totalExpected + ' (' + ((totalActual/totalExpected)*100).toFixed(1) + '%)');
		}
		console.log('================================');
		
		return {
			missingReplies: notFullyExpanded,
			totalWithReplies: totalWithReplies
		};
	}

	// 尝试展开二级评论
	function expandSecondaryComments() {
		var count = 0;

		// 辅助点击函数
		var clickNode = function(node, actionName) {
			try {
				if (actionName) console.log('[评论采集] ' + actionName + ':', node.innerText.trim().substring(0, 30));
				node.scrollIntoView({block: 'center', inline: 'nearest'});
				var eventTypes = ['mouseover', 'mousedown', 'mouseup', 'click'];
				for (var k = 0; k < eventTypes.length; k++) {
					var event = new MouseEvent(eventTypes[k], { 'view': window, 'bubbles': true, 'cancelable': true });
					node.dispatchEvent(event);
				}
				return true;
			} catch(e) {
				console.error('[评论采集] 点击失败:', e);
				return false;
			}
		};

		// 策略1: 精确查找 .load-more__btn (最准确)
		// 结构: .comment-item__extra -> .comment-reply-list + .load-more -> .click-box.load-more__btn
		var preciseCandidates = document.querySelectorAll('.load-more__btn, .click-box, .comment-item__extra .load-more');
		for (var i = 0; i < preciseCandidates.length; i++) {
			var node = preciseCandidates[i];
			if (node.offsetParent === null) continue; // 不可见
			var text = node.innerText || '';
			
			// 检查是否已处理过且文字未变 (防止DOM复用导致的漏点)
			if (node.classList.contains('expanded-handled') && node.getAttribute('data-handled-text') === text) {
				continue;
			}

			if (text.includes('回复') || text.includes('展开') || text.includes('更多')) {
				clickNode(node, '🎯 精确点击');
				node.classList.add('expanded-handled');
				node.setAttribute('data-handled-text', text); // 记录处理时的文字
				count++;
			}
		}

		// 策略2: 文本模糊查找 (防止DOM结构变化)
		if (count === 0) {
			var candidates = document.querySelectorAll('div, span, p, a'); 
			for (var i = 0; i < candidates.length; i++) {
				var node = candidates[i];
				var text = node.innerText || '';
				
				// 避免匹配过多无关元素
				if (text.length > 50 || text.length < 2) continue;

				// 宽松匹配：包含 "展开"、"回复"、"更多"
				if (text.includes('展开') || text.includes('回复') || text.includes('更多')) {
					// 排除无效元素
					if (node.offsetParent === null) continue;
					
					// 检查是否已处理过且文字未变
					if (node.classList.contains('expanded-handled') && node.getAttribute('data-handled-text') === text) {
						continue;
					}
					
					if (node.closest('#__wx_channels_log_panel')) continue; // 排除日志面板
					// if (node.closest('.load-more__btn')) continue; // REMOVED: 让策略2覆盖漏网之鱼

					// 尝试定位到最佳点击容器
					var clickTarget = node.closest('.click-box') || node.closest('.load-more') || node;
					
					clickNode(clickTarget, '🔍 模糊点击');
					
					node.classList.add('expanded-handled');
					node.setAttribute('data-handled-text', text);
					
					if (clickTarget !== node) {
						clickTarget.classList.add('expanded-handled');
						clickTarget.setAttribute('data-handled-text', text);
					}
					count++;
				}
			}
		}

		if (count > 0) {
			console.log('[评论采集] 本轮触发展开: ' + count + ' 个');
		}
		return count;
	}

	// 暴露辅助函数到全局，供 __sph_fetch_video_comments 调用（同一个 script 块内共享作用域）
	window.__sph_findFlowCommentListInStores = findFlowCommentListInStores;
	window.__sph_extractStoreComments = extractStoreComments;
	window.__sph_tryTriggerStoreLoadMore = tryTriggerStoreLoadMore;
	window.__sph_scrollCommentList = scrollCommentList;
	window.__sph_expandSecondaryComments = expandSecondaryComments;
	window.__sph_formatComments = formatComments;

	// 暴露手动启动函数 (供按钮调用)
	window.__wx_channels_start_comment_collection = function() {
		console.log('[评论采集] 初始化采集...');
		lastProgressText = '';

		// 直接从所有 Pinia store 查找 flowCommentList（优先走这条路）
		var storeData = findFlowCommentListInStores();
		var payload = storeData ? extractStoreComments(storeData.store) : null;
		var storeForLoadMore = storeData ? storeData.store : findFeedStore();

		// 如果直接读取失败，降级到旧的 extractCommentPayload
		if (!payload || !payload.items || !payload.items.length) {
			var domPayload = extractCommentPayloadFromDOM();
			var storePayload = storeForLoadMore ? extractCommentPayload(storeForLoadMore, false) : null;
			payload = domPayload || storePayload;

			if (!payload || !payload.items || !payload.items.length) {
				// 等待评论区初始化
				var waitCount = 0;
				var waitTimer = setInterval(function() {
					waitCount++;
					var sd = findFlowCommentListInStores();
					var p = sd ? extractStoreComments(sd.store) : null;
					if (!p || !p.items || !p.items.length) {
						var s = findFeedStore();
						var dp = extractCommentPayloadFromDOM();
						var sp = s ? extractCommentPayload(s, false) : null;
						p = dp || sp;
					}
					if (p && p.items && p.items.length) {
						clearInterval(waitTimer);
						window.__wx_channels_start_comment_collection();
						return;
					}
					if (waitCount >= 20) {
						clearInterval(waitTimer);
						// alert('未检测到评论数据，请先打开评论区后重试');
					}
				}, 300);
				return;
			} else {
				console.log('[评论采集] 使用降级模式获取评论数据');
			}
		}

		// 强制触发一次加载更多
		if (storeForLoadMore) {
			tryTriggerStoreLoadMore(storeForLoadMore);
		}

		if (payload && payload.items && payload.items.length) {
			var items = payload.items;

			// 优先从 flowCommentList.commentCount 获取总数
			var total = payload.total || 0;
			// 其次从 store.feed 获取
			if (!total && storeData) {
				var feed = (storeData.home && storeData.home.feed) || (storeData.store && (storeData.store.feed || (storeData.store.home && storeData.store.home.feed)));
				if (feed && feed.commentCount !== undefined) total = feed.commentCount;
			}

			var stats = getCommentStats(items);
			var lastBuffer = payload.buffer || '';
			var hasMore = !!lastBuffer;

			console.log('[评论采集] 采集概况: 已加载' + stats.total + '/' + total + ' (一级:' + stats.topLevel + ', 二级:' + stats.replies + ') | hasMore:' + hasMore);
			updateProgressHint(stats.total, total, hasMore ? '准备继续加载' : '已全部加载');

			var formatted = formatComments(items);

			if (hasMore || stats.total < total) {
				updateProgressHint(stats.total, total, '开始自动采集');
				if (typeof __wx_log === 'function') {
					__wx_log({ msg: '💬 已发现 ' + stats.total + '/' + total + ' 条评论，开始自动继续采集...' });
				}
				var sameCountRetries = 0;
				// 4分钟超时强制终止采集
				var collectionStartTime = Date.now();
				var collectionTimeout = 4 * 60 * 1000; // 4分钟
				var loadLoop = setInterval(function() {
					// 检查4分钟超时
					if (Date.now() - collectionStartTime >= collectionTimeout) {
						console.log('[评论采集] ⏰ 4分钟超时，强制终止采集并保存当前数据');
						updateProgressHint(currentStats ? currentStats.total : 0, total, '4分钟超时，保存当前数据');
						clearInterval(loadLoop);
						// 获取当前已有数据并保存
						var currentSD = findFlowCommentListInStores();
						var currentPayload = currentSD ? extractStoreComments(currentSD.store) : null;
						var currentStore = currentSD ? currentSD.store : findFeedStore();
						if (!currentPayload || !currentPayload.items || !currentPayload.items.length) {
							var currentDomPayload = extractCommentPayloadFromDOM();
							var currentStorePayload = currentStore ? extractCommentPayload(currentStore, false) : null;
							currentPayload = currentDomPayload || currentStorePayload;
						}
						if (currentPayload && currentPayload.items && currentPayload.items.length) {
							var timeoutFormatted = formatComments(currentPayload.items);
							saveComments(timeoutFormatted, total);
							var timeoutMsg = '⚠️ 4分钟超时强制终止：已采集 ' + currentPayload.items.length + ' 条评论';
							if (typeof __wx_log === 'function') {
								__wx_log({ msg: timeoutMsg });
							}
							// 【P0 #1修复】触发 dumpAllPiniaStores() 回调，让 Node.js 能收到 done 信号
							if (typeof window.dumpAllPiniaStores === 'function') {
								window.dumpAllPiniaStores().then(function(path) {
									console.log('[评论采集] 超时快照已保存: ' + (path || '(空)'));
								});
							}
						} else {
							// 没有数据也要回调，避免 Node.js 一直等待
							if (typeof window.dumpAllPiniaStores === 'function') {
								window.dumpAllPiniaStores().then(function(path) {
									console.log('[评论采集] 超时快照已保存(无数据): ' + (path || '(空)'));
								});
							}
						}
						return;
					}

					// 优先从 flowCommentList 直接读取
					var currentSD = findFlowCommentListInStores();
					var currentPayload = currentSD ? extractStoreComments(currentSD.store) : null;
					var currentStore = currentSD ? currentSD.store : findFeedStore();

					// 降级到旧方式
					if (!currentPayload || !currentPayload.items || !currentPayload.items.length) {
						var currentDomPayload = extractCommentPayloadFromDOM();
						var currentStorePayload = currentStore ? extractCommentPayload(currentStore, false) : null;
						currentPayload = currentDomPayload || currentStorePayload;
					}

					if (!currentPayload || !currentPayload.items) {
						console.warn('[评论采集] 当前评论数据容器未找到，继续重试...');
						if (currentStore) tryTriggerStoreLoadMore(currentStore);
						scrollCommentList();
						return;
					}

					var currentStats = getCommentStats(currentPayload.items);

					// 终止条件: 已加载数达到或超过总数
					if (currentStats.total >= total) {
						console.log('[评论采集] 数量已达标，采集完成');
						updateProgressHint(currentStats.total, total, '采集完成');
						clearInterval(loadLoop);
						var finalFormatted = formatComments(currentPayload.items);
						saveComments(finalFormatted, total);
						verifyCommentAllExpanded(currentPayload.items);
						if (typeof __wx_log === 'function') {
							__wx_log({ msg: '✅ 评论采集完成：' + currentStats.total + '/' + total });
						}
						return;
					}

					// 检查是否卡死
					if (currentStats.total === stats.total) {
						sameCountRetries++;
						expandSecondaryComments();
						if (sameCountRetries > 10) {
							clearInterval(loadLoop);
							updateProgressHint(currentStats.total, total, '重试结束，保存当前结果');
							var finalFormatted2 = formatComments(currentPayload.items);
							saveComments(finalFormatted2, total);
							verifyCommentAllExpanded(currentPayload.items);
							var msg = '采集停止：多次重试无新增数据。\n' +
								'当前: ' + currentStats.total + '/' + total + '\n';
							if (currentStats.missingReplies > 0) {
								msg += '\n⚠️ 仍有约 ' + currentStats.missingReplies + ' 条二级回复可能未展开。';
							}
							msg += '\n(已尝试自动保存当前数据)';
							if (typeof __wx_log === 'function') {
								__wx_log({ msg: '⚠️ ' + msg.replace(/\n/g, ' | ') });
							}
							return;
						}
					} else {
						stats = currentStats;
						sameCountRetries = 0;
						updateProgressHint(currentStats.total, total, '继续加载中');
						var expandedCount = expandSecondaryComments();
						if (expandedCount > 0) {
							console.log('[评论采集] 正在展开 ' + expandedCount + ' 个回复，暂停主列表滚动...');
							return;
						}
					}

					console.log('[评论采集] 采集中... ' + currentStats.total + '/' + total);

					if (currentStore) tryTriggerStoreLoadMore(currentStore);
					if (!scrollCommentList()) {
						updateProgressHint(currentStats.total, total, '等待评论侧栏继续加载');
					}

				}, 1500 + Math.random() * 1000);
			} else {
				saveComments(formatted, total);
				if (typeof __wx_log === 'function') {
					__wx_log({ msg: '✅ 评论已保存：' + stats.total + '/' + total });
				}
			}
		}
	};

	if (document.readyState === 'complete') {
		initObserver();
	} else {
		window.addEventListener('load', initObserver);
	}
	setTimeout(initObserver, 5000);

})();
</script>`
}

// getVideoCommentsMatchingScript 获取精准作品评论匹配脚本
// 边滚动边过滤模式：打开评论区 → 逐批读取评论 → 过滤 → 够数即停
func (h *ScriptHandler) getVideoCommentsMatchingScript() string {
	return `<script>
(function() {
	'use strict';

	// ============================================================
	// 精准作品匹配：评论采集 + 过滤 + 够数即停
	// ============================================================

	window.__sph_get_video_comments = function(options) {
		var targetNum = options.target_num || 0;
		var triggerWords = options.trigger_words || [];
		var ipFilter = options.ip_filter || '';
		var timeFilter = options.time_filter || {};
		var blockWords = options.block_words || [];
		var dedupUsers = options.dedup_usernames || [];
		var timeout = (options.timeout || 120) * 1000;
		var taskId = options.task_id || '';
		var onProgress = options.on_progress || function(){};
		var onComplete = options.on_complete || function(){};

		var startTime = Date.now();
		var collectedUsers = [];          // 有效用户列表
		var seenUsernames = {};           // username 去重映射
		var commentCount = 0;             // 当前已加载评论数
		var sameCountRetries = 0;          // 连续无增长计数
		var scrollTimer = null;
		var isRunning = false;

		// ---------- 过滤函数 ----------

		function matchTriggerWord(content) {
			if (!triggerWords || triggerWords.length === 0) return true;
			var lower = (content || '').toLowerCase();
			for (var i = 0; i < triggerWords.length; i++) {
				var w = (triggerWords[i] || '').toLowerCase();
				if (w && lower.indexOf(w) >= 0) return true;
			}
			return false;
		}

		function matchIpFilter(ipLocation) {
			if (!ipFilter || !ipFilter.trim()) return true;
			var targets = ipFilter.split(',').map(function(s){ return s.trim().toLowerCase(); }).filter(function(s){ return s; });
			if (targets.length === 0) return true;
			var loc = (ipLocation || '').toLowerCase();
			for (var i = 0; i < targets.length; i++) {
				if (loc.indexOf(targets[i]) >= 0) return true;
			}
			return false;
		}

		function matchTimeFilter(createTime) {
			if (!timeFilter || !timeFilter.enabled) return true;
			// createTime 格式: "3小时前" / "昨天" / "2024-01-01" 等
			var now = Date.now();
			var commentTs = parseCommentTime(createTime);
			if (!commentTs) return true; // 无法解析时间，不过滤
			var diffMs = now - commentTs;
			if (timeFilter.unit === 'hour') {
				return diffMs <= timeFilter.value * 3600000;
			}
			if (timeFilter.unit === 'day') {
				return diffMs <= timeFilter.value * 86400000;
			}
			if (timeFilter.unit === 'week') {
				return diffMs <= timeFilter.value * 604800000;
			}
			return true;
		}

		function parseCommentTime(timeStr) {
			if (!timeStr) return null;
			var str = timeStr.trim();
			var m;
			// "3小时前"
			m = str.match(/^(\d+)\s*小时前$/);
			if (m) return Date.now() - parseInt(m[1]) * 3600000;
			// "2天前"
			m = str.match(/^(\d+)\s*天前$/);
			if (m) return Date.now() - parseInt(m[1]) * 86400000;
			// "昨天 HH:mm"
			if (str.indexOf('昨天') >= 0) {
				var t = str.replace('昨天', '').trim();
				var d = new Date();
				d.setDate(d.getDate() - 1);
				var parts = t.match(/(\d+):(\d+)/);
				if (parts) { d.setHours(parseInt(parts[1]), parseInt(parts[2]), 0, 0); return d.getTime(); }
				return d.setHours(0,0,0,0);
			}
			// "2024-01-01" / "2024/01/01"
			m = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
			if (m) {
				var dt = new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
				if (!isNaN(dt)) return dt.getTime();
			}
			// 尝试 Date.parse
			var ts = Date.parse(str);
			return isNaN(ts) ? null : ts;
		}

		function matchBlockWords(content, nickname) {
			if (!blockWords || blockWords.length === 0) return false;
			var text = ((content || '') + ' ' + (nickname || '')).toLowerCase();
			for (var i = 0; i < blockWords.length; i++) {
				var w = (blockWords[i] || '').toLowerCase();
				if (w && text.indexOf(w) >= 0) return true;
			}
			return false;
		}

		function isDuplicateUser(username) {
			if (!username || !username.trim()) return false;
			return !!seenUsernames[username];
		}

		function markUserSeen(username) {
			if (username && username.trim()) seenUsernames[username] = true;
		}

		// ---------- 数据读取（复用现有采集脚本逻辑） ----------

		function readCurrentComments() {
			var storeData = findFlowCommentListInStores();
			var payload = storeData ? extractStoreComments(storeData.store) : null;
			if (!payload || !payload.items || !payload.items.length) {
				var domPayload = extractCommentPayloadFromDOM();
				var storePayload = storeData ? extractCommentPayload(storeData.store, false) : null;
				payload = domPayload || storePayload;
			}
			if (!payload || !payload.items || !payload.items.length) return null;
			return {
				items: payload.items,
				total: payload.total || 0,
				store: storeData ? storeData.store : null
			};
		}

		// ---------- 过滤单条评论 ----------

		function filterComment(item) {
			var raw = item;
			var content = raw.content || raw.text || '';
			var nickname = raw.nickname || (raw.author && raw.author.nickname) || '';
			var ipLocation = '';
			if (raw.ipRegionInfo && raw.ipRegionInfo.regionText) {
				ipLocation = raw.ipRegionInfo.regionText;
			}
			var createTime = raw.createtime || raw.createTime || raw.create_time || '';

			// 1. 触发词匹配
			if (!matchTriggerWord(content)) return null;

			// 2. IP 属地过滤
			if (!matchIpFilter(ipLocation)) return null;

			// 3. 时间过滤
			if (!matchTimeFilter(createTime)) return null;

			// 4. 屏蔽词过滤
			if (matchBlockWords(content, nickname)) return null;

			// 5. 去重（基于 username）
			var username = raw.username || (raw.authorContact && raw.authorContact.username) || '';
			if (isDuplicateUser(username)) return null;
			markUserSeen(username);

			// 提取用户信息
			var user = {
				uid: raw.commentId || raw.id || '',
				username: username,
				nickname: nickname,
				headUrl: raw.headUrl || (raw.author && raw.author.headUrl) || '',
				content: content,
				ipLocation: ipLocation,
				createTime: createTime,
				likeCount: raw.likeCount || raw.like_num || 0,
				replyCount: raw.levelTwoComment ? raw.levelTwoComment.length : 0,
				authorLiked: !!(raw.authorLiked || (raw.authorReactionInfo && raw.authorReactionInfo.authorLikeTime)),
				// 原始数据完整保留
				_raw: raw
			};

			return user;
		}

		// ---------- 过滤一批评论 ----------

		function filterComments(items) {
			var newUsers = [];
			var newUsernames = [];
			for (var i = 0; i < items.length; i++) {
				var user = filterComment(items[i]);
				if (user) {
					newUsers.push(user);
					newUsernames.push(user.username);
					// 同时过滤二级评论
					var level2 = items[i].levelTwoComment;
					if (level2 && Array.isArray(level2)) {
						for (var j = 0; j < level2.length; j++) {
							var sub = filterComment(level2[j]);
							if (sub) {
								newUsers.push(sub);
								newUsernames.push(sub.username);
							}
						}
					}
				}
			}
			return { users: newUsers, usernames: newUsernames };
		}

		// ---------- 滚动加载 ----------

		function triggerScroll() {
			var storeData = findFlowCommentListInStores();
			var store = storeData ? storeData.store : null;
			if (store) {
				tryTriggerStoreLoadMore(store);
			}
			// 尝试滚动评论区容器
			var scrolled = scrollCommentList();
			if (!scrolled) {
				window.scrollTo(0, document.body.scrollHeight);
			}
		}

		// ---------- 主循环 ----------

		function mainLoop() {
			if (!isRunning) return;

			// 超时检查
			if (Date.now() - startTime > timeout) {
				console.log('[精准匹配] 超时退出:', timeout / 1000, 's');
				stop();
				onComplete({ reason: 'timeout', users: collectedUsers, total: collectedUsers.length, target_num: targetNum });
				return;
			}

			var data = readCurrentComments();
			if (!data || !data.items) {
				// 未找到数据，尝试触发滚动
				triggerScroll();
				scheduleNext(1500);
				return;
			}

			var newCount = data.items.length;

			// 评论数没有增加
			if (newCount <= commentCount) {
				sameCountRetries++;
				expandSecondaryComments();
				if (sameCountRetries > 10) {
					console.log('[精准匹配] 评论已耗尽，停止采集');
					stop();
					onComplete({ reason: 'exhausted', users: collectedUsers, total: collectedUsers.length, target_num: targetNum, comment_count: commentCount });
					return;
				}
				triggerScroll();
				scheduleNext(1500);
				return;
			}

			// 有新增评论，进行过滤
			sameCountRetries = 0;
			commentCount = newCount;

			var filtered = filterComments(data.items);
			if (filtered.users.length > 0) {
				collectedUsers = collectedUsers.concat(filtered.users);
				// 去重 collectedUsers（理论上上面的 markUserSeen 已经处理，但双重保险）
				var seen = {};
				var unique = [];
				for (var k = 0; k < collectedUsers.length; k++) {
					var u = collectedUsers[k];
					var key = u.username || u.uid || k;
					if (!seen[key]) {
						seen[key] = true;
						unique.push(u);
					}
				}
				collectedUsers = unique;
			}

			var progress = {
				comment_count: commentCount,
				user_count: collectedUsers.length,
				target_num: targetNum,
				percent: targetNum > 0 ? Math.min(100, Math.round(collectedUsers.length / targetNum * 100)) : 0
			};
			onProgress(progress);

			console.log('[精准匹配] 评论:', commentCount, '| 有效用户:', collectedUsers.length, '/', targetNum);

			// 检查是否够数
			if (targetNum > 0 && collectedUsers.length >= targetNum) {
				console.log('[精准匹配] 达到目标数量，停止采集');
				stop();
				onComplete({ reason: 'target_reached', users: collectedUsers, total: collectedUsers.length, target_num: targetNum, comment_count: commentCount });
				return;
			}

			// 未达目标，继续滚动
			triggerScroll();
			scheduleNext(1500);
		}

		function scheduleNext(delay) {
			if (!isRunning) return;
			scrollTimer = setTimeout(mainLoop, delay);
		}

		function stop() {
			isRunning = false;
			if (scrollTimer) {
				clearTimeout(scrollTimer);
				scrollTimer = null;
			}
		}

		// ---------- 启动 ----------

		console.log('[精准匹配] 启动采集, 目标:', targetNum, '触发词:', triggerWords);
		isRunning = true;

		// ---------- 打开评论区面板 ----------
		// 复用 feed.js 的 __try_open_feed_comment_panel 逻辑
		function __sph_try_open_comment_panel() {
			// Level 1: 检查评论区是否已存在
			var selectors = [
				'.comment-list', '.comment-panel', '.comment-drawer',
				'[class*="comment-panel"]', '[class*="comment-drawer"]', '[class*="comment-list"]'
			];
			for (var i = 0; i < selectors.length; i++) {
				var el = document.querySelector(selectors[i]);
				if (el && el.offsetParent !== null) {
					console.log('[精准匹配] 评论区已打开');
					return true;
				}
			}

			// Level 2: 查找并点击评论按钮
			var commentBtns = document.querySelectorAll('[aria-label^="评论"]');
			for (var j = 0; j < commentBtns.length; j++) {
				var label = commentBtns[j].getAttribute('aria-label') || '';
				if (commentBtns[j].offsetParent !== null) {
					try { commentBtns[j].click(); } catch(e) {}
					console.log('[精准匹配] 点击评论按钮:', label);
					return true;
				}
			}

			// Level 3: 通过 Pinia Store 打开评论区
			try {
				var app = document.querySelector('[data-v-app]') || document.getElementById('app');
				if (app) {
					var vue = app.__vue__ || app.__vueParentComponent || (app._vnode && app._vnode.component);
					var pinia = vue && vue.appContext && vue.appContext.config && vue.appContext.config.globalProperties && vue.appContext.config.globalProperties.$pinia;
					if (pinia && pinia._s && typeof pinia._s.forEach === 'function') {
						var methodNames = ['openComment', 'openCommentPanel', 'showCommentPanel', 'toggleCommentPanel', 'onClickComment', 'handleCommentClick'];
						pinia._s.forEach(function(store) {
							for (var m = 0; m < methodNames.length; m++) {
								if (typeof store[methodNames[m]] === 'function') {
									try { store[methodNames[m]](); } catch(_e) {}
								}
							}
						});
					}
				}
			} catch(e) {}

			return false;
		}

		// 尝试打开评论区（最多等 5 秒）
		__sph_try_open_comment_panel();
		var panelOpened = false;
		var __panelWait = function __panelWaitFn(waitCount) {
			if (waitCount >= 10) { console.log('[精准匹配] 等待评论区超时'); return; }
			var textarea = document.querySelector('textarea.weui-textarea');
			var commentList = document.querySelector('.comment-list, .comment-panel, .comment-drawer, [class*="comment-panel"]');
			if (textarea || commentList) {
				panelOpened = true;
				console.log('[精准匹配] 评论区面板已打开');
				return;
			}
			setTimeout(function() { __panelWaitFn(waitCount + 1); }, 500);
		};
		setTimeout(function() { __panelWait(0); }, 100);

		// 等待评论数据加载（最多等 3 秒）
		var __loadWait = function __loadWaitFn(waitCount) {
			if (waitCount >= 6) { console.log('[精准匹配] 等待评论数据超时'); return; }
			var init = readCurrentComments();
			if (init && init.items && init.items.length > 0) {
				console.log('[精准匹配] 评论数据已就绪:', init.items.length, '条');
				return;
			}
			setTimeout(function() { __loadWaitFn(waitCount + 1); }, 500);
		};
		setTimeout(function() { __loadWait(0); }, 500);

		// 尝试直接读取一次
		var initial = readCurrentComments();
		if (initial && initial.items && initial.items.length > 0) {
			commentCount = initial.items.length;
			var filtered = filterComments(initial.items);
			if (filtered.users.length > 0) {
				collectedUsers = collectedUsers.concat(filtered.users);
				var seen = {}; var unique = [];
				for (var k = 0; k < collectedUsers.length; k++) {
					var u2 = collectedUsers[k];
					var key = u2.username || u2.uid || k;
					if (!seen[key]) { seen[key] = true; unique.push(u2); }
				}
				collectedUsers = unique;
			}
			onProgress({ comment_count: commentCount, user_count: collectedUsers.length, target_num: targetNum });
			if (targetNum > 0 && collectedUsers.length >= targetNum) {
				stop();
				onComplete({ reason: 'target_reached', users: collectedUsers, total: collectedUsers.length, target_num: targetNum, comment_count: commentCount });
				return;
			}
		}

		// 触发一次加载更多再开始循环
		triggerScroll();
		scheduleNext(2000);
	};

})();
</script>`
}

// getLogPanelScript 获取日志面板脚本
func (h *ScriptHandler) getLogPanelScript() string {
	// 根据配置决定是否显示日志按钮
	showLogButton := "false"
	if h.getConfig().ShowLogButton {
		showLogButton = "true"
	}

	// 根据配置决定是否拦截日志（默认禁用以节省内存）
	enableLogInterception := "false"
	if h.getConfig().EnableLogInterception {
		enableLogInterception = "true"
	}

	return `<script>
// 日志按钮显示配置
window.__wx_channels_show_log_button__ = ` + showLogButton + `;
// 日志拦截配置（禁用可节省内存）
window.__wx_channels_enable_log_interception__ = ` + enableLogInterception + `;
</script>
<script>
(function() {
	'use strict';
	
	// 防止重复初始化
	if (window.__wx_channels_log_panel_initialized__) {
		return;
	}
	window.__wx_channels_log_panel_initialized__ = true;
	
	// 日志存储（优化版 - 减少内存占用）
	const logStore = {
		logs: [],
		maxLogs: 100, // 最多保存100条日志（从500降低）
		updatePending: false,
		lastCleanupTime: Date.now(),
		cleanupInterval: 5 * 60 * 1000, // 每5分钟自动清理一次
		
		addLog: function(level, args) {
			// 过滤掉过于频繁的日志（防止刷屏）
			const message = Array.from(args).map(arg => {
				if (typeof arg === 'object') {
					try {
						// 限制对象序列化深度，避免大对象占用过多内存
						return JSON.stringify(arg, this.jsonReplacer, 2);
					} catch (e) {
						return String(arg);
					}
				}
				return String(arg);
			}).join(' ');
			
			// 跳过重复的日志（连续相同的日志只保留一条）
			if (this.logs.length > 0) {
				const lastLog = this.logs[this.logs.length - 1];
				if (lastLog.level === level && lastLog.message === message) {
					// 更新重复计数
					lastLog.count = (lastLog.count || 1) + 1;
					lastLog.timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
					this.scheduleUpdate();
					return;
				}
			}
			
			const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
			this.logs.push({
				level: level,
				message: message,
				timestamp: timestamp,
				count: 1
			});
			
			// 限制日志数量（移除最旧的日志）
			if (this.logs.length > this.maxLogs) {
				this.logs.shift();
			}
			
			// 定期自动清理（防止内存累积）
			const now = Date.now();
			if (now - this.lastCleanupTime > this.cleanupInterval) {
				this.autoCleanup();
				this.lastCleanupTime = now;
			}
			
			// 批量更新显示（防止频繁DOM操作）
			this.scheduleUpdate();
		},
		
		// JSON序列化限制器（防止大对象）
		jsonReplacer: function(key, value) {
			// 限制字符串长度
			if (typeof value === 'string' && value.length > 500) {
				return value.substring(0, 500) + '... (truncated)';
			}
			// 限制数组长度
			if (Array.isArray(value) && value.length > 10) {
				return value.slice(0, 10).concat(['... (' + (value.length - 10) + ' more items)']);
			}
			return value;
		},
		
		// 自动清理旧日志（保留最近50条）
		autoCleanup: function() {
			if (this.logs.length > 50) {
				const removed = this.logs.length - 50;
				this.logs = this.logs.slice(-50);
				console.log('[日志面板] 自动清理了 ' + removed + ' 条旧日志');
			}
		},
		
		// 批量更新显示（防抖）
		scheduleUpdate: function() {
			if (this.updatePending) return;
			this.updatePending = true;
			
			// 使用 requestAnimationFrame 批量更新
			requestAnimationFrame(() => {
				this.updatePending = false;
				if (window.__wx_channels_log_panel) {
					window.__wx_channels_log_panel.updateDisplay();
				}
			});
		},
		
		clear: function() {
			this.logs = [];
			if (window.__wx_channels_log_panel) {
				window.__wx_channels_log_panel.updateDisplay();
			}
		}
	};
	
	// 创建日志面板
	function createLogPanel() {
		const panel = document.createElement('div');
		panel.id = '__wx_channels_log_panel';
		// 检测是否为移动设备
		const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
		
		// 面板位置：在按钮旁边，向上展开
		const btnBottom = isMobile ? 80 : 20;
		const btnLeft = isMobile ? 15 : 20;
		const btnSize = isMobile ? 56 : 50;
		const panelWidth = isMobile ? 'calc(100% - 30px)' : '400px';
		const panelMaxWidth = isMobile ? '100%' : '500px';
		const panelMaxHeight = isMobile ? 'calc(100vh - ' + (btnBottom + btnSize + 20) + 'px)' : '500px';
		const panelFontSize = isMobile ? '11px' : '12px';
		const panelBottom = btnBottom + btnSize + 10; // 按钮上方10px
		
		panel.style.cssText = 'position: fixed;' +
			'bottom: ' + panelBottom + 'px;' +
			'left: ' + btnLeft + 'px;' +
			'width: ' + panelWidth + ';' +
			'max-width: ' + panelMaxWidth + ';' +
			'max-height: ' + panelMaxHeight + ';' +
			'height: 0;' +
			'background: rgba(0, 0, 0, 0.95);' +
			'border: 1px solid #333;' +
			'border-radius: 8px 8px 0 0;' +
			'box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.5);' +
			'z-index: 999999;' +
			'font-family: "Consolas", "Monaco", "Courier New", monospace;' +
			'font-size: ' + panelFontSize + ';' +
			'color: #fff;' +
			'display: none;' +
			'flex-direction: column;' +
			'overflow: hidden;' +
			'transition: height 0.3s ease, opacity 0.3s ease;' +
			'opacity: 0;';
		
		// 标题栏
		const header = document.createElement('div');
		header.style.cssText = 'background: #1a1a1a;' +
			'padding: 8px 12px;' +
			'border-bottom: 1px solid #333;' +
			'display: flex;' +
			'justify-content: space-between;' +
			'align-items: center;' +
			'cursor: move;' +
			'user-select: none;';
		
		const title = document.createElement('span');
		title.textContent = '📋 日志面板';
		title.style.cssText = 'font-weight: bold; color: #4CAF50;';
		
		const controls = document.createElement('div');
		controls.style.cssText = 'display: flex; gap: 8px;';
		
		// 清空按钮
		const clearBtn = document.createElement('button');
		clearBtn.textContent = '清空';
		clearBtn.style.cssText = 'background: #f44336;' +
			'color: white;' +
			'border: none;' +
			'padding: 4px 12px;' +
			'border-radius: 4px;' +
			'cursor: pointer;' +
			'font-size: 11px;';
		clearBtn.onclick = function(e) {
			e.stopPropagation();
			logStore.clear();
		};
		
		// 复制日志按钮
		const copyBtn = document.createElement('button');
		copyBtn.textContent = '复制';
		copyBtn.style.cssText = 'background: #4CAF50;' +
			'color: white;' +
			'border: none;' +
			'padding: 4px 12px;' +
			'border-radius: 4px;' +
			'cursor: pointer;' +
			'font-size: 11px;';
		copyBtn.onclick = function(e) {
			e.stopPropagation();
			try {
				// 构建日志文本
				var logText = '';
				logStore.logs.forEach(function(log) {
					var levelPrefix = '';
					switch(log.level) {
						case 'log': levelPrefix = '[LOG]'; break;
						case 'info': levelPrefix = '[INFO]'; break;
						case 'warn': levelPrefix = '[WARN]'; break;
						case 'error': levelPrefix = '[ERROR]'; break;
						default: levelPrefix = '[LOG]';
					}
					logText += '[' + log.timestamp + '] ' + levelPrefix + ' ' + log.message + '\n';
				});
				
				if (logText === '') {
					// alert('日志为空，无需复制');
					return;
				}
				
				// 使用 Clipboard API 复制
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(logText).then(function() {
						copyBtn.textContent = '已复制';
						setTimeout(function() {
							copyBtn.textContent = '复制';
						}, 2000);
					}).catch(function(err) {
						console.error('复制失败:', err);
						// 降级方案：使用传统方法
						copyToClipboardFallback(logText);
					});
				} else {
					// 降级方案：使用传统方法
					copyToClipboardFallback(logText);
				}
			} catch (error) {
				console.error('复制日志失败:', error);
				// alert('复制失败: ' + error.message);
			}
		};
		
		// 复制到剪贴板的降级方案
		function copyToClipboardFallback(text) {
			var textArea = document.createElement('textarea');
			textArea.value = text;
			textArea.style.position = 'fixed';
			textArea.style.top = '-999px';
			textArea.style.left = '-999px';
			document.body.appendChild(textArea);
			textArea.select();
			try {
				var successful = document.execCommand('copy');
				if (successful) {
					copyBtn.textContent = '已复制';
					setTimeout(function() {
						copyBtn.textContent = '复制';
					}, 2000);
				} else {
					// alert('复制失败，请手动选择文本复制');
				}
			} catch (err) {
				console.error('复制失败:', err);
				// alert('复制失败: ' + err.message);
			}
			document.body.removeChild(textArea);
		}
		
		// 导出日志按钮
		const exportBtn = document.createElement('button');
		exportBtn.textContent = '导出';
		exportBtn.style.cssText = 'background: #FF9800;' +
			'color: white;' +
			'border: none;' +
			'padding: 4px 12px;' +
			'border-radius: 4px;' +
			'cursor: pointer;' +
			'font-size: 11px;';
		exportBtn.onclick = function(e) {
			e.stopPropagation();
			try {
				// 构建日志文本
				var logText = '';
				logStore.logs.forEach(function(log) {
					var levelPrefix = '';
					switch(log.level) {
						case 'log': levelPrefix = '[LOG]'; break;
						case 'info': levelPrefix = '[INFO]'; break;
						case 'warn': levelPrefix = '[WARN]'; break;
						case 'error': levelPrefix = '[ERROR]'; break;
						default: levelPrefix = '[LOG]';
					}
					logText += '[' + log.timestamp + '] ' + levelPrefix + ' ' + log.message + '\n';
				});
				
				if (logText === '') {
					// alert('日志为空，无需导出');
					return;
				}
				
				// 创建 Blob 并下载
				var blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
				var url = URL.createObjectURL(blob);
				var a = document.createElement('a');
				var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
				a.href = url;
				a.download = 'wx_channels_logs_' + timestamp + '.txt';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
				
				exportBtn.textContent = '已导出';
				setTimeout(function() {
					exportBtn.textContent = '导出';
				}, 2000);
			} catch (error) {
				console.error('导出日志失败:', error);
				// alert('导出失败: ' + error.message);
			}
		};
		
		// 最小化/最大化按钮
		const toggleBtn = document.createElement('button');
		toggleBtn.textContent = '−';
		toggleBtn.style.cssText = 'background: #2196F3;' +
			'color: white;' +
			'border: none;' +
			'padding: 4px 12px;' +
			'border-radius: 4px;' +
			'cursor: pointer;' +
			'font-size: 11px;';
		toggleBtn.onclick = function(e) {
			e.stopPropagation();
			const content = panel.querySelector('.log-content');
			if (content.style.display === 'none') {
				content.style.display = 'flex';
				toggleBtn.textContent = '−';
			} else {
				content.style.display = 'none';
				toggleBtn.textContent = '+';
			}
		};
		
		// 关闭按钮
		const closeBtn = document.createElement('button');
		closeBtn.textContent = '×';
		closeBtn.style.cssText = 'background: #666;' +
			'color: white;' +
			'border: none;' +
			'padding: 4px 12px;' +
			'border-radius: 4px;' +
			'cursor: pointer;' +
			'font-size: 14px;' +
			'line-height: 1;';
		closeBtn.onclick = function(e) {
			e.stopPropagation();
			panel.style.display = 'none';
		};
		
		controls.appendChild(clearBtn);
		controls.appendChild(copyBtn);
		controls.appendChild(exportBtn);
		controls.appendChild(toggleBtn);
		controls.appendChild(closeBtn);
		header.appendChild(title);
		header.appendChild(controls);
		
		// 日志内容区域
		const content = document.createElement('div');
		content.className = 'log-content';
		content.style.cssText = 'flex: 1;' +
			'overflow-y: auto;' +
			'padding: 8px;' +
			'display: flex;' +
			'flex-direction: column;' +
			'gap: 2px;';
		
		// 滚动条样式
		content.style.scrollbarWidth = 'thin';
		content.style.scrollbarColor = '#555 #222';
		
		// 更新显示（优化版 - 减少DOM操作）
		function updateDisplay() {
			// 使用 DocumentFragment 批量更新DOM
			const fragment = document.createDocumentFragment();
			
			logStore.logs.forEach(log => {
				const logItem = document.createElement('div');
				logItem.style.cssText = 'padding: 4px 8px;' +
					'border-radius: 4px;' +
					'word-break: break-all;' +
					'line-height: 1.4;' +
					'background: rgba(255, 255, 255, 0.05);';
				
				// 根据日志级别设置颜色
				let levelColor = '#fff';
				let levelPrefix = '';
				switch(log.level) {
					case 'log':
						levelColor = '#4CAF50';
						levelPrefix = '[LOG]';
						break;
					case 'info':
						levelColor = '#2196F3';
						levelPrefix = '[INFO]';
						break;
					case 'warn':
						levelColor = '#FF9800';
						levelPrefix = '[WARN]';
						break;
					case 'error':
						levelColor = '#f44336';
						levelPrefix = '[ERROR]';
						logItem.style.background = 'rgba(244, 67, 54, 0.2)';
						break;
					default:
						levelPrefix = '[LOG]';
				}
				
				// 显示重复计数
				const countBadge = log.count > 1 ? 
					'<span style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 10px; font-size: 10px; margin-left: 4px;">×' + log.count + '</span>' : '';
				
				logItem.innerHTML = '<span style="color: #888; font-size: 10px;">[' + log.timestamp + ']</span>' +
					'<span style="color: ' + levelColor + '; font-weight: bold; margin: 0 4px;">' + levelPrefix + '</span>' +
					countBadge +
					'<span style="color: #fff;">' + escapeHtml(log.message) + '</span>';
				
				fragment.appendChild(logItem);
			});
			
			// 一次性更新DOM
			content.innerHTML = '';
			content.appendChild(fragment);
			
			// 自动滚动到底部
			content.scrollTop = content.scrollHeight;
		}
		
		// HTML转义
		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}
		
		panel.appendChild(header);
		panel.appendChild(content);
		document.body.appendChild(panel);
		
		// 移除拖拽功能，面板位置固定在按钮旁边
		
		// 计算面板高度
		function getPanelHeight() {
			// 临时显示以计算高度
			const wasHidden = panel.style.display === 'none';
			if (wasHidden) {
				panel.style.display = 'flex';
				panel.style.height = 'auto';
				panel.style.opacity = '0';
			}
			
			const maxHeight = parseInt(panel.style.maxHeight) || 500;
			const headerHeight = header.offsetHeight || 40;
			const contentHeight = content.scrollHeight || 0;
			const totalHeight = headerHeight + contentHeight + 16; // 16px padding
			const finalHeight = Math.min(maxHeight, totalHeight);
			
			if (wasHidden) {
				panel.style.display = 'none';
				panel.style.height = '0';
			}
			
			return finalHeight;
		}
		
		// 暴露更新方法
		window.__wx_channels_log_panel = {
			panel: panel,
			updateDisplay: updateDisplay,
			show: function() {
				panel.style.display = 'flex';
				// 使用requestAnimationFrame确保DOM已更新
				requestAnimationFrame(function() {
					const targetHeight = getPanelHeight();
					panel.style.height = targetHeight + 'px';
					panel.style.opacity = '1';
				});
			},
			hide: function() {
				panel.style.height = '0';
				panel.style.opacity = '0';
				// 动画结束后隐藏
				setTimeout(function() {
					if (panel.style.opacity === '0') {
						panel.style.display = 'none';
					}
				}, 300);
			},
			toggle: function() {
				if (panel.style.display === 'none' || panel.style.opacity === '0') {
					this.show();
				} else {
					this.hide();
				}
			}
		};
	}
	
	// 保存原始的console方法
	const originalConsole = {
		log: console.log.bind(console),
		info: console.info.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
		debug: console.debug.bind(console)
	};
	
	// 重写console方法（可选 - 根据配置决定是否拦截）
	// 如果不需要日志面板，可以完全禁用拦截以节省内存
	const enableLogInterception = window.__wx_channels_enable_log_interception__ || false;
	
	if (enableLogInterception) {
		console.log = function(...args) {
			originalConsole.log.apply(console, args);
			logStore.addLog('log', args);
		};
		
		console.info = function(...args) {
			originalConsole.info.apply(console, args);
			logStore.addLog('info', args);
		};
		
		console.warn = function(...args) {
			originalConsole.warn.apply(console, args);
			logStore.addLog('warn', args);
		};
		
		console.error = function(...args) {
			originalConsole.error.apply(console, args);
			logStore.addLog('error', args);
		};
		
		console.debug = function(...args) {
			originalConsole.debug.apply(console, args);
			logStore.addLog('log', args);
		};
		
		console.log('[日志面板] 日志拦截已启用（可能占用内存）');
	} else {
		console.log('[日志面板] 日志拦截已禁用（节省内存模式）');
	}
	
	// 创建浮动触发按钮（用于微信浏览器等无法使用快捷键的场景）
	function createToggleButton() {
		const btn = document.createElement('div');
		btn.id = '__wx_channels_log_toggle_btn';
		btn.innerHTML = '📋';
		// 检测是否为移动设备
		const isMobileBtn = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
		
		const btnBottom = isMobileBtn ? '80px' : '20px';
		const btnLeft = isMobileBtn ? '15px' : '20px';
		const btnWidth = isMobileBtn ? '56px' : '50px';
		const btnHeight = isMobileBtn ? '56px' : '50px';
		const btnFontSize = isMobileBtn ? '28px' : '24px';
		
		btn.style.cssText = 'position: fixed;' +
			'bottom: ' + btnBottom + ';' +
			'left: ' + btnLeft + ';' +
			'width: ' + btnWidth + ';' +
			'height: ' + btnHeight + ';' +
			'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);' +
			'border-radius: 50%;' +
			'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);' +
			'z-index: 999998;' +
			'cursor: pointer;' +
			'display: flex;' +
			'align-items: center;' +
			'justify-content: center;' +
			'font-size: ' + btnFontSize + ';' +
			'user-select: none;' +
			'transition: all 0.3s ease;' +
			'border: 2px solid rgba(255, 255, 255, 0.3);' +
			'touch-action: manipulation;' +
			'-webkit-tap-highlight-color: transparent;';
		
		btn.addEventListener('mouseenter', function() {
			btn.style.transform = 'scale(1.1)';
			btn.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.4)';
		});
		
		btn.addEventListener('mouseleave', function() {
			btn.style.transform = 'scale(1)';
			btn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
		});
		
		// 切换面板显示的函数
		function togglePanel() {
			if (window.__wx_channels_log_panel) {
				const isVisible = window.__wx_channels_log_panel.panel.style.display !== 'none' && 
				                  window.__wx_channels_log_panel.panel.style.opacity !== '0';
				window.__wx_channels_log_panel.toggle();
				// 延迟更新按钮状态，等待动画完成
				setTimeout(function() {
					const nowVisible = window.__wx_channels_log_panel.panel.style.display !== 'none' && 
					                  window.__wx_channels_log_panel.panel.style.opacity !== '0';
					if (nowVisible) {
						btn.style.opacity = '1';
						btn.title = '点击隐藏日志面板';
					} else {
						btn.style.opacity = '0.6';
						btn.title = '点击显示日志面板';
					}
				}, 100);
			}
		}
		
		// 支持点击和触摸事件
		btn.addEventListener('click', togglePanel);
		btn.addEventListener('touchend', function(e) {
			e.preventDefault();
			togglePanel();
		});
		
		btn.title = '点击显示/隐藏日志面板';
		document.body.appendChild(btn);
		
		// 初始状态：面板默认不显示，按钮半透明
		btn.style.opacity = '0.6';
	}
	
	// 页面加载完成后创建面板和按钮
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function() {
			createLogPanel();
			// 根据配置决定是否创建日志按钮
			if (window.__wx_channels_show_log_button__) {
				createToggleButton();
			}
		});
	} else {
		createLogPanel();
		// 根据配置决定是否创建日志按钮
		if (window.__wx_channels_show_log_button__) {
			createToggleButton();
		}
	}
	
	// 添加快捷键：Ctrl+Shift+L 显示/隐藏日志面板（桌面浏览器可用）
	document.addEventListener('keydown', function(e) {
		if (e.ctrlKey && e.shiftKey && e.key === 'L') {
			e.preventDefault();
			if (window.__wx_channels_log_panel) {
				window.__wx_channels_log_panel.toggle();
				// 同步更新按钮状态
				const btn = document.getElementById('__wx_channels_log_toggle_btn');
				if (btn) {
					setTimeout(function() {
						const isVisible = window.__wx_channels_log_panel.panel.style.display !== 'none' && 
						                  window.__wx_channels_log_panel.panel.style.opacity !== '0';
						if (isVisible) {
							btn.style.opacity = '1';
						} else {
							btn.style.opacity = '0.6';
						}
					}, 100);
				}
			}
		}
	});
	
	// 面板默认不显示，需要点击按钮才会显示
})();
</script>`
}

// saveJavaScriptFile 保存页面加载的 JavaScript 文件到本地以便分析
func (h *ScriptHandler) saveJavaScriptFile(path string, content []byte) {
	// 检查是否启用JS文件保存
	if h.getConfig() != nil && !h.getConfig().SavePageJS {
		return
	}

	// 只保存 .js 文件
	if !strings.HasSuffix(strings.Split(path, "?")[0], ".js") {
		return
	}

	// 获取基础目录
	baseDir, err := utils.GetBaseDir()
	if err != nil {
		return
	}

	// 根据JS文件路径识别页面类型
	pageType := "common"
	pathLower := strings.ToLower(path)
	if strings.Contains(pathLower, "home") || strings.Contains(pathLower, "finderhome") {
		pageType = "home"
	} else if strings.Contains(pathLower, "profile") {
		pageType = "profile"
	} else if strings.Contains(pathLower, "feed") {
		pageType = "feed"
	} else if strings.Contains(pathLower, "search") {
		pageType = "search"
	} else if strings.Contains(pathLower, "live") {
		pageType = "live"
	}

	// 创建按页面类型分类的保存目录
	jsDir := filepath.Join(baseDir, h.getConfig().DownloadsDir, "cached_js", pageType)
	if err := utils.EnsureDir(jsDir); err != nil {
		return
	}

	// 从路径中提取文件名
	fileName := filepath.Base(path)
	if fileName == "" || fileName == "." || fileName == "/" {
		fileName = strings.ReplaceAll(path, "/", "_")
		fileName = strings.ReplaceAll(fileName, "\\", "_")
	}

	// 移除版本号后缀（如 .js?v=xxx）
	fileName = strings.Split(fileName, "?")[0]

	// 检查文件是否已存在（避免重复保存相同内容）
	filePath := filepath.Join(jsDir, fileName)
	if _, err := os.Stat(filePath); err == nil {
		// 文件已存在，跳过
		return
	}

	// 保存文件
	if err := os.WriteFile(filePath, content, 0644); err != nil {
		utils.LogInfo("[JS保存] 保存失败: %s - %v", fileName, err)
		return
	}

	utils.LogInfo("[JS保存] ✅ 已保存: %s/%s", pageType, fileName)
}

// getFetchVideoCommentsScript 获取获取评论脚本（无状态，每次调用读取当前页+触发一次滚动）
// Node.js 端循环调用此函数，边滚动边过滤
func (h *ScriptHandler) getFetchVideoCommentsScript() string {
	return `<script>
(function() {
	'use strict';

	// ============================================================
	// 获取评论（无状态版）
	// 每次调用：
	//   1. 如果评论区未打开，尝试打开
	//   2. 读取当前所有已加载的评论
	//   3. 触发一次加载更多
	//   4. 返回评论数据
	// ============================================================

	window.__sph_fetch_video_comments = function(options) {
		var panelOpened = false;
		var selectors = ['.comment-list', '.comment-panel', '.comment-drawer', '[class*="comment-panel"]', '[class*="comment-drawer"]'];
		for (var si = 0; si < selectors.length; si++) {
			var el = document.querySelector(selectors[si]);
			if (el && el.offsetParent !== null) { panelOpened = true; break; }
		}
		if (!panelOpened) {
			var cBtns = document.querySelectorAll('[aria-label^="评论"]');
			for (var ci = 0; ci < cBtns.length; ci++) {
				if (cBtns[ci].offsetParent !== null) {
					try { cBtns[ci].click(); } catch(e) {}
					break;
				}
			}
		}

		var payload = null;
		var found = window.__sph_findFlowCommentListInStores ? window.__sph_findFlowCommentListInStores() : null;
		if (found && window.__sph_extractStoreComments) {
			payload = window.__sph_extractStoreComments(found.store || found);
		}

		var commentCount = 0;
		var total = 0;
		var buffer = '';
		var hasMore = true; // 默认 true：数据未就绪时不误判退出，由平台数据决定是否真的还有更多
		var formatted = [];

		if (payload && payload.items && payload.items.length) {
			commentCount = payload.items.length;
			total = payload.total || 0;
			buffer = payload.buffer || '';
			hasMore = !!payload.hasMore;
			formatted = (window.__sph_formatComments || function(x){return x;})(payload.items);
		}

		if (commentCount > 0) {
			var storeForMore = window.__sph_findFlowCommentListInStores ? window.__sph_findFlowCommentListInStores() : null;
			if (storeForMore && window.__sph_tryTriggerStoreLoadMore) { window.__sph_tryTriggerStoreLoadMore(storeForMore.store || storeForMore); }
			if (window.__sph_scrollCommentList) { window.__sph_scrollCommentList(); }
			if (window.__sph_expandSecondaryComments) { window.__sph_expandSecondaryComments(); }
		}

		// 计算当前已加载的评论总数（一级 + 已展开的二级）
		var currentTotal = 0;
		if (payload && payload.items) {
			payload.items.forEach(function(item) {
				currentTotal++;
				if (item.levelTwoComment && Array.isArray(item.levelTwoComment)) {
					currentTotal += item.levelTwoComment.length;
				}
			});
		}

		return {
			panel_ready: panelOpened,
			items: formatted,
			total: total,
			comment_count: commentCount,
			current_total: currentTotal,
			has_more: hasMore,
			buffer: buffer,
			raw_items: payload && payload.items ? payload.items : []
		};
	};

	// 导出到全局（供 api_client 调用）
	window.__sph_fetch_video_comments_ready = true;

})();
</script>`
}

// getLogPanelScript 获取日志面板脚本

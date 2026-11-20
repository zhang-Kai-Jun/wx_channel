package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fatih/color"
	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"

	"wx_channel/internal/api"
	"wx_channel/internal/assets"
	"wx_channel/internal/config"
	"wx_channel/internal/database"
	"wx_channel/internal/diagnostics"
	"wx_channel/internal/domainpolicy"
	"wx_channel/internal/handlers"
	"wx_channel/internal/processproxy"
	"wx_channel/internal/router"
	"wx_channel/internal/services"
	"wx_channel/internal/utils"
	"wx_channel/internal/websocket"
	"wx_channel/internal/winwindow"
	"wx_channel/pkg/certificate"
	"wx_channel/pkg/proxy"
)

// App 结构体，用于保存依赖项和状态
type App struct {
	Sunny          *SunnyNet.Sunny
	Cfg            *config.Config
	Version        string
	Port           int
	CurrentPageURL string
	LogInitMsg     string

	// 处理器
	APIHandler        *handlers.APIHandler
	ScriptHandler     *handlers.ScriptHandler
	CommentHandler    *handlers.CommentHandler
	ConsoleAPIHandler *handlers.ConsoleAPIHandler
	WebSocketHandler  *handlers.WebSocketHandler
	StaticFileHandler *handlers.StaticFileHandler

	// 服务
	WSHub         *websocket.Hub
	TaskService   *database.SearchTaskService // 搜索任务服务（共享实例）
	SearchService *api.SearchService
	RadarService  *services.RadarService // 自动轮询雷达

	// 路由器
	APIRouter *router.APIRouter

	// 拦截器
	requestInterceptors  []router.Interceptor
	responseInterceptors []router.Interceptor
}

// 全局变量，用于将 SunnyNet C 风格回调桥接到 App 方法
var globalApp *App

// NewApp 创建并初始化一个新的 App 实例
func NewApp(cfgParam *config.Config) *App {
	app := &App{
		Sunny:   SunnyNet.NewSunny(),
		Cfg:     cfgParam,
		Version: "?t=" + cfgParam.Version,
		Port:    cfgParam.Port,
	}

	// 设置全局实例用于回调桥接
	globalApp = app

	// 初始化日志
	utils.LogConfigLoad("config.yaml", true)
	if app.Cfg.LogFile != "" {
		_ = utils.InitLoggerWithRotation(utils.INFO, app.Cfg.LogFile, app.Cfg.MaxLogSizeMB)
	}

	// 尽早初始化 WebSocket Hub，以确保它对 APIRouter 可用
	// 先创建共享的 TaskService，确保 Hub 和 API 使用同一实例
	app.TaskService = database.NewSearchTaskService()
	app.WSHub = websocket.NewHub(app.TaskService)

	// 根据配置设置负载均衡选择器
	app.configureLoadBalancer()

	return app
}

// initDataStore 初始化采集数据库
func (app *App) initDataStore() error {
	dataDir, err := utils.ResolveDataDir(app.Cfg.DataDir)
	if err != nil {
		return fmt.Errorf("解析数据目录失败: %v", err)
	}

	// Initialize Database
	dbPath := filepath.Join(dataDir, "records.db")
	if err := database.Initialize(&database.Config{DBPath: dbPath}); err != nil {
		return fmt.Errorf("初始化数据库失败: %v", err)
	}

	// 确保任务相关表存在
	app.TaskService.EnsureTablesExist()

	return nil
}

// Run 启动应用
func (app *App) Run() {
	os_env := runtime.GOOS
	stopSessionDiagnostics := diagnostics.StartSessionMonitor(func(sample diagnostics.SessionSample) {
		record, err := json.Marshal(sample)
		if err == nil {
			utils.LogFileInfo("[Perf][host_session] %s", record)
		}
	})
	defer stopSessionDiagnostics()

	// 确保端口设置正确
	app.Sunny.SetPort(app.Port)

	signalChan := make(chan os.Signal, 1)
	signal.Notify(signalChan, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signalChan)

	if err := app.initDataStore(); err != nil {
		utils.HandleError(err, "初始化采集数据库")
		return
	} else {
		if app.LogInitMsg != "" {
			utils.Info(app.LogInitMsg)
			app.LogInitMsg = ""
		}
	}
	defer database.Close()

	app.printEnvConfig()

	app.WebSocketHandler = handlers.NewWebSocketHandler()

	// 初始化雷达服务实例（始终创建，按配置决定是否启动）
	radarRepo := database.NewRadarRepository()
	app.RadarService = services.NewRadarService(radarRepo, app.WSHub)
	app.ConsoleAPIHandler = handlers.NewConsoleAPIHandler(app.Cfg, app.WSHub, app.RadarService)

	// 初始化新的 API 路由器
	app.APIRouter = router.NewAPIRouter(app.Cfg, app.WSHub, app.Sunny)

	// 初始化静态文件处理器
	app.StaticFileHandler = handlers.NewStaticFileHandler()

	// 初始化业务处理器
	app.APIHandler = handlers.NewAPIHandler(app.Cfg, app.WSHub)
	app.CommentHandler = handlers.NewCommentHandler(app.Cfg)

	// ScriptHandler
	app.ScriptHandler = handlers.NewScriptHandler(
		app.Cfg,
		assets.CoreJS,
		assets.HomeJS,
		assets.FeedJS,
		assets.ProfileJS,
		assets.SearchJS,
		assets.MittJS,
		assets.EventbusJS,
		assets.UtilsJS,
		assets.APIClientJS,
		assets.KeepAliveJS,
		app.Version,
	)

	// 初始化拦截器
	app.requestInterceptors = []router.Interceptor{
		app.StaticFileHandler,
		app.APIRouter,
		app.APIHandler,
		app.CommentHandler,
	}
	app.responseInterceptors = []router.Interceptor{
		app.ScriptHandler,
	}

	existing, err1 := certificate.CheckCertificate("SunnyNet")
	if err1 != nil {
		utils.HandleError(err1, "检查证书")
		utils.Warn("程序将继续运行，但HTTPS功能可能受限...")
		existing = false
	} else if !existing {
		utils.Info("正在安装证书...")
		err := certificate.InstallCertificate(assets.CertData)
		time.Sleep(app.Cfg.CertInstallDelay)
		if err != nil {
			utils.HandleError(err, "证书安装")
			utils.Warn("如需完整功能，请手动安装证书或以管理员身份运行程序。")
			if dataDir, err := app.Cfg.GetResolvedDataDir(); err == nil {
				if err := utils.EnsureDir(dataDir); err == nil {
					certPath := filepath.Join(dataDir, app.Cfg.CertFile)
					if err := os.WriteFile(certPath, assets.CertData, 0644); err == nil {
						utils.Info("证书文件已保存到: %s", certPath)
					}
				}
			}
		} else {
			utils.Info("✓ 证书安装成功！")
		}
	} else {
		utils.Info("✓ 证书已存在，无需重新安装。")
	}

	// 1. 立即启动核心驱动
	app.Sunny.SetGoCallback(GlobalHttpCallback, nil, nil, nil)
	sunnyErr := app.Sunny.Start().Error
	if sunnyErr != nil {
		utils.LogError("启动代理核心失败: %v", sunnyErr)
		return
	}
	defer app.Sunny.Close()
	if os_env == "windows" {
		changed, err := processproxy.CleanupLegacySystemProxy(app.Port)
		if err != nil {
			utils.LogError("%v", err)
			return
		}
		if changed {
			utils.Info("✓ 已清理指向本服务端口的旧系统代理，保留其他代理设置")
		}
		app.Cfg.ProxyMode = "process"
		cleanup, err := configureWindowsProxy(app.Cfg.ProxyMode, app.Sunny)
		if err != nil {
			utils.LogError("%v", err)
			return
		}
		defer cleanup()
		utils.Info("✓ 视频号进程驱动已就绪，仅接管经路径和归属核验的微信 PID")
	}

	// 2. 立即渲染界面面板 (不再受网络连接阻塞)
	utils.PrintSeparator()
	color.Blue("📡 服务状态信息")
	utils.PrintSeparator()
	utils.PrintLabelValue("⏳", "服务状态", "已启动")
	utils.PrintLabelValue("🔌", "代理端口", app.Port)
	utils.PrintLabelValue("📱", "支持平台", "微信视频号")

	utils.LogSystemStart(app.Port, "进程代理")

	// 3. 立即启动各类后台服务
	go app.WSHub.Run()
	utils.Info("✓ WebSocket Hub 已启动")

	wsPort := app.Port + 1
	go app.startWebSocketServer(wsPort)

	// 启动 Windows 自动独立窗口监听
	if os_env == "windows" {
		winwindow.StartAutoPopout()
	}

	// 启动对标雷达服务（默认关闭，按配置启用）
	if app.Cfg.RadarEnabled {
		app.RadarService.Start()
		utils.Info("✓ 雷达服务已启用")
	} else {
		utils.Info("雷达服务未启用 (radar_enabled: false)")
	}

	// 4. 【异步】处理 Windows 代理和连通性检查 (不阻塞主线程)
	go func() {
		// 如果是 Windows，根据模式启动代理
		// 页面入口提示与代理模式无关，保留微信 4.x 网页版适配。

		// 执行连通性自检
		time.Sleep(1 * time.Second)
		proxy_server := fmt.Sprintf("127.0.0.1:%v", app.Port)
		client := &http.Client{
			Transport: &http.Transport{
				Proxy: http.ProxyURL(&url.URL{
					Scheme: "http",
					Host:   proxy_server,
				}),
			},
			Timeout: 5 * time.Second,
		}

		if _, err := client.Get("https://sunny.io/"); err != nil {
			// utils.Warn("💡 注意：代理自检未通过")
		} else {
			utils.Info("✓ 证书与网络链路正常")
		}
	}()

	utils.Info("💡 服务正在运行，按 Ctrl+C 退出...")

	sig := <-signalChan
	utils.LogSystemShutdown(fmt.Sprintf("收到信号: %v", sig))
	if os_env == "darwin" {
		proxy.DisableProxyInMacOS(proxy.ProxySettings{Hostname: "127.0.0.1", Port: strconv.Itoa(app.Port)})
	}

	// 清理服务
	if app.RadarService != nil {
		app.RadarService.Stop()
	}
}

// GlobalHttpCallback 桥接到单例 app 实例
func GlobalHttpCallback(Conn *SunnyNet.HttpConn) {
	if globalApp != nil {
		globalApp.HandleRequest(Conn)
	}
}

// HandleRequest 处理 HTTP 回调
func (app *App) HandleRequest(Conn *SunnyNet.HttpConn) {
	if Conn == nil || Conn.Request == nil || Conn.Request.URL == nil {
		return
	}
	host := domainpolicy.RequestHost(Conn.Request)
	if !domainpolicy.IsLocalHost(host) && !domainpolicy.IsTargetHost(host) {
		return
	}
	// 恐慌恢复
	defer func() {
		if r := recover(); r != nil {
			utils.Error("HandleRequest panic: %v", r)
		}
	}()

	if Conn.Type == public.HttpSendRequest {
		if domainpolicy.MayRewrite(host, Conn.Request.URL.Path) && Conn.Request.Header != nil {
			// 优先请求 gzip 编码，既避免服务端使用未知压缩（如 br/zstd），又可由 Go 标准库解压
			Conn.Request.Header.Set("Accept-Encoding", "gzip, deflate")

			// 针对微信视频号关键请求，清理条件请求头，避免 304 Not Modified 响应导致 Body 为空无法改写
			Conn.Request.Header.Del("If-None-Match")
			Conn.Request.Header.Del("If-Modified-Since")
		}

		if domainpolicy.IsTargetHost(host) {
			utils.Info("[HTTP请求] %s Host=%s Path=%s (PID=%d)", Conn.Request.Method, host, Conn.Request.URL.Path, Conn.PID)
		}

		for _, interceptor := range app.requestInterceptors {
			if interceptor != nil && interceptor.Handle(Conn) {
				return
			}
		}
	} else if Conn.Type == public.HttpResponseOK {
		if domainpolicy.IsTargetHost(host) && Conn.Response != nil {
			utils.Info("[HTTP响应] %s %s 状态=%d", Conn.Request.Method, Conn.Request.URL.Path, Conn.Response.StatusCode)
		}

		for _, interceptor := range app.responseInterceptors {
			if interceptor != nil && interceptor.Handle(Conn) {
				return
			}
		}
	} else if Conn.Type == public.HttpRequestFail {
		reqURL := ""
		if Conn.Request != nil && Conn.Request.URL != nil {
			reqURL = Conn.Request.URL.String()
		}
		if domainpolicy.IsTargetHost(host) {
			utils.Warn("[HTTP失败] %s 错误: %s (PID=%d)", reqURL, Conn.GetError(), Conn.PID)
		}
	}
}

func (app *App) printEnvConfig() {
	hasAnyConfig := os.Getenv("WX_CHANNEL_TOKEN") != "" ||
		os.Getenv("WX_CHANNEL_ALLOWED_ORIGINS") != "" ||
		os.Getenv("WX_CHANNEL_LOG_FILE") != "" ||
		os.Getenv("WX_CHANNEL_LOG_MAX_MB") != "" ||
		os.Getenv("WX_CHANNEL_SAVE_PAGE_SNAPSHOT") != "" ||
		os.Getenv("WX_CHANNEL_SAVE_SEARCH_DATA") != "" ||
		os.Getenv("WX_CHANNEL_SAVE_PAGE_JS") != "" ||
		os.Getenv("WX_CHANNEL_SHOW_LOG_BUTTON") != ""

	if hasAnyConfig {
		utils.PrintSeparator()
		color.Blue("⚙️  环境变量配置信息")
		utils.PrintSeparator()

		if app.Cfg.SecretToken != "" {
			utils.PrintLabelValue("🔐", "安全令牌", "已设置")
		}
		if len(app.Cfg.AllowedOrigins) > 0 {
			utils.PrintLabelValue("🌐", "允许的Origin", strings.Join(app.Cfg.AllowedOrigins, ", "))
		}
		if app.Cfg.LogFile != "" {
			utils.PrintLabelValue("📝", "日志文件", app.Cfg.LogFile)
		}
		if app.Cfg.MaxLogSizeMB > 0 {
			utils.PrintLabelValue("📊", "日志最大大小", fmt.Sprintf("%d MB", app.Cfg.MaxLogSizeMB))
		}
		utils.PrintLabelValue("💾", "保存页面快照", fmt.Sprintf("%v", app.Cfg.SavePageSnapshot))
		utils.PrintLabelValue("🔍", "保存搜索数据", fmt.Sprintf("%v", app.Cfg.SaveSearchData))
		utils.PrintLabelValue("📄", "保存JS文件", fmt.Sprintf("%v", app.Cfg.SavePageJS))
		utils.PrintLabelValue("🖼️", "显示日志按钮", fmt.Sprintf("%v", app.Cfg.ShowLogButton))
		utils.PrintSeparator()
	}
}

// 隐式需要的辅助函数

func (app *App) startWebSocketServer(wsPort int) {
	mux := http.NewServeMux()

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		handlers.ServeWs(w, r)
	})

	// 挂载主 API Router，允许通过 WS 端口 (2026) 直接访问管理 API
	if app.APIRouter != nil {
		mux.Handle("/api/", app.APIRouter)
	}

	wsHandler := websocket.NewHandler(app.WSHub, app.Cfg.AllowedOrigins, app.Cfg.SecretToken)
	mux.HandleFunc("/ws/api", wsHandler.ServeHTTP)

	mux.HandleFunc("/ws/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		hub := handlers.GetWebSocketHub()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"clients": hub.ClientCount(),
		})
	})

	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", wsPort),
		Handler: mux,
	}

	utils.Info("🔌 WebSocket服务已启动，端口: %d", wsPort)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		// utils.Warn("WebSocket服务启动失败: %v", err)
	}
}

// configureLoadBalancer 配置负载均衡选择器
func (app *App) configureLoadBalancer() {
	strategy := app.Cfg.LoadBalancerStrategy
	if strategy == "" {
		strategy = "leastconn" // 默认使用最少连接
	}

	var selector websocket.ClientSelector

	switch strategy {
	case "roundrobin":
		selector = websocket.NewRoundRobinSelector()
		utils.Info("负载均衡策略: 轮询 (Round Robin)")
	case "leastconn":
		selector = websocket.NewLeastConnectionSelector()
		utils.Info("负载均衡策略: 最少连接 (Least Connection)")
	case "weighted":
		// 加权选择器需要配置权重，这里使用默认权重
		selector = websocket.NewWeightedSelector(nil)
		utils.Info("负载均衡策略: 加权 (Weighted)")
	case "random":
		selector = websocket.NewRandomSelector()
		utils.Info("负载均衡策略: 随机 (Random)")
	default:
		selector = websocket.NewLeastConnectionSelector()
		utils.Warn("未知的负载均衡策略: %s, 使用默认策略: 最少连接", strategy)
	}

	app.WSHub.SetSelector(selector)
}

package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"wx_channel/internal/config"

	"github.com/coder/websocket"

	"wx_channel/internal/services"
	"wx_channel/internal/utils"
)

// WebSocket 消息类型
const (
	MessageTypeStatsUpdate = "stats_update"
	MessageTypePing        = "ping"
	MessageTypePong        = "pong"
	WSMessageTypeCommand   = "cmd"
)

// StatsUpdateMessage 表示统计信息更新
type StatsUpdateMessage struct {
	Type  string               `json:"type"`
	Stats *services.Statistics `json:"stats"`
}

// WebSocketClient 表示已连接的 WebSocket 客户端
type WebSocketClient struct {
	hub      *WebSocketHub
	conn     *websocket.Conn
	send     chan []byte
	id       string
	ctx      context.Context
	cancel   context.CancelFunc
	closedMu sync.Mutex
	closed   bool
}

// WebSocketHub 管理所有 WebSocket 连接
type WebSocketHub struct {
	// 已注册的客户端
	clients map[*WebSocketClient]bool

	// 来自客户端的入站消息
	broadcast chan []byte

	// 来自客户端的注册请求
	register chan *WebSocketClient

	// 来自客户端的注销请求
	unregister chan *WebSocketClient

	// 用于线程安全操作的互斥锁
	mu sync.RWMutex

	// 用于统计更新的统计服务
	statsService *services.StatisticsService
}

// 全局 WebSocket Hub 实例
var wsHub *WebSocketHub
var wsHubOnce sync.Once

// GetWebSocketHub 返回单例 WebSocket Hub 实例
func GetWebSocketHub() *WebSocketHub {
	wsHubOnce.Do(func() {
		wsHub = NewWebSocketHub()
		go wsHub.Run()
		// 启动定期统计更新广播器
		go wsHub.startStatsUpdateBroadcaster()
	})
	return wsHub
}

// NewWebSocketHub 创建一个新的 WebSocket Hub
func NewWebSocketHub() *WebSocketHub {
	return &WebSocketHub{
		clients:      make(map[*WebSocketClient]bool),
		broadcast:    make(chan []byte, 256),
		register:     make(chan *WebSocketClient),
		unregister:   make(chan *WebSocketClient),
		statsService: services.NewStatisticsService(),
	}
}

// Run 启动 Hub 的主循环
func (h *WebSocketHub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
			utils.Info("[WebSocket] Client connected: %s (total: %d)", client.id, len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
			utils.Info("[WebSocket] Client disconnected: %s (total: %d)", client.id, len(h.clients))

		case message := <-h.broadcast:
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					// 客户端发送缓冲区已满，关闭连接
					h.mu.RUnlock()
					h.mu.Lock()
					close(client.send)
					delete(h.clients, client)
					h.mu.Unlock()
					h.mu.RLock()
				}
			}
			h.mu.RUnlock()
		}
	}
}

// ClientCount 返回已连接客户端的数量
func (h *WebSocketHub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// startStatsUpdateBroadcaster 启动一个 goroutine 定期广播统计更新
func (h *WebSocketHub) startStatsUpdateBroadcaster() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		// 仅当有已连接客户端时才广播
		h.mu.RLock()
		clientCount := len(h.clients)
		h.mu.RUnlock()

		if clientCount > 0 {
			h.BroadcastStatsUpdate()
		}
	}
}

// BroadcastCommand 向所有客户端广播指令
func (h *WebSocketHub) BroadcastCommand(action string, payload interface{}) error {
	cmdData := map[string]interface{}{
		"action":  action,
		"payload": payload,
	}

	data, err := json.Marshal(cmdData)
	if err != nil {
		return err
	}

	msg := struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}{
		Type: WSMessageTypeCommand,
		Data: data,
	}

	return h.BroadcastMessage(msg)
}

// BroadcastMessage 向所有连接的客户端发送消息
func (h *WebSocketHub) BroadcastMessage(message interface{}) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	h.broadcast <- data
	return nil
}

// BroadcastStatsUpdate 向所有客户端广播统计更新
func (h *WebSocketHub) BroadcastStatsUpdate() {
	stats, err := h.statsService.GetStatistics()
	if err != nil {
		utils.Warn("[WebSocket] Failed to get statistics for broadcast: %v", err)
		return
	}

	msg := StatsUpdateMessage{
		Type:  MessageTypeStatsUpdate,
		Stats: stats,
	}
	if err := h.BroadcastMessage(msg); err != nil {
		utils.Warn("[WebSocket] Failed to broadcast stats update: %v", err)
	}
}

// readPump 将消息从 WebSocket 连接泵送到 Hub
func (c *WebSocketClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.cancel()
	}()

	for {
		ctx, cancel := context.WithTimeout(c.ctx, 90*time.Second)
		_, message, err := c.conn.Read(ctx)
		cancel()

		if err != nil {
			if websocket.CloseStatus(err) != -1 {
				utils.Info("[WebSocket] Client %s closed: %v", c.id, err)
			} else {
				utils.Warn("[WebSocket] Read error from %s: %v", c.id, err)
			}
			break
		}

		// 处理传入消息（例如，ping/pong）
		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err == nil {
			if msgType, ok := msg["type"].(string); ok && msgType == MessageTypePing {
				// 响应 pong
				pong := map[string]string{"type": MessageTypePong}
				if data, err := json.Marshal(pong); err == nil {
					c.send <- data
				}
			}
		}
	}
}

// writePump 将消息从 Hub 泵送到 WebSocket 连接
func (c *WebSocketClient) writePump() {
	ticker := time.NewTicker(60 * time.Second) // ping 周期
	defer func() {
		ticker.Stop()
		c.cancel()
	}()

	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				// Hub 关闭了通道
				c.conn.Close(websocket.StatusNormalClosure, "closing")
				return
			}

			ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
			err := c.conn.Write(ctx, websocket.MessageText, message)
			cancel()

			if err != nil {
				return
			}

			// 将任何排队的消息发送
			n := len(c.send)
			for i := 0; i < n; i++ {
				ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
				err := c.conn.Write(ctx, websocket.MessageText, <-c.send)
				cancel()
				if err != nil {
					return
				}
			}

		case <-ticker.C:
			ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
			err := c.conn.Ping(ctx)
			cancel()
			if err != nil {
				return
			}

		case <-c.ctx.Done():
			return
		}
	}
}

// WebSocketHandler 处理 WebSocket 升级请求
type WebSocketHandler struct {
	hub *WebSocketHub
}

// NewWebSocketHandler 创建一个新的 WebSocket 处理器
func NewWebSocketHandler() *WebSocketHandler {
	return &WebSocketHandler{
		hub: GetWebSocketHub(),
	}
}

// HandleWebSocket 处理 WebSocket 连接升级
// Endpoint: /ws
func (h *WebSocketHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg != nil && cfg.SecretToken != "" {
		token := extractWSToken(r)
		if token != cfg.SecretToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// 构建 AcceptOptions（Origin 验证）
	opts := &websocket.AcceptOptions{}
	if cfg != nil && len(cfg.AllowedOrigins) > 0 {
		opts.OriginPatterns = cfg.AllowedOrigins
	} else {
		// 默认允许所有来源（本地工具）
		opts.InsecureSkipVerify = true
	}

	// 使用 coder/websocket 升级连接
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		utils.Warn("[WebSocket] Upgrade failed: %v", err)
		return
	}

	// 生成客户端 ID
	clientID := generateClientID()
	// 使用 Background context 而不是 r.Context()，避免 HTTP 请求结束时取消 WebSocket
	ctx, cancel := context.WithCancel(context.Background())

	client := &WebSocketClient{
		hub:    h.hub,
		conn:   conn,
		send:   make(chan []byte, 256),
		id:     clientID,
		ctx:    ctx,
		cancel: cancel,
	}

	// 注册客户端
	h.hub.register <- client

	// 在单独的 goroutine 中启动读写泵
	go client.writePump()
	go client.readPump()

	// 向新客户端发送初始统计更新
	go func() {
		time.Sleep(100 * time.Millisecond) // 小延迟以确保客户端准备就绪
		stats, err := h.hub.statsService.GetStatistics()
		if err == nil {
			msg := StatsUpdateMessage{
				Type:  MessageTypeStatsUpdate,
				Stats: stats,
			}
			if data, err := json.Marshal(msg); err == nil {
				select {
				case client.send <- data:
				default:
				}
			}
		}

	}()
}

// generateClientID 生成唯一的客户端 ID
func generateClientID() string {
	return time.Now().Format("20060102150405.000000")
}

func extractWSToken(r *http.Request) string {
	token := strings.TrimSpace(r.Header.Get("X-Local-Auth"))
	if token != "" {
		return token
	}

	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[len("Bearer "):])
	}

	return strings.TrimSpace(r.URL.Query().Get("token"))
}

// ServeWs 是用于处理 WebSocket 请求的便捷函数
// 可以直接用作 http.HandlerFunc
func ServeWs(w http.ResponseWriter, r *http.Request) {
	handler := NewWebSocketHandler()
	handler.HandleWebSocket(w, r)
}

package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"wx_channel/internal/config"
	"wx_channel/internal/utils"

	"github.com/qtgolang/SunnyNet/SunnyNet"
)

// CommentHandler 评论数据处理器
type CommentHandler struct {
}

// NewCommentHandler 创建评论处理器
func NewCommentHandler(cfg *config.Config) *CommentHandler {
	return &CommentHandler{}
}

// getConfig 获取当前配置（动态获取最新配置）
func (h *CommentHandler) getConfig() *config.Config {
	return config.Get()
}

// Handle implements router.Interceptor
func (h *CommentHandler) Handle(Conn *SunnyNet.HttpConn) bool {
	// 处理保存评论数据
	if h.HandleSaveCommentData(Conn) {
		return true
	}
	// 处理保存原始评论API数据
	if h.HandleSaveRawCommentAPI(Conn) {
		return true
	}
	return false
}

// HandleSaveRawCommentAPI 处理保存原始评论API数据
func (h *CommentHandler) HandleSaveRawCommentAPI(Conn *SunnyNet.HttpConn) bool {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/save_raw_comment_api" {
		return false
	}

	utils.LogInfo("[原始评论API] 收到保存请求")

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		utils.HandleError(err, "读取原始评论API请求体")
		return true
	}
	defer Conn.Request.Body.Close()

	if len(body) == 0 {
		utils.Warn("原始评论API请求体为空")
		return true
	}

	// 保存原始数据
	if err := h.saveRawCommentAPIData(body); err != nil {
		utils.HandleError(err, "保存原始评论API数据")
	}

	// 返回成功
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	Conn.Response.Body = io.NopCloser(strings.NewReader(`{"success":true}`))
	return true
}

// saveRawCommentAPIData 保存原始评论API数据到文件
func (h *CommentHandler) saveRawCommentAPIData(data []byte) error {
	// 获取基础目录
	baseDir, err := utils.GetBaseDir()
	if err != nil {
		return fmt.Errorf("获取基础目录失败: %v", err)
	}

	// 创建原始API数据目录
	rawDataDir := filepath.Join(baseDir, h.getConfig().DownloadsDir, "comment_data", "raw_api")
	if err := utils.EnsureDir(rawDataDir); err != nil {
		return fmt.Errorf("创建原始API数据目录失败: %v", err)
	}

	// 生成文件名
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	fileName := "raw_comment_api_" + timestamp + ".json"
	targetPath := filepath.Join(rawDataDir, fileName)

	// 保存文件
	if err := os.WriteFile(targetPath, data, 0644); err != nil {
		return fmt.Errorf("保存原始API数据失败: %v", err)
	}

	utils.LogInfo("[原始评论API] 已保存: %s", fileName)
	return nil
}

// HandleSaveCommentData 处理保存评论数据请求
func (h *CommentHandler) HandleSaveCommentData(Conn *SunnyNet.HttpConn) bool {
	path := Conn.Request.URL.Path
	if path != "/__wx_channels_api/save_comment_data" {
		return false
	}

	// 授权校验
	if h.getConfig() != nil && h.getConfig().SecretToken != "" {
		if Conn.Request.Header.Get("X-Local-Auth") != h.getConfig().SecretToken {
			// 记录认证失败
			clientIP := Conn.Request.RemoteAddr
			utils.LogAuthFailed(path, clientIP)
			headers := http.Header{}
			headers.Set("Content-Type", "application/json")
			headers.Set("X-Content-Type-Options", "nosniff")
			Conn.StopRequest(401, `{"success":false,"error":"unauthorized"}`, headers)
			return true
		}
	}

	// CORS校验
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		if origin != "" {
			allowed := false
			for _, o := range h.getConfig().AllowedOrigins {
				if o == origin {
					allowed = true
					break
				}
			}
			if !allowed {
				// 记录CORS拦截
				utils.LogCORSBlocked(origin, path)
				headers := http.Header{}
				headers.Set("Content-Type", "application/json")
				headers.Set("X-Content-Type-Options", "nosniff")
				Conn.StopRequest(403, `{"success":false,"error":"forbidden_origin"}`, headers)
				return true
			}
		}
	}

	var requestData struct {
		Comments               []map[string]interface{} `json:"comments"`
		VideoID                string                   `json:"videoId"`
		VideoTitle             string                   `json:"videoTitle"`
		OriginalCommentCount   int                      `json:"originalCommentCount"`
		Timestamp              int64                    `json:"timestamp"`
		RawAPIData             map[string]interface{}   `json:"rawApiData"` // 新增：原始API数据
		// 新增：作者信息
		AuthorID               string                   `json:"authorId"`
		AuthorNickname         string                   `json:"authorNickname"`
		ProfileURL             string                   `json:"profileUrl"`
		Username              string                   `json:"username"` // 视频号ID
	}

	body, err := io.ReadAll(Conn.Request.Body)
	if err != nil {
		utils.HandleError(err, "读取save_comment_data请求体")
		h.sendErrorResponse(Conn, err)
		return true
	}

	if err := Conn.Request.Body.Close(); err != nil {
		utils.HandleError(err, "关闭请求体")
	}

	// 检查body是否为空
	if len(body) == 0 {
		utils.Warn("save_comment_data请求体为空，跳过处理")
		h.sendEmptyResponse(Conn)
		return true
	}

	if err := json.Unmarshal(body, &requestData); err != nil {
		utils.HandleError(err, "解析评论数据")
		h.sendErrorResponse(Conn, err)
		return true
	}

	// 保存评论数据
	if err := h.saveCommentData(requestData.Comments, requestData.VideoID, requestData.VideoTitle, requestData.OriginalCommentCount, requestData.Timestamp, requestData.RawAPIData, requestData.AuthorID, requestData.AuthorNickname, requestData.ProfileURL, requestData.Username); err != nil {
		utils.HandleError(err, "保存评论数据")
		h.sendErrorResponse(Conn, err)
		return true
	}

	h.sendEmptyResponse(Conn)
	return true
}

// saveCommentData 保存评论数据到文件
func (h *CommentHandler) saveCommentData(comments []map[string]interface{}, videoID, videoTitle string, originalCommentCount int, timestamp int64, rawAPIData map[string]interface{}, authorID, authorNickname, profileURL, username string) error {
	if len(comments) == 0 {
		return nil
	}

	// 获取基础目录
	baseDir, err := utils.GetBaseDir()
	if err != nil {
		return fmt.Errorf("获取基础目录失败: %v", err)
	}

	// 创建评论数据目录
	downloadsDir := filepath.Join(baseDir, h.getConfig().DownloadsDir)
	commentDataRoot := filepath.Join(downloadsDir, "comment_data")
	if err := utils.EnsureDir(commentDataRoot); err != nil {
		return fmt.Errorf("创建评论数据根目录失败: %v", err)
	}

	// 按日期组织目录
	saveTime := time.Now()
	if timestamp > 0 {
		saveTime = time.Unix(0, timestamp*int64(time.Millisecond))
	}

	dateDir := filepath.Join(commentDataRoot, saveTime.Format("2006-01-02"))
	if err := utils.EnsureDir(dateDir); err != nil {
		return fmt.Errorf("创建评论数据日期目录失败: %v", err)
	}

	// 复用视频文件命名规则，确保评论导出和视频保存风格一致
	baseName := utils.GenerateVideoFilename(videoTitle, videoID)
	baseName = strings.TrimSuffix(baseName, filepath.Ext(baseName))
	fileName := baseName + ".json"

	targetPath := utils.GenerateUniqueFilename(dateDir, fileName, 100)

	// 计算实际总评论数（一级 + 二级）
	totalComments := len(comments)
	for _, comment := range comments {
		if levelTwo, ok := comment["levelTwoComment"].([]interface{}); ok {
			totalComments += len(levelTwo)
		}
	}

	// 构建数据结构
	commentData := map[string]interface{}{
		"videoId":              videoID,
		"videoTitle":           videoTitle,
		"comments":             comments,
		"commentCount":         totalComments,
		"originalCommentCount": originalCommentCount,
		"saved_at":             saveTime.Format(time.RFC3339),
		"timestamp":            timestamp,
		"rawApiData":           rawAPIData, // 保存原始API数据
		// 新增：作者信息
		"authorId":             authorID,
		"authorNickname":       authorNickname,
		"profileUrl":           profileURL,
		"username":             username, // 视频号ID
	}

	// 保存JSON数据
	dataBytes, err := json.MarshalIndent(commentData, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化评论数据失败: %v", err)
	}

	if err := os.WriteFile(targetPath, dataBytes, 0644); err != nil {
		return fmt.Errorf("保存评论数据文件失败: %v", err)
	}

	relativePath, err := filepath.Rel(downloadsDir, targetPath)
	if err != nil {
		relativePath = targetPath
	}

	if originalCommentCount > 0 {
		utils.Info("评论数据已保存: %s (%d/%d条评论) -> %s", videoTitle, totalComments, originalCommentCount, relativePath)
		utils.LogInfo("[评论保存] 标题=%s | 采集=%d | 原始=%d | 路径=%s", videoTitle, totalComments, originalCommentCount, relativePath)
	} else {
		utils.Info("评论数据已保存: %s (%d条评论) -> %s", videoTitle, totalComments, relativePath)
		utils.LogInfo("[评论保存] 标题=%s | 采集=%d | 路径=%s", videoTitle, totalComments, relativePath)
	}

	// 记录详细评论采集日志
	utils.LogComment(videoID, videoTitle, totalComments, true)

	return nil
}

// sendEmptyResponse 发送空JSON响应
func (h *CommentHandler) sendEmptyResponse(Conn *SunnyNet.HttpConn) {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Content-Type-Options", "nosniff")

	// CORS
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		if origin != "" {
			for _, o := range h.getConfig().AllowedOrigins {
				if o == origin {
					headers.Set("Access-Control-Allow-Origin", origin)
					headers.Set("Vary", "Origin")
					headers.Set("Access-Control-Allow-Headers", "Content-Type, X-Local-Auth")
					headers.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
					break
				}
			}
		}
	}

	headers.Set("__debug", "fake_resp")
	Conn.StopRequest(200, `{"success":true}`, headers)
}

// sendErrorResponse 发送错误响应
func (h *CommentHandler) sendErrorResponse(Conn *SunnyNet.HttpConn, err error) {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Content-Type-Options", "nosniff")

	// CORS
	if h.getConfig() != nil && len(h.getConfig().AllowedOrigins) > 0 {
		origin := Conn.Request.Header.Get("Origin")
		if origin != "" {
			for _, o := range h.getConfig().AllowedOrigins {
				if o == origin {
					headers.Set("Access-Control-Allow-Origin", origin)
					headers.Set("Vary", "Origin")
					headers.Set("Access-Control-Allow-Headers", "Content-Type, X-Local-Auth")
					headers.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
					break
				}
			}
		}
	}

	errorMsg := fmt.Sprintf(`{"success":false,"error":"%s"}`, err.Error())
	Conn.StopRequest(500, errorMsg, headers)
}

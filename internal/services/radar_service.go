package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"wx_channel/internal/database"
	"wx_channel/internal/utils"
	"wx_channel/internal/websocket"
)

// RadarService 定时检测对标账号的新作品并记录结果。
// Requirements: Competitor 24-hour Silent Radar
type RadarService struct {
	repo *database.RadarRepository
	hub  *websocket.Hub

	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	wg     sync.WaitGroup

	ticker *time.Ticker
}

// NewRadarService 创建一个新的雷达服务
func NewRadarService(repo *database.RadarRepository, hub *websocket.Hub) *RadarService {
	ctx, cancel := context.WithCancel(context.Background())
	return &RadarService{
		repo:   repo,
		hub:    hub,
		ctx:    ctx,
		cancel: cancel,
	}
}

func (s *RadarService) processTarget(target database.RadarTarget) {
	now := time.Now()
	if err := s.repo.UpdateLastCheckTime(target.ID, now); err != nil {
		utils.LogError("[Radar] 更新检测时间失败: %v", err)
		return
	}
	entry := &database.RadarLog{TargetID: target.ID, CheckTime: now, Status: "success"}
	defer func() {
		if err := s.repo.AddLog(entry); err != nil {
			utils.LogError("[Radar] 保存检测结果失败: %v", err)
		}
	}()
	data, err := s.hub.CallAPI("key:channels:feed_list", websocket.FeedListBody{Username: target.Username}, 30*time.Second)
	if err != nil {
		entry.Status, entry.ErrorMessage = "error", err.Error()
		return
	}
	var result struct {
		Data struct {
			BaseResponse struct {
				Ret int `json:"Ret"`
			} `json:"BaseResponse"`
			ObjectList []map[string]interface{} `json:"objectList"`
			Object     []map[string]interface{} `json:"object"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		entry.Status, entry.ErrorMessage = "error", err.Error()
		return
	}
	if result.Data.BaseResponse.Ret != 0 {
		entry.Status = "error"
		entry.ErrorMessage = fmt.Sprintf("微信接口返回失败: %d", result.Data.BaseResponse.Ret)
		return
	}
	objects := result.Data.ObjectList
	if len(objects) == 0 {
		objects = result.Data.Object
	}
	entry.FoundVideos = len(objects)
	summaries := make([]database.RadarVideoSummary, 0, len(objects))
	for _, object := range objects {
		id, ok := object["id"]
		if !ok || id == nil || id == "" {
			continue
		}
		videoID := fmt.Sprint(id)
		title := videoID
		if desc, ok := object["objectDesc"].(map[string]interface{}); ok {
			if value, ok := desc["description"].(string); ok && value != "" {
				title = value
			}
		}
		isNew, err := s.repo.RecordSeenVideo(target.ID, videoID)
		if err != nil {
			entry.Status, entry.ErrorMessage = "error", err.Error()
			break
		}
		if isNew {
			entry.NewVideos++
		}
		summaries = append(summaries, database.RadarVideoSummary{VideoID: videoID, Title: title, IsNew: isNew})
	}
	encoded, _ := json.Marshal(summaries)
	entry.VideoList = string(encoded)
}

// Start 启动雷达服务轮询器
func (s *RadarService) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ticker != nil {
		return // 已启动
	}
	if s.ctx == nil || s.ctx.Err() != nil {
		s.ctx, s.cancel = context.WithCancel(context.Background())
	}

	// 默认每分钟检查一次，但实际是否触发取决于每个 target 的 interval_minutes
	s.ticker = time.NewTicker(time.Minute)
	s.wg.Add(1)

	go func() {
		defer s.wg.Done()
		utils.LogInfo("Radar Service (24h静默雷达) 已启动")

		// 启动时立即执行一次检测（延迟10秒，等待WebSocket连接建立）
		time.Sleep(10 * time.Second)
		s.checkTargets()

		for {
			select {
			case <-s.ctx.Done():
				utils.LogInfo("Radar Service 已停止")
				return
			case <-s.ticker.C:
				s.checkTargets()
			}
		}
	}()
}

// Stop 停止雷达服务
func (s *RadarService) Stop() {
	s.mu.Lock()
	if s.ticker == nil {
		s.mu.Unlock()
		return
	}
	cancel := s.cancel
	ticker := s.ticker
	if s.ticker != nil {
		s.ticker = nil
	}
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if ticker != nil {
		ticker.Stop()
	}
	s.wg.Wait()
}

// checkTargets 遍历并检查所有活动的雷达目标
func (s *RadarService) checkTargets() {
	targets, err := s.repo.GetActive()
	if err != nil {
		utils.LogError("获取活动雷达目标失败: %v", err)
		return
	}

	if len(targets) == 0 {
		return
	}

	now := time.Now()
	hasClient := s.hub.ClientCount() > 0

	for _, target := range targets {
		// 检查是否到了该检测的时间
		if target.LastCheckTime != nil {
			elapsed := now.Sub(*target.LastCheckTime)
			if elapsed < time.Duration(target.IntervalMinutes)*time.Minute {
				continue // 还没到时间
			}
		}

		if !hasClient {
			// 更新最后检测时间
			_ = s.repo.UpdateLastCheckTime(target.ID, now)
			// 插入错误日志
			_ = s.repo.AddLog(&database.RadarLog{
				TargetID:     target.ID,
				CheckTime:    now,
				Status:       "error",
				ErrorMessage: "微信客户端未连接或被关闭，请重新注入",
			})
			continue // 跳过实际检测
		}

		// 执行检测
		s.processTarget(target)
	}
}

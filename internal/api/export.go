package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"wx_channel/internal/response"
	"wx_channel/internal/services"
)

type ExportAPI struct {
	service *services.ExportService
}

func NewExportAPI() *ExportAPI {
	return &ExportAPI{
		service: services.NewExportService(),
	}
}

// HandleExportBrowseHistory 导出浏览历史
func (h *ExportAPI) HandleExportBrowseHistory(w http.ResponseWriter, r *http.Request) {
	// 解析格式（默认 csv）
	formatStr := r.URL.Query().Get("format")
	if formatStr == "" {
		formatStr = "csv"
	}

	// 解析 ID（可选）
	var ids []string
	if r.Method == http.MethodGet {
		idsStr := r.URL.Query().Get("ids")
		if idsStr != "" {
			ids = strings.Split(idsStr, ",")
		}
	} else if r.Method == http.MethodPost {
		var req struct {
			IDs    []string `json:"ids"`
			Format string   `json:"format"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			if len(req.IDs) > 0 {
				ids = req.IDs
			}
			if req.Format != "" {
				formatStr = req.Format
			}
		}
	} else {
		response.ErrorWithStatus(w, http.StatusMethodNotAllowed, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	// 确定格式
	format := services.ExportFormat(strings.ToLower(formatStr))
	if format != services.ExportFormatCSV && format != services.ExportFormatJSON {
		format = services.ExportFormatCSV
	}

	// 执行导出
	result, err := h.service.ExportBrowseHistory(format, ids)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 设置文件下载响应头
	w.Header().Set("Content-Type", result.ContentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", result.Filename))
	w.WriteHeader(http.StatusOK)
	w.Write(result.Data)
}

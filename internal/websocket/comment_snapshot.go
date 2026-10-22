package websocket

import (
	"fmt"
	"strings"
	"time"

	json "github.com/json-iterator/go"
)

// Register before dispatch: duplicate POSTs must never create another page loop.
func (h *Hub) StartCommentSnapshot(req DOMActionBody) error {
	if req.TaskID == "" || req.CollectionID == "" {
		return fmt.Errorf("snapshot task and collection are required")
	}
	page, err := h.BindCommentPage(req)
	if err != nil {
		return err
	}
	h.commentSnapshotStatusMu.Lock()
	if previous := h.commentSnapshotStatus[req.TaskID]; previous != nil {
		h.commentSnapshotStatusMu.Unlock()
		if previous.CollectionID != req.CollectionID || previous.PageInstanceID != page.PageInstanceID {
			return fmt.Errorf("snapshot owner mismatch")
		}
		return nil
	}
	h.commentSnapshotStatus[req.TaskID] = &CommentSnapshotStatus{CollectionID: req.CollectionID, PageInstanceID: page.PageInstanceID, URL: page.Href, Message: "采集中", UpdatedAt: time.Now().Unix()}
	h.commentSnapshotStatusMu.Unlock()
	req.Action, req.URL, req.PageInstanceID = "start_comment_snapshot", page.Href, page.PageInstanceID
	// A lost ACK leaves the task pending; only its page can confirm completion/stop.
	data, err := h.CallCommentFetch(req, 5*time.Second)
	if err != nil {
		return err
	}
	var ack struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &ack) == nil && !ack.Success {
		status := h.GetCommentSnapshotStatus(req.TaskID)
		status.Done, status.Stopped, status.StopReason, status.Message = true, true, "start_rejected", ack.Message
		h.SetCommentSnapshotStatus(req.TaskID, status)
	}
	return nil
}

func (h *Hub) StopMissionCommentSnapshots(missionID string) error {
	prefix := "sph_" + missionID + "_"
	h.commentSnapshotStatusMu.RLock()
	var ids []string
	for id := range h.commentSnapshotStatus {
		if strings.HasPrefix(id, prefix) {
			ids = append(ids, id)
		}
	}
	h.commentSnapshotStatusMu.RUnlock()
	for _, id := range ids {
		if err := h.StopCommentSnapshot(id); err != nil {
			return err
		}
	}
	return nil
}

func (h *Hub) StopCommentSnapshot(taskID string) error {
	status := h.GetCommentSnapshotStatus(taskID)
	if status == nil {
		return fmt.Errorf("unknown snapshot task")
	}
	if status.Done && status.Stopped {
		return nil
	}
	if status.CollectionID == "" {
		return fmt.Errorf("legacy snapshot requires verified window cleanup")
	}
	data, err := h.CallCommentFetch(DOMActionBody{Action: "stop_comment_snapshot", TaskID: taskID, CollectionID: status.CollectionID, PageInstanceID: status.PageInstanceID, URL: status.URL}, 5*time.Second)
	if err != nil {
		return err
	}
	var ack struct {
		Success bool `json:"success"`
		Stopped bool `json:"stopped"`
	}
	if err := json.Unmarshal(data, &ack); err != nil || !ack.Success || !ack.Stopped {
		return fmt.Errorf("snapshot stop not acknowledged")
	}
	status.Done, status.Success, status.Stopped, status.Complete = true, false, true, false
	status.StopReason, status.Message = "cancelled", "采集已停止"
	h.SetCommentSnapshotStatus(taskID, status)
	return nil
}

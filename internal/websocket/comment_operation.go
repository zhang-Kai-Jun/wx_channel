package websocket

import (
	"crypto/sha256"
	"fmt"
	"strconv"
	"strings"
	"time"

	json "github.com/json-iterator/go"
	"wx_channel/internal/utils"
)

const commentOperationTTL = 15 * time.Minute

type CommentOperationResult struct {
	OperationID string          `json:"operation_id"`
	Status      string          `json:"status"`
	Result      json.RawMessage `json:"result,omitempty"`
	Message     string          `json:"message,omitempty"`
}

type commentOperation struct {
	CommentOperationResult
	fingerprint [32]byte
	expiresAt   time.Time
}

func (h *Hub) StartCommentOperation(id string, body DOMActionBody) error {
	return h.startCommentOperation(id, body, func() (json.RawMessage, error) {
		return h.CallAPI("key:channels:dom_action", body, 60*time.Second)
	})
}

func (h *Hub) startCommentOperation(id string, body DOMActionBody, run func() (json.RawMessage, error)) error {
	parts := strings.SplitN(id, "_", 3)
	if len(parts) != 3 || parts[0] != "comment" || len(parts[2]) < 16 || len(id) > 128 || body.Action != "do_comment" {
		return fmt.Errorf("invalid comment operation ID or action")
	}
	stamp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid comment operation timestamp")
	}
	created := time.UnixMilli(stamp)
	now := time.Now()
	// Expired IDs cannot be replayed after their result has been evicted.
	if now.Sub(created) > commentOperationTTL || created.After(now.Add(time.Minute)) {
		return fmt.Errorf("comment operation ID expired or in the future")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	fingerprint := sha256.Sum256(encoded)
	h.commentOperationsMu.Lock()
	defer h.commentOperationsMu.Unlock()
	if h.commentOperations == nil {
		h.commentOperations = make(map[string]*commentOperation)
	}
	for key, op := range h.commentOperations {
		if op.Status != "pending" && now.After(op.expiresAt) {
			delete(h.commentOperations, key)
		}
	}
	if old := h.commentOperations[id]; old != nil {
		if old.fingerprint != fingerprint {
			return fmt.Errorf("comment operation ID already used with different parameters")
		}
		return nil
	}
	op := &commentOperation{
		CommentOperationResult: CommentOperationResult{OperationID: id, Status: "pending"},
		fingerprint:            fingerprint,
		expiresAt:              created.Add(commentOperationTTL),
	}
	h.commentOperations[id] = op
	go func() {
		outcome := CommentOperationResult{OperationID: id, Status: "unknown"}
		started := time.Now()
		defer func() {
			if r := recover(); r != nil {
				outcome.Message = fmt.Sprintf("comment operation panic: %v", r)
			}
			h.commentOperationsMu.Lock()
			op.CommentOperationResult = outcome
			h.commentOperationsMu.Unlock()
			utils.LogInfo("[CommentOperation] operation_id=%s status=%s duration=%v message=%s", id, outcome.Status, time.Since(started), outcome.Message)
		}()
		data, err := run()
		if err != nil {
			outcome.Message = err.Error()
			return
		}
		var result struct {
			Success       *bool `json:"success"`
			ResultUnknown bool  `json:"resultUnknown"`
		}
		if json.Unmarshal(data, &result) != nil || result.Success == nil || result.ResultUnknown {
			outcome.Message = "comment returned no definite result"
			return
		}
		outcome.Status = "completed"
		outcome.Result = append(json.RawMessage(nil), data...)
	}()
	return nil
}

func (h *Hub) GetCommentOperation(id string) CommentOperationResult {
	h.commentOperationsMu.Lock()
	defer h.commentOperationsMu.Unlock()
	op := h.commentOperations[id]
	if op == nil {
		return CommentOperationResult{OperationID: id, Status: "missing"}
	}
	if op.Status != "pending" && time.Now().After(op.expiresAt) {
		delete(h.commentOperations, id)
		return CommentOperationResult{OperationID: id, Status: "missing"}
	}
	result := op.CommentOperationResult
	result.Result = append(json.RawMessage(nil), result.Result...)
	return result
}

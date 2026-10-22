package diagnostics

import (
	"encoding/binary"
	"time"
)

// SessionSample 只记录会话可用性，不读取用户、窗口标题或输入内容。
type SessionSample struct {
	State                   string `json:"state"`
	SessionID               uint32 `json:"session_id"`
	StateDurationMS         int64  `json:"state_duration_ms"`
	PreviousState           string `json:"previous_state,omitempty"`
	PreviousStateDurationMS int64  `json:"previous_state_duration_ms,omitempty"`
	ProbeError              string `json:"probe_error,omitempty"`
}

// WTSINFOEX 的 Level 1 联合体从偏移 8 开始；只读取会话编号和锁屏标志。
func decodeSessionInfo(data []byte) SessionSample {
	sample := SessionSample{State: "unavailable"}
	if len(data) < 20 || binary.LittleEndian.Uint32(data) != 1 {
		sample.ProbeError = "invalid_wts_info"
		return sample
	}
	sample.SessionID = binary.LittleEndian.Uint32(data[8:])
	switch binary.LittleEndian.Uint32(data[16:]) {
	case 0:
		sample.State = "locked"
	case 1:
		sample.State = "unlocked"
	default:
		sample.ProbeError = "unknown_session_flags"
	}
	return sample
}

type sessionTracker struct {
	previous   SessionSample
	stateSince time.Time
	reportedAt time.Time
}

func (tracker *sessionTracker) observe(sample SessionSample, now time.Time) (SessionSample, bool) {
	changed := tracker.stateSince.IsZero() || sample.State != tracker.previous.State || sample.SessionID != tracker.previous.SessionID
	if changed {
		if !tracker.stateSince.IsZero() {
			sample.PreviousState = tracker.previous.State
			sample.PreviousStateDurationMS = now.Sub(tracker.stateSince).Milliseconds()
		}
		tracker.stateSince = now
	}
	sample.StateDurationMS = now.Sub(tracker.stateSince).Milliseconds()
	tracker.previous = sample
	if !changed && now.Sub(tracker.reportedAt) < 30*time.Second {
		return sample, false
	}
	tracker.reportedAt = now
	return sample, true
}

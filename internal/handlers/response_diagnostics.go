package handlers

import (
	"time"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"wx_channel/internal/utils"
)

// 仅测量业务响应回调内的处理；SunnyNet 在回调前缓冲正文的耗时不在此范围。
type responseRewriteTiming struct {
	started      time.Time
	read         time.Duration
	decode       time.Duration
	rawBytes     int
	decodedBytes int
	failure      string
}

func (t *responseRewriteTiming) decodeBody(encoding string, raw []byte) ([]byte, bool, error) {
	if t == nil {
		return decodeResponseBody(encoding, raw)
	}
	started := time.Now()
	body, compressed, err := decodeResponseBody(encoding, raw)
	t.decode += time.Since(started)
	t.decodedBytes = len(body)
	if err != nil {
		t.failure = "decode_error"
	}
	return body, compressed, err
}

func (t *responseRewriteTiming) log(conn *SunnyNet.HttpConn, host, path string, modified bool) {
	total := time.Since(t.started)
	if total <= 500*time.Millisecond {
		return
	}
	// rewrite 包含正文读入、解压之外的改写、注入和同步日志/可选文件保存。
	rewrite := total - t.read - t.decode
	utils.LogFileInfo("[Perf][response_rewrite] request_id=%d host=%q path=%q total_ms=%d read_ms=%d decode_ms=%d rewrite_ms=%d raw_bytes=%d decoded_bytes=%d modified=%t error=%q",
		conn.MessageId, host, path, total.Milliseconds(), t.read.Milliseconds(), t.decode.Milliseconds(), rewrite.Milliseconds(),
		t.rawBytes, t.decodedBytes, modified, t.failure)
}

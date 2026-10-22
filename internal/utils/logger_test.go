package utils

import (
	"bytes"
	"io"
	"os"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestAsyncStdoutWriterDoesNotBlockOnSaturatedOrClosedQueue(t *testing.T) {
	for _, closed := range []bool{false, true} {
		name := "saturated"
		if closed {
			name = "closed"
		}
		t.Run(name, func(t *testing.T) {
			reader, output, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer output.Close()
			previous := os.Stdout
			os.Stdout = output
			defer func() { os.Stdout = previous }()

			writer := &asyncStdoutWriter{out: output, ch: make(chan []byte, 1), done: make(chan struct{})}
			writer.ch <- []byte("queued")
			if closed {
				writer.Close()
			}
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				_, _ = writer.Write(bytes.Repeat([]byte("x"), 1024*1024))
			}()
			blocked := false
			select {
			case <-finished:
			case <-time.After(time.Second):
				blocked = true
			}
			// 关闭管道可释放旧实现中的阻塞写，避免测试遗留协程。
			output.Close()
			<-finished
			if blocked {
				t.Fatal("业务调用被控制台写入阻塞")
			}
		})
	}
}

func TestAsyncStdoutWriterOwnsQueuedBytes(t *testing.T) {
	writer := &asyncStdoutWriter{ch: make(chan []byte, 1), done: make(chan struct{})}
	input := []byte("original")
	if n, err := writer.Write(input); n != len(input) || err != nil {
		t.Fatalf("Write = %d, %v", n, err)
	}
	copy(input, "modified")
	if got := string(<-writer.ch); got != "original" {
		t.Fatalf("调用方复用缓冲区改坏了排队日志: %q", got)
	}
}

func TestSaturatedConsoleQueueRetainsFileLog(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "logger-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	writer := &asyncStdoutWriter{ch: make(chan []byte, 1), done: make(chan struct{})}
	writer.ch <- []byte("queued")
	logger := zerolog.New(zerolog.MultiLevelWriter(file, writer))
	logger.Log().Msg("file log survives backpressure")
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("file log survives backpressure")) {
		t.Fatalf("文件日志丢失: %s", data)
	}
}

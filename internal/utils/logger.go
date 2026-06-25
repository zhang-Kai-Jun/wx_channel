package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// LogLevel 日志级别
type LogLevel int

const (
	DEBUG LogLevel = iota
	INFO
	WARN
	ERROR
)

var (
	// 保持对外的 Logger 结构，但内部换成 zerolog
	defaultLogger *Logger
	once          sync.Once
)

// Logger 封装 zerolog
type Logger struct {
	mu         sync.Mutex
	zLogger    zerolog.Logger
	fileLogger zerolog.Logger
	file       *os.File
	minLevel   LogLevel

	// 异步 stdout 写入器，解决 Windows 控制台缓冲区满时 WriteFile 阻塞导致 goroutine 卡死的问题
	asyncStdout *asyncStdoutWriter
}

// asyncStdoutWriter 异步写 stdout，写入方永远不阻塞。
//
// zerolog ConsoleWriter.Write() 接收完整一行（已含 \n），调用 buf.WriteTo(w.Out)。
// 若 w.Out.Write() 阻塞 goroutine，ConsoleWriter.Write() 卡在 buf.WriteTo() 里，
// MultiLevelWriter.mu 不释放，导致所有日志 goroutine 全被 mutex 堵死。
//
// 解决：Write() 永远不走阻塞 send。只尝试一次 non-blocking send；
// channel 满则直接写 stdout（临时慢速由 writeLoop 独自承担）。
// goroutine 毫秒级退出，MultiLevelWriter.mu 迅速释放。
type asyncStdoutWriter struct {
	out  *os.File
	ch   chan []byte
	done chan struct{}
}

func newAsyncStdoutWriter(bufSize int) *asyncStdoutWriter {
	w := &asyncStdoutWriter{
		out:  os.Stdout,
		ch:   make(chan []byte, bufSize),
		done: make(chan struct{}),
	}
	go w.writeLoop()
	return w
}

// Write 接收 ConsoleWriter 传来的一整行，非阻塞写出，永远不卡住调用方。
func (w *asyncStdoutWriter) Write(p []byte) (n int, err error) {
	select {
	case w.ch <- p:
	case <-w.done:
		os.Stdout.Write(p)
	default:
		// channel 满了直接写 stdout，不等待
		os.Stdout.Write(p)
	}
	return len(p), nil
}

func (w *asyncStdoutWriter) writeLoop() {
	for {
		select {
		case p := <-w.ch:
			if len(p) > 0 {
				os.Stdout.Write(p)
			}
		case <-w.done:
			for len(w.ch) > 0 {
				p := <-w.ch
				if len(p) > 0 {
					os.Stdout.Write(p)
				}
			}
			return
		}
	}
}

func (w *asyncStdoutWriter) Close() {
	close(w.done)
}

// InitLoggerWithRotation 初始化带日志轮转的日志系统
func InitLoggerWithRotation(level LogLevel, logFile string, maxSizeMB int) error {
	// 创建日志目录
	logDir := filepath.Dir(logFile)
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return err
	}

	// 检查文件大小，如果超过限制则轮转 (保持原有的简单启动时轮转逻辑)
	if info, err := os.Stat(logFile); err == nil {
		sizeMB := info.Size() / (1024 * 1024)
		if int(sizeMB) >= maxSizeMB {
			timestamp := time.Now().Format("20060102_150405")
			backupFile := fmt.Sprintf("%s.%s", logFile, timestamp)
			_ = os.Rename(logFile, backupFile)
		}
	}

	// 打开日志文件
	file, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}

	// 配置 zerolog
	// 主 logger 只写文件（同步），stdout 走异步 writer（不阻塞主 goroutine）
	fileOutput := zerolog.ConsoleWriter{Out: file, TimeFormat: "2006-01-02 15:04:05", NoColor: true}

	// 设置日志级别
	var zLevel zerolog.Level
	switch level {
	case DEBUG:
		zLevel = zerolog.DebugLevel
	case INFO:
		zLevel = zerolog.InfoLevel
	case WARN:
		zLevel = zerolog.WarnLevel
	case ERROR:
		zLevel = zerolog.ErrorLevel
	default:
		zLevel = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(zLevel)

	// stdout 通过异步 channel 写出，解决 Windows 控制台缓冲区满时 WriteFile 阻塞问题
	asyncOut := newAsyncStdoutWriter(2048)
	stdoutWriter := zerolog.ConsoleWriter{Out: asyncOut, TimeFormat: "2006-01-02 15:04:05"}
	// 主 logger 同时写文件和异步 stdout
	zLog := zerolog.New(zerolog.MultiLevelWriter(fileOutput, stdoutWriter)).With().Timestamp().Logger()
	fLog := zerolog.New(fileOutput).With().Timestamp().Logger()

	defaultLogger = &Logger{
		file:        file,
		zLogger:     zLog,
		fileLogger:  fLog,
		minLevel:    level,
		asyncStdout: asyncOut,
	}

	// 同时替换全局 log，以防甚至第三方库用 log.Print
	log.Logger = zLog

	return nil
}

// GetLogger 获取默认日志记录器
func GetLogger() *Logger {
	if defaultLogger == nil {
		// 默认初始化
		_ = InitLoggerWithRotation(INFO, "logs/wx_channel.log", 5)
	}
	return defaultLogger
}

// SetLevel 设置最小日志级别
func (l *Logger) SetLevel(level LogLevel) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.minLevel = level

	var zLevel zerolog.Level
	switch level {
	case DEBUG:
		zLevel = zerolog.DebugLevel
	case INFO:
		zLevel = zerolog.InfoLevel
	case WARN:
		zLevel = zerolog.WarnLevel
	case ERROR:
		zLevel = zerolog.ErrorLevel
	default:
		zLevel = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(zLevel)
}

// Debug 调试日志
func (l *Logger) Debug(format string, args ...interface{}) {
	// l.zLogger.Debug().Msgf(format, args...)
}

// Info 信息日志
func (l *Logger) Info(format string, args ...interface{}) {
	// l.zLogger.Info().Msgf(format, args...)
}

// Warn 警告日志
func (l *Logger) Warn(format string, args ...interface{}) {
	// l.zLogger.Warn().Msgf(format, args...)
}

// Error 错误日志
func (l *Logger) Error(format string, args ...interface{}) {
	// l.zLogger.Error().Msgf(format, args...)
}

// Close 关闭日志文件
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.asyncStdout != nil {
		l.asyncStdout.Close()
	}
	if l.file != nil {
		return l.file.Close()
	}
	return nil
}

// Info 信息日志
func Info(format string, args ...interface{}) {
	// GetLogger().Info(format, args...)
}

// Warn 警告日志
func Warn(format string, args ...interface{}) {
	// GetLogger().Warn(format, args...)
}

// Error 错误日志
func Error(format string, args ...interface{}) {
	// GetLogger().Error(format, args...)
}

// LogDebug 全局便捷函数
func LogDebug(format string, args ...interface{}) {
	// GetLogger().Debug(format, args...)
}

func LogInfo(format string, args ...interface{}) {
	// GetLogger().Info(format, args...)
}

func LogWarn(format string, args ...interface{}) {
	// GetLogger().Warn(format, args...)
}

func LogError(format string, args ...interface{}) {
	// GetLogger().Error(format, args...)
}

// LogDownload 记录下载操作
func LogDownload(videoID, title, author, url string, size int64, success bool) {
	event := GetLogger().zLogger.Info()
	if !success {
		event = GetLogger().zLogger.Warn()
	}

	status := "成功"
	if !success {
		status = "失败"
	}
	sizeMB := float64(size) / (1024 * 1024)

	// 使用 structured logging 字段
	event.Str("type", "下载").
		Str("status", status).
		Str("id", videoID).
		Str("title", title).
		Str("author", author).
		Float64("size_mb", sizeMB).
		Str("url", url).
		Msgf("[下载] %s | %s", title, status)
}

// LogComment 记录评论采集操作
func LogComment(videoID, title string, commentCount int, success bool) {

}

// LogBatchDownload 记录批量下载操作
func LogBatchDownload(total, success, failed int) {

}

// LogDownloadError 记录下载错误详情
func LogDownloadError(videoID, title, author, url string, err error, retryCount int) {

}

// LogDownloadRetry 记录下载重试
func LogDownloadRetry(videoID, title string, attempt, maxRetries int, err error) {

}

// LogAPI 记录API调用
func LogAPI(method, path string, statusCode int, duration time.Duration) {

}

// LogUploadInit 记录上传初始化
func LogUploadInit(uploadID string, success bool) {

}

// LogUploadChunk 记录分片上传
func LogUploadChunk(uploadID string, index, total int, sizeMB float64, success bool) {

}

// LogUploadMerge 记录分片合并
func LogUploadMerge(uploadID, filename, author string, totalChunks int, sizeMB float64, success bool) {

}

// LogDirectUpload 记录直接上传
func LogDirectUpload(filename, author string, sizeMB float64, encrypted bool, success bool) {

}

// LogCSVOperation 记录CSV操作
func LogCSVOperation(operation, videoID, title string, success bool, reason string) {

}

// LogCSVRebuild 记录CSV重建
func LogCSVRebuild(filePath string, success bool) {

}

// LogSystemStart 记录系统启动
func LogSystemStart(port int, proxyMode string) {

}

// LogSystemShutdown 记录系统关闭
func LogSystemShutdown(reason string) {

}

// LogConfigLoad 记录配置加载
func LogConfigLoad(configPath string, success bool) {
	// status := "成功"
	// if !success {
	// 	status = "失败"
	// }
	// GetLogger().zLogger.Info().
	// 	Str("type", "配置加载").
	// 	Str("path", configPath).
	// 	Str("status", status).
	// 	Msgf("加载配置 %s", status)
}

// LogAuthFailed 记录认证失败
func LogAuthFailed(endpoint, clientIP string) {

}

// LogCORSBlocked 记录CORS拦截
func LogCORSBlocked(origin, endpoint string) {

}

// LogDiskSpace 记录磁盘空间检查
func LogDiskSpace(path string, availableGB, totalGB float64) {

}

// LogConcurrency 记录并发状态
func LogConcurrency(operation string, active, max int) {

}

// LogRetry 记录重试操作
func LogRetry(operation string, attempt, maxAttempts int, err error) {

}

// LogCleanup 记录清理操作
func LogCleanup(operation string, itemsRemoved int, success bool) {

}

// FileInfo 仅记录到文件的信息日志
func (l *Logger) FileInfo(format string, args ...interface{}) {
}

// LogFileInfo 仅记录到文件的信息日志(全局)
func LogFileInfo(format string, args ...interface{}) {
}

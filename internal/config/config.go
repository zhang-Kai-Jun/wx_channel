package config

import (
	"fmt"
	"os"
	"time"

	"wx_channel/internal/utils"
	"wx_channel/internal/version"

	"github.com/spf13/viper"
)

// Config 应用程序配置
type Config struct {
	// 网络配置
	Port        int `mapstructure:"port"`
	DefaultPort int `mapstructure:"default_port"`

	// 应用信息
	Version string `mapstructure:"version"`

	// 文件路径配置
	DataDir  string `mapstructure:"data_dir"`
	CertFile string `mapstructure:"cert_file"`

	// 时间配置
	CertInstallDelay time.Duration `mapstructure:"cert_install_delay"`
	SaveDelay        time.Duration `mapstructure:"save_delay"`

	// 安全配置
	SecretToken     string   `mapstructure:"secret_token"`
	WebConsoleToken string   `mapstructure:"web_console_token"`
	AllowedOrigins  []string `mapstructure:"allowed_origins"`

	// 日志配置
	LogFile      string `mapstructure:"log_file"`
	MaxLogSizeMB int    `mapstructure:"max_log_size_mb"`

	// 保存功能开关
	SavePageSnapshot bool `mapstructure:"save_page_snapshot"`
	SaveSearchData   bool `mapstructure:"save_search_data"`
	SavePageJS       bool `mapstructure:"save_page_js"`

	// UI 功能开关
	ShowLogButton         bool `mapstructure:"show_log_button"`
	EnableLogInterception bool `mapstructure:"enable_log_interception"` // 是否拦截console日志（禁用可节省内存）

	// 第二阶段优化配置
	LoadBalancerStrategy string `mapstructure:"load_balancer_strategy"` // 负载均衡策略: roundrobin, leastconn, weighted, random
	CompressionEnabled   bool   `mapstructure:"compression_enabled"`    // 是否启用数据压缩
	CompressionThreshold int    `mapstructure:"compression_threshold"`  // 压缩阈值（字节），小于此值不压缩

	// 功能开关
	RadarEnabled bool `mapstructure:"radar_enabled"`
}

var globalConfig *Config

// DatabaseConfigLoader 数据库配置加载器接口
type DatabaseConfigLoader interface {
	Get(key string) (string, error)
	GetInt(key string, defaultValue int) (int, error)
	GetInt64(key string, defaultValue int64) (int64, error)
	GetBool(key string, defaultValue bool) (bool, error)
}

var dbLoader DatabaseConfigLoader

// SetDatabaseLoader 设置数据库配置加载器
func SetDatabaseLoader(loader DatabaseConfigLoader) {
	dbLoader = loader
}

// Load 加载配置
// 优先级：数据库配置 > 环境变量 > 配置文件 > 默认值
func Load() *Config {
	if globalConfig == nil {
		globalConfig = loadConfig()
	}
	return globalConfig
}

// Reload 重新加载配置
func Reload() *Config {
	globalConfig = loadConfig()
	return globalConfig
}

// loadConfig 执行实际的配置加载逻辑
func loadConfig() *Config {
	// 设置默认值
	setDefaults()

	// 配置环境变量自动加载
	viper.SetEnvPrefix("WX_CHANNEL")
	viper.AutomaticEnv()
	// 替换环境变量中的点号，但这通常用于嵌套结构，这里是扁平的
	// 如果需要支持 WX_CHANNEL_DATA_DIR 映射到 data_dir，
	// viper 默认会将 key 中的 mapstructure 标签转换为大写并作为 env 查找
	// 但实际上直接绑定通过 SetEnvKeyReplacer 可能更好
	// 这里简单点，依赖 mapstructure

	// 如果没有显式设置配置文件，则设置搜索路径
	if viper.ConfigFileUsed() == "" {
		viper.SetConfigName("config")            // 配置文件名 (不带扩展名)
		viper.SetConfigType("yaml")              // 如果配置文件没有扩展名，则使用 yaml
		viper.AddConfigPath(".")                 // 在当前目录查找
		viper.AddConfigPath("$HOME/.wx_channel") // 在用户主目录查找
	}

	// 尝试读取配置文件
	if err := viper.ReadInConfig(); err != nil {
		// 如果是没找到文件但是也没有显式设置配置文件，则忽略错误（使用默认值）
		// 如果显式设置了配置文件但读取失败，则应该报错?
		// 这里简单处理：只有非 NotFoundError 才打印
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			fmt.Printf("Error reading config file: %s\n", err)
		}
	} else {
		// Log 放在 logger 初始化之后，这里先用 fmt
		// fmt.Println("Using config file:", viper.ConfigFileUsed())
	}

	// 绑定旧的环境变量名以保持兼容性如果需要，但 AutomaticEnv 应该足够
	// 复杂逻辑（如逗号分隔的 string 列表转 slice） Viper 也能处理，只要 env 是 string
	// 但是 AllowedOrigins 是 []string，Viper 会尝试解析 "a,b,c" 吗？
	// 默认情况下 Viper 处理 Slice 需要 config file list，env vars 是空格分隔或 json
	// 为了兼容之前的 "a,b,c"，我们可能需要自定义 hook 或者保留一些手动处理
	// 但为了简化，假设用户接受新标准或我们提供兼容：
	// viper 自带的 env 解析对 slice 支持一般是空格分隔。
	// 这里我们先 Unmarshal 到 struct

	config := &Config{}
	if err := viper.Unmarshal(config); err != nil {
		fmt.Printf("Unable to decode into struct: %v\n", err)
	}
	// 兼容旧配置中的数据存放位置，不再用于保存视频。
	if !viper.InConfig("data_dir") && os.Getenv("WX_CHANNEL_DATA_DIR") == "" {
		if legacyDir := viper.GetString("download_dir"); legacyDir != "" {
			config.DataDir = legacyDir
		}
	}

	// 数据库加载覆盖（保持最高优先级）
	loadFromDatabase(config)

	// Fallback: 确保端口有效
	if config.Port == 0 {
		// 尝试使用 DefaultPort
		if config.DefaultPort != 0 {
			config.Port = config.DefaultPort
		} else {
			config.Port = 2025
		}
	}

	return config
}

func setDefaults() {
	viper.SetDefault("port", 2025)
	viper.SetDefault("default_port", 2025)
	viper.SetDefault("version", version.Current)
	viper.SetDefault("data_dir", "downloads")
	viper.SetDefault("cert_file", "SunnyRoot.cer")

	viper.SetDefault("cert_install_delay", 3*time.Second)
	viper.SetDefault("save_delay", 500*time.Millisecond)

	viper.SetDefault("web_console_token", "@dongzuren")

	viper.SetDefault("log_file", "logs/wx_channel.log")
	viper.SetDefault("max_log_size_mb", 5)

	viper.SetDefault("save_page_snapshot", false)
	viper.SetDefault("save_search_data", false)
	viper.SetDefault("save_page_js", false)
	viper.SetDefault("show_log_button", false)
	viper.SetDefault("enable_log_interception", false) // 默认禁用日志拦截以节省内存

	// 第二阶段优化默认值
	viper.SetDefault("load_balancer_strategy", "leastconn")
	viper.SetDefault("compression_enabled", true)
	viper.SetDefault("compression_threshold", 1024) // 1KB

	// 功能默认值
	viper.SetDefault("radar_enabled", false)
}

// loadFromDatabase 从数据库加载配置（优先级最高）
// 注意：这部分逻辑仍然需要手动处理，因为 viper 不支持直接从自定义 DB 接口加载覆盖
// 除非我们实现一个 viper 的 remote provider
func loadFromDatabase(config *Config) {
	if dbLoader == nil {
		return
	}

	// 数据目录
	if val, err := dbLoader.Get("data_dir"); err == nil && val != "" {
		config.DataDir = val
	}

	// LogFile
	if val, err := dbLoader.Get("log_file"); err == nil && val != "" {
		config.LogFile = val
	}
	// MaxLogSizeMB
	if val, err := dbLoader.GetInt("max_log_size_mb", config.MaxLogSizeMB); err == nil {
		config.MaxLogSizeMB = val
	}
	// Switches
	if val, err := dbLoader.GetBool("save_page_snapshot", config.SavePageSnapshot); err == nil {
		config.SavePageSnapshot = val
	}
	if val, err := dbLoader.GetBool("save_search_data", config.SaveSearchData); err == nil {
		config.SaveSearchData = val
	}
	if val, err := dbLoader.GetBool("save_page_js", config.SavePageJS); err == nil {
		config.SavePageJS = val
	}
	if val, err := dbLoader.GetBool("show_log_button", config.ShowLogButton); err == nil {
		config.ShowLogButton = val
	}
	if val, err := dbLoader.GetBool("enable_log_interception", config.EnableLogInterception); err == nil {
		config.EnableLogInterception = val
	}

	if val, err := dbLoader.GetBool("radar_enabled", config.RadarEnabled); err == nil {
		config.RadarEnabled = val
	}
}

// Get 获取全局配置
func Get() *Config {
	if globalConfig == nil {
		return Load()
	}
	return globalConfig
}

// SetPort 设置端口
func (c *Config) SetPort(port int) {
	c.Port = port
	// 更新 viper 中的值以便保持一致（可选）
	viper.Set("port", port)
}

// GetDataDir 获取数据目录
func (c *Config) GetDataDir() string {
	return c.DataDir
}

// GetResolvedDataDir 获取解析后的数据目录路径
func (c *Config) GetResolvedDataDir() (string, error) {
	return utils.ResolveDataDir(c.DataDir)
}

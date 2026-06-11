package config

import (
	"log"

	"github.com/spf13/viper"
)

// Config 应用配置
type Config struct {
	Server   ServerConfig   `mapstructure:"server"`
	Database DatabaseConfig `mapstructure:"database"`
	GRPC     GRPCConfig     `mapstructure:"grpc"`
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Port int    `mapstructure:"port"`
	Mode string `mapstructure:"mode"`
}

// DatabaseConfig 数据库配置
type DatabaseConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	Username string `mapstructure:"username"`
	Password string `mapstructure:"password"`
	DBName   string `mapstructure:"dbname"`
}

// GRPCConfig gRPC配置
type GRPCConfig struct {
	Port int `mapstructure:"port"`
}

// LoadConfig 加载配置
func LoadConfig(path string) (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(path)
	viper.AutomaticEnv()

	if err := viper.ReadInConfig(); err != nil {
		log.Printf("Warning: config file not found, using defaults: %v", err)
		return &Config{
			Server: ServerConfig{
				Port: 8080,
				Mode: "debug",
			},
			Database: DatabaseConfig{
				Host:     "localhost",
				Port:     3306,
				Username: "root",
				Password: "password",
				DBName:   "bookstore",
			},
			GRPC: GRPCConfig{
				Port: 50051,
			},
		}, nil
	}

	var config Config
	if err := viper.Unmarshal(&config); err != nil {
		return nil, err
	}

	return &config, nil
}

// DSN 获取数据库连接字符串
func (d *DatabaseConfig) DSN() string {
	return d.Username + ":" + d.Password + "@tcp(" + d.Host + ":" + 
		itoa(d.Port) + ")/" + d.DBName + "?charset=utf8mb4&parseTime=True&loc=Local"
}

func itoa(i int) string {
	return string(rune('0'+i))
}

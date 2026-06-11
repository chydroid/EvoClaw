package service

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"gorm.io/gorm"
	pb "go-bookstore/proto/user"
)

// User 用户模型
type User struct {
	ID        uint      `gorm:"primaryKey"`
	Username  string    `gorm:"uniqueIndex;size:64"`
	Password  string    `gorm:"size:128"`
	Email     string    `gorm:"size:128"`
	CreatedAt time.Time
}

// UserService 用户服务实现
type UserService struct {
	pb.UnimplementedUserServiceServer
	db *gorm.DB
}

// NewUserService 创建用户服务
func NewUserService(db *gorm.DB) *UserService {
	return &UserService{db: db}
}

// Register 用户注册
func (s *UserService) Register(ctx context.Context, req *pb.RegisterRequest) (*pb.UserResponse, error) {
	// 密码加密
	hash := sha256.Sum256([]byte(req.Password))
	password := fmt.Sprintf("%x", hash)

	user := User{
		Username: req.Username,
		Password: password,
		Email:    req.Email,
	}

	if err := s.db.Create(&user).Error; err != nil {
		return nil, fmt.Errorf("注册失败: %v", err)
	}

	return &pb.UserResponse{
		Id:        int64(user.ID),
		Username:  user.Username,
		Email:     user.Email,
		CreatedAt: user.CreatedAt.Format(time.RFC3339),
	}, nil
}

// Login 用户登录
func (s *UserService) Login(ctx context.Context, req *pb.LoginRequest) (*pb.LoginResponse, error) {
	var user User
	hash := sha256.Sum256([]byte(req.Password))
	password := fmt.Sprintf("%x", hash)

	if err := s.db.Where("username = ? AND password = ?", req.Username, password).First(&user).Error; err != nil {
		return nil, fmt.Errorf("用户名或密码错误")
	}

	return &pb.LoginResponse{
		UserId:   int64(user.ID),
		Username: user.Username,
		Token:    fmt.Sprintf("token-%d-%d", user.ID, time.Now().Unix()),
	}, nil
}

// GetUser 获取用户信息
func (s *UserService) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.UserResponse, error) {
	var user User
	if err := s.db.First(&user, req.Id).Error; err != nil {
		return nil, fmt.Errorf("用户不存在")
	}

	return &pb.UserResponse{
		Id:        int64(user.ID),
		Username:  user.Username,
		Email:     user.Email,
		CreatedAt: user.CreatedAt.Format(time.RFC3339),
	}, nil
}

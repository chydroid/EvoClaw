package main

import (
	"fmt"
	"log"
	"net"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"google.golang.org/grpc"

	pb "go-bookstore/proto/user"
	"go-bookstore/user-service/service"
)

// User 用户模型
type User struct {
	ID       uint   `gorm:"primaryKey"`
	Username string `gorm:"uniqueIndex;size:64"`
	Password string `gorm:"size:128"`
	Email    string `gorm:"size:128"`
}

func main() {
	// 连接数据库
	dsn := "root:password@tcp(localhost:3306)/bookstore_user?charset=utf8mb4&parseTime=True&loc=Local"
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Failed to connect database: %v", err)
	}

	// 自动迁移
	db.AutoMigrate(&User{})

	// 创建 gRPC 服务器
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	s := grpc.NewServer()
	pb.RegisterUserServiceServer(s, service.NewUserService(db))

	fmt.Println("🚀 User Service started on :50051")
	if err := s.Serve(lis); err != nil {
		log.Fatalf("Failed to serve: %v", err)
	}
}

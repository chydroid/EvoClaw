package main

import (
	"fmt"
	"log"
	"net"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"google.golang.org/grpc"

	pb "go-bookstore/proto/product"
	"go-bookstore/product-service/service"
)

// Product 商品模型
type Product struct {
	ID          uint    `gorm:"primaryKey"`
	Name        string  `gorm:"size:128"`
	Description string  `gorm:"size:512"`
	Price       float64 `gorm:"type:decimal(10,2)"`
	Stock       int32
	Category    string `gorm:"size:64"`
}

func main() {
	// 连接数据库
	dsn := "root:password@tcp(localhost:3307)/bookstore_product?charset=utf8mb4&parseTime=True&loc=Local"
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Failed to connect database: %v", err)
	}

	// 自动迁移
	db.AutoMigrate(&Product{})

	// 创建 gRPC 服务器
	lis, err := net.Listen("tcp", ":50052")
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	s := grpc.NewServer()
	pb.RegisterProductServiceServer(s, service.NewProductService(db))

	fmt.Println("🚀 Product Service started on :50052")
	if err := s.Serve(lis); err != nil {
		log.Fatalf("Failed to serve: %v", err)
	}
}

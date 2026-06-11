package main

import (
	"fmt"
	"log"
	"net"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"google.golang.org/grpc"

	pb "go-bookstore/proto/order"
	"go-bookstore/order-service/service"
)

// Order 订单模型
type Order struct {
	ID          uint    `gorm:"primaryKey"`
	UserID      int64
	TotalAmount float64 `gorm:"type:decimal(10,2)"`
	Status      string  `gorm:"size:32"`
}

// OrderItem 订单项模型
type OrderItem struct {
	ID        uint `gorm:"primaryKey"`
	OrderID   uint
	ProductID int64
	Quantity  int32
	Price     float64 `gorm:"type:decimal(10,2)"`
}

func main() {
	// 连接数据库
	dsn := "root:password@tcp(localhost:3308)/bookstore_order?charset=utf8mb4&parseTime=True&loc=Local"
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Failed to connect database: %v", err)
	}

	// 自动迁移
	db.AutoMigrate(&Order{}, &OrderItem{})

	// 创建 gRPC 服务器
	lis, err := net.Listen("tcp", ":50053")
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	s := grpc.NewServer()
	pb.RegisterOrderServiceServer(s, service.NewOrderService(db))

	fmt.Println("🚀 Order Service started on :50053")
	if err := s.Serve(lis); err != nil {
		log.Fatalf("Failed to serve: %v", err)
	}
}

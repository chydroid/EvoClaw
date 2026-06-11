package service

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	pb "go-bookstore/proto/order"
)

// Order 订单模型
type Order struct {
	ID          uint      `gorm:"primaryKey"`
	UserID      int64
	TotalAmount float64   `gorm:"type:decimal(10,2)"`
	Status      string    `gorm:"size:32"`
	CreatedAt   time.Time
	Items       []OrderItem
}

// OrderItem 订单项模型
type OrderItem struct {
	ID        uint `gorm:"primaryKey"`
	OrderID   uint
	ProductID int64
	Quantity  int32
	Price     float64 `gorm:"type:decimal(10,2)"`
}

// OrderService 订单服务实现
type OrderService struct {
	pb.UnimplementedOrderServiceServer
	db *gorm.DB
}

// NewOrderService 创建订单服务
func NewOrderService(db *gorm.DB) *OrderService {
	return &OrderService{db: db}
}

// CreateOrder 创建订单
func (s *OrderService) CreateOrder(ctx context.Context, req *pb.CreateOrderRequest) (*pb.OrderMessage, error) {
	var totalAmount float64
	var items []OrderItem

	for _, item := range req.Items {
		totalAmount += item.Price * float64(item.Quantity)
		items = append(items, OrderItem{
			ProductID: item.ProductId,
			Quantity:  item.Quantity,
			Price:     item.Price,
		})
	}

	order := Order{
		UserID:      req.UserId,
		TotalAmount: totalAmount,
		Status:      "pending",
		Items:       items,
	}

	if err := s.db.Create(&order).Error; err != nil {
		return nil, fmt.Errorf("创建订单失败: %v", err)
	}

	return s.orderToMessage(&order), nil
}

// GetOrder 获取订单详情
func (s *OrderService) GetOrder(ctx context.Context, req *pb.GetOrderRequest) (*pb.OrderMessage, error) {
	var order Order
	if err := s.db.Preload("Items").First(&order, req.Id).Error; err != nil {
		return nil, fmt.Errorf("订单不存在")
	}

	return s.orderToMessage(&order), nil
}

// ListUserOrders 获取用户订单列表
func (s *OrderService) ListUserOrders(ctx context.Context, req *pb.ListUserOrdersRequest) (*pb.ListUserOrdersResponse, error) {
	var orders []Order
	var total int64

	page := req.Page
	if page <= 0 {
		page = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = 10
	}

	s.db.Model(&Order{}).Where("user_id = ?", req.UserId).Count(&total)
	offset := (page - 1) * pageSize
	if err := s.db.Preload("Items").Where("user_id = ?", req.UserId).
		Offset(int(offset)).Limit(int(pageSize)).Find(&orders).Error; err != nil {
		return nil, fmt.Errorf("查询订单失败: %v", err)
	}

	var pbOrders []*pb.OrderMessage
	for _, o := range orders {
		pbOrders = append(pbOrders, s.orderToMessage(&o))
	}

	return &pb.ListUserOrdersResponse{
		Orders: pbOrders,
		Total:  int32(total),
	}, nil
}

// orderToMessage 订单转消息
func (s *OrderService) orderToMessage(order *Order) *pb.OrderMessage {
	var items []*pb.OrderItem
	for _, item := range order.Items {
		items = append(items, &pb.OrderItem{
			ProductId: item.ProductID,
			Quantity:  item.Quantity,
			Price:     item.Price,
		})
	}

	return &pb.OrderMessage{
		Id:          int64(order.ID),
		UserId:      order.UserID,
		Items:       items,
		TotalAmount: order.TotalAmount,
		Status:      order.Status,
		CreatedAt:   order.CreatedAt.Format(time.RFC3339),
	}
}

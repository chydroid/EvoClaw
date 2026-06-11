package service

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	pb "go-bookstore/proto/product"
)

// Product 商品模型
type Product struct {
	ID          uint      `gorm:"primaryKey"`
	Name        string    `gorm:"size:128"`
	Description string    `gorm:"size:512"`
	Price       float64   `gorm:"type:decimal(10,2)"`
	Stock       int32
	Category    string    `gorm:"size:64"`
	CreatedAt   time.Time
}

// ProductService 商品服务实现
type ProductService struct {
	pb.UnimplementedProductServiceServer
	db *gorm.DB
}

// NewProductService 创建商品服务
func NewProductService(db *gorm.DB) *ProductService {
	return &ProductService{db: db}
}

// ListProducts 获取商品列表
func (s *ProductService) ListProducts(ctx context.Context, req *pb.ListProductsRequest) (*pb.ListProductsResponse, error) {
	var products []Product
	var total int64

	page := req.Page
	if page <= 0 {
		page = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = 10
	}

	s.db.Model(&Product{}).Count(&total)
	offset := (page - 1) * pageSize
	if err := s.db.Offset(int(offset)).Limit(int(pageSize)).Find(&products).Error; err != nil {
		return nil, fmt.Errorf("查询商品失败: %v", err)
	}

	var pbProducts []*pb.ProductMessage
	for _, p := range products {
		pbProducts = append(pbProducts, &pb.ProductMessage{
			Id:          int64(p.ID),
			Name:        p.Name,
			Description: p.Description,
			Price:       p.Price,
			Stock:       p.Stock,
			Category:    p.Category,
			CreatedAt:   p.CreatedAt.Format(time.RFC3339),
		})
	}

	return &pb.ListProductsResponse{
		Products: pbProducts,
		Total:    int32(total),
	}, nil
}

// GetProduct 获取商品详情
func (s *ProductService) GetProduct(ctx context.Context, req *pb.GetProductRequest) (*pb.ProductMessage, error) {
	var product Product
	if err := s.db.First(&product, req.Id).Error; err != nil {
		return nil, fmt.Errorf("商品不存在")
	}

	return &pb.ProductMessage{
		Id:          int64(product.ID),
		Name:        product.Name,
		Description: product.Description,
		Price:       product.Price,
		Stock:       product.Stock,
		Category:    product.Category,
		CreatedAt:   product.CreatedAt.Format(time.RFC3339),
	}, nil
}

// CreateProduct 创建商品
func (s *ProductService) CreateProduct(ctx context.Context, req *pb.CreateProductRequest) (*pb.ProductMessage, error) {
	product := Product{
		Name:        req.Name,
		Description: req.Description,
		Price:       req.Price,
		Stock:       req.Stock,
		Category:    req.Category,
	}

	if err := s.db.Create(&product).Error; err != nil {
		return nil, fmt.Errorf("创建商品失败: %v", err)
	}

	return &pb.ProductMessage{
		Id:          int64(product.ID),
		Name:        product.Name,
		Description: product.Description,
		Price:       product.Price,
		Stock:       product.Stock,
		Category:    product.Category,
		CreatedAt:   product.CreatedAt.Format(time.RFC3339),
	}, nil
}

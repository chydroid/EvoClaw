package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	userPb "go-bookstore/proto/user"
	productPb "go-bookstore/proto/product"
	orderPb "go-bookstore/proto/order"
)

var (
	userClient    userPb.UserServiceClient
	productClient productPb.ProductServiceClient
	orderClient   orderPb.OrderServiceClient
)

func main() {
	// 连接用户服务
	userConn, err := grpc.Dial("localhost:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("Failed to connect user service: %v", err)
	}
	defer userConn.Close()
	userClient = userPb.NewUserServiceClient(userConn)

	// 连接商品服务
	productConn, err := grpc.Dial("localhost:50052", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("Failed to connect product service: %v", err)
	}
	defer productConn.Close()
	productClient = productPb.NewProductServiceClient(productConn)

	// 连接订单服务
	orderConn, err := grpc.Dial("localhost:50053", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("Failed to connect order service: %v", err)
	}
	defer orderConn.Close()
	orderClient = orderPb.NewOrderServiceClient(orderConn)

	// 初始化 Gin 路由
	r := gin.Default()

	// 用户路由
	userGroup := r.Group("/api/v1/users")
	{
		userGroup.POST("/register", handleRegister)
		userGroup.POST("/login", handleLogin)
		userGroup.GET("/:id", handleGetUser)
	}

	// 商品路由
	productGroup := r.Group("/api/v1/products")
	{
		productGroup.GET("", handleListProducts)
		productGroup.GET("/:id", handleGetProduct)
		productGroup.POST("", handleCreateProduct)
	}

	// 订单路由
	orderGroup := r.Group("/api/v1/orders")
	{
		orderGroup.POST("", handleCreateOrder)
		orderGroup.GET("/:id", handleGetOrder)
		orderGroup.GET("/user/:userId", handleListUserOrders)
	}

	fmt.Println("🚀 API Gateway started on :8080")
	r.Run(":8080")
}

// 用户注册
func handleRegister(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, err := userClient.Register(c.Request.Context(), &userPb.RegisterRequest{
		Username: req.Username,
		Password: req.Password,
		Email:    req.Email,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 用户登录
func handleLogin(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, err := userClient.Login(c.Request.Context(), &userPb.LoginRequest{
		Username: req.Username,
		Password: req.Password,
	})
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 获取用户信息
func handleGetUser(c *gin.Context) {
	id := c.Param("id")
	var userId int64
	fmt.Sscanf(id, "%d", &userId)

	resp, err := userClient.GetUser(c.Request.Context(), &userPb.GetUserRequest{Id: userId})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 商品列表
func handleListProducts(c *gin.Context) {
	var page, pageSize int32
	fmt.Sscanf(c.DefaultQuery("page", "1"), "%d", &page)
	fmt.Sscanf(c.DefaultQuery("page_size", "10"), "%d", &pageSize)

	resp, err := productClient.ListProducts(c.Request.Context(), &productPb.ListProductsRequest{
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 商品详情
func handleGetProduct(c *gin.Context) {
	id := c.Param("id")
	var productId int64
	fmt.Sscanf(id, "%d", &productId)

	resp, err := productClient.GetProduct(c.Request.Context(), &productPb.GetProductRequest{Id: productId})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 创建商品
func handleCreateProduct(c *gin.Context) {
	var req struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		Price       float64 `json:"price"`
		Stock       int32   `json:"stock"`
		Category    string  `json:"category"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	resp, err := productClient.CreateProduct(c.Request.Context(), &productPb.CreateProductRequest{
		Name:        req.Name,
		Description: req.Description,
		Price:       req.Price,
		Stock:       req.Stock,
		Category:    req.Category,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 创建订单
func handleCreateOrder(c *gin.Context) {
	var req struct {
		UserID int64 `json:"user_id"`
		Items  []struct {
			ProductId int64   `json:"product_id"`
			Quantity  int32   `json:"quantity"`
			Price     float64 `json:"price"`
		} `json:"items"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var items []*orderPb.OrderItem
	for _, item := range req.Items {
		items = append(items, &orderPb.OrderItem{
			ProductId: item.ProductId,
			Quantity:  item.Quantity,
			Price:     item.Price,
		})
	}

	resp, err := orderClient.CreateOrder(c.Request.Context(), &orderPb.CreateOrderRequest{
		UserId: req.UserID,
		Items:  items,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 订单详情
func handleGetOrder(c *gin.Context) {
	id := c.Param("id")
	var orderId int64
	fmt.Sscanf(id, "%d", &orderId)

	resp, err := orderClient.GetOrder(c.Request.Context(), &orderPb.GetOrderRequest{Id: orderId})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

// 用户订单列表
func handleListUserOrders(c *gin.Context) {
	userIdStr := c.Param("userId")
	var userId int64
	fmt.Sscanf(userIdStr, "%d", &userId)

	var page, pageSize int32
	fmt.Sscanf(c.DefaultQuery("page", "1"), "%d", &page)
	fmt.Sscanf(c.DefaultQuery("page_size", "10"), "%d", &pageSize)

	resp, err := orderClient.ListUserOrders(c.Request.Context(), &orderPb.ListUserOrdersRequest{
		UserId:   userId,
		Page:     page,
		PageSize: pageSize,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 200, "data": resp})
}

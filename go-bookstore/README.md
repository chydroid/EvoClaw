# 🧬 Go Bookstore 微服务项目

一个用于学习Go微服务架构的练手项目——在线书店系统。

## 📐 架构设计

```
                    ┌─────────────────────────┐
                    │    API Gateway (Gin)     │
                    │   :8080 统一入口         │
                    └───────┬─────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
    ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
    │ User Svc  │    │Product Svc│    │ Order Svc │
    │   :50051  │    │   :50052  │    │   :50053  │
    └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
          │                 │                 │
    ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
    │  MySQL    │    │  MySQL    │    │  MySQL    │
    │  :3306    │    │  :3307    │    │  :3308    │
    └───────────┘    └───────────┘    └───────────┘
```

## 🛠️ 技术栈

| 组件 | 技术 |
|------|------|
| HTTP框架 | Gin |
| 服务通信 | gRPC + Protocol Buffers |
| 数据库 | MySQL + GORM |
| 容器化 | Docker + Docker Compose |
| 配置管理 | Viper |
| 日志 | Zap |

## 🚀 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 克隆项目
cd go-bookstore

# 一键启动所有服务
docker-compose up -d

# 访问 API
curl http://localhost:8080/api/v1/products
```

### 方式二：本地开发

```bash
# 1. 初始化依赖
go mod tidy

# 2. 启动 MySQL（需要本地安装或用 Docker）
docker-compose up -d mysql-user mysql-product mysql-order

# 3. 分别启动各服务
go run gateway/main.go
go run user-service/main.go
go run product-service/main.go
go run order-service/main.go
```

## 📡 API 接口

### 用户服务
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/v1/users/register | 用户注册 |
| POST | /api/v1/users/login | 用户登录 |
| GET | /api/v1/users/:id | 获取用户信息 |

### 商品服务
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/products | 商品列表 |
| GET | /api/v1/products/:id | 商品详情 |
| POST | /api/v1/products | 创建商品 |

### 订单服务
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/v1/orders | 创建订单 |
| GET | /api/v1/orders/:id | 订单详情 |
| GET | /api/v1/orders/user/:userId | 用户订单列表 |

## 📁 项目结构

```
go-bookstore/
├── proto/                    # gRPC Proto 定义
│   ├── user.proto
│   ├── product.proto
│   └── order.proto
├── common/                   # 共享代码
│   └── config/
│       └── config.go
├── gateway/                  # API 网关
│   ├── main.go
│   └── handler/
├── user-service/             # 用户服务
│   ├── main.go
│   └── service/
├── product-service/          # 商品服务
│   ├── main.go
│   └── service/
├── order-service/            # 订单服务
│   ├── main.go
│   └── service/
├── docker-compose.yml
└── README.md
```

## 📝 学习路线

1. **Week 1**: 理解项目结构，跑通单个服务
2. **Week 2**: 学习 gRPC 通信机制
3. **Week 3**: 理解 API Gateway 路由转发
4. **Week 4**: Docker 容器化部署
5. **进阶**: 添加 JWT 鉴权、Redis 缓存、链路追踪

## 📄 License

MIT

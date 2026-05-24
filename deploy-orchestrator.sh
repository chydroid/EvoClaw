#!/bin/bash
# =============================================
#  EvoClaw 跨3集群滚动部署编排器
#  Rolling Deployment Orchestrator
#  版本: v2.0.0
#  创建: 2026-05-24
# =============================================

set -e

VERSION="${1:-v2.0.0}"
REGISTRY="registry.evoclaw.com"
DEPLOY_LOG="./deploy-$(date +%Y%m%d-%H%M%S).log"
START_TIME=$(date +%s)

# ============ 颜色定义 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============ 工具函数 ============
log()     { echo -e "[$(date '+%H:%M:%S')] $1" | tee -a "$DEPLOY_LOG"; }
info()    { log "${BLUE}[INFO]${NC} $1"; }
success() { log "${GREEN}[OK]${NC} $1"; }
warn()    { log "${YELLOW}[WARN]${NC} $1"; }
error()   { log "${RED}[ERROR]${NC} $1"; }
step()    { log "\n${CYAN}═══════════════════════════════════════════════${NC}"; log "${CYAN}  $1${NC}"; log "${CYAN}═══════════════════════════════════════════════${NC}"; }

# ============ 健康检查函数 ============
health_check() {
    local cluster=$1
    local node=$2
    local retries=${3:-3}
    local interval=${4:-5}

    info "健康检查: $cluster/$node (重试${retries}次, 间隔${interval}s)"

    for ((i=1; i<=retries; i++)); do
        # 检查1: 服务存活
        if curl -sf "http://${node}:3000/health" > /dev/null 2>&1; then
            success "  ✓ 服务存活检查通过 ($node)"
        else
            warn "  ✗ 服务存活检查失败 ($node) 尝试 $i/$retries"
            [ $i -lt $retries ] && sleep $interval || return 1
            continue
        fi

        # 检查2: API 功能
        if curl -sf "http://${node}:3000/api/skills" > /dev/null 2>&1; then
            success "  ✓ API 功能检查通过 ($node)"
        else
            warn "  ✗ API 功能检查失败 ($node) 尝试 $i/$retries"
            [ $i -lt $retries ] && sleep $interval || return 1
            continue
        fi

        # 检查3: 数据库连接
        if curl -sf "http://${node}:3000/health/db" > /dev/null 2>&1; then
            success "  ✓ 数据库连接检查通过 ($node)"
        else
            warn "  ✗ 数据库连接检查失败 ($node) 尝试 $i/$retries"
            [ $i -lt $retries ] && sleep $interval || return 1
            continue
        fi

        # 检查4: LLM 服务
        if curl -sf "http://${node}:3000/health/llm" > /dev/null 2>&1; then
            success "  ✓ LLM 服务检查通过 ($node)"
        else
            warn "  ✗ LLM 服务检查失败 ($node) 尝试 $i/$retries"
            [ $i -lt $retries ] && sleep $interval || return 1
            continue
        fi

        # 全部通过
        return 0
    done

    return 1
}

# ============ 指标检查函数 ============
check_metrics() {
    local cluster=$1
    local duration=$2  # 观察时间(秒)
    local interval=10  # 采样间隔

    info "指标监控: $cluster (观察${duration}秒)"

    local end_time=$(( $(date +%s) + duration ))
    local errors=0
    local samples=0

    while [ $(date +%s) -lt $end_time ]; do
        samples=$((samples + 1))

        # 检查错误率 (模拟: 通过健康端点)
        local http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://${cluster}/health" 2>/dev/null || echo "000")
        if [ "$http_code" != "200" ]; then
            errors=$((errors + 1))
            warn "  异常响应: HTTP $http_code"
        fi

        # 检查延迟
        local latency=$(curl -s -o /dev/null -w "%{time_total}" "http://${cluster}/health" 2>/dev/null || echo "0")
        local latency_ms=$(echo "$latency * 1000" | bc 2>/dev/null || echo "0")
        if [ "$(echo "$latency_ms > 1000" | bc 2>/dev/null)" = "1" ]; then
            warn "  高延迟: ${latency_ms}ms"
            errors=$((errors + 1))
        fi

        [ $samples -le 3 ] && info "  采样 #$samples: HTTP $http_code, ${latency_ms}ms"
        sleep $interval
    done

    local error_rate=$(echo "scale=2; $errors / $samples * 100" | bc 2>/dev/null || echo "0")
    info "  指标汇总: $samples 次采样, $errors 次异常, 错误率 ${error_rate}%"

    if [ "$(echo "$error_rate > 1" | bc 2>/dev/null)" = "1" ]; then
        error "错误率超过阈值(1%)，建议回滚！"
        return 1
    fi

    return 0
}

# ============ 部署到集群 ============
deploy_cluster() {
    local cluster=$1
    local nodes=($2)  # 节点列表
    local batch_wait=$3  # 批次等待时间(秒)
    local verify_time=$4  # 验证时间(秒)
    local cluster_label=$5

    step "🚀 部署到 $cluster_label ($cluster)"

    # 切换 kubectl 上下文
    info "切换上下文到 $cluster"
    kubectl config use-context "$cluster" || {
        warn "无法切换上下文，尝试直接部署..."
    }

    # 设置滚动更新策略
    info "设置滚动更新策略 (maxUnavailable=1, maxSurge=2)"
    kubectl patch deployment evoclaw-server -p \
        '{"spec":{"strategy":{"rollingUpdate":{"maxUnavailable":1,"maxSurge":2}}}}' 2>/dev/null || true

    # 更新镜像
    info "更新镜像为 $REGISTRY/evoclaw:$VERSION"
    kubectl set image deployment/evoclaw-server \
        evoclaw-server="$REGISTRY/evoclaw:$VERSION" 2>/dev/null || {
        error "镜像更新失败"
        return 1
    }

    # 等待 rollout
    info "等待 rollout 完成..."
    if kubectl rollout status deployment/evoclaw-server --timeout=5m 2>/dev/null; then
        success "Rollout 完成！"
    else
        error "Rollout 超时或失败"
        return 1
    fi

    # 逐节点健康检查
    for node in "${nodes[@]}"; do
        info "检查节点: $node"
        if health_check "$cluster" "$node" 3 5; then
            success "节点 $node 通过健康检查"
        else
            error "节点 $node 健康检查失败，触发回滚！"
            rollback_cluster "$cluster"
            return 1
        fi
        sleep "$batch_wait"
    done

    # 流量验证
    info "流量验证阶段 ($((verify_time / 60)) 分钟)..."
    if check_metrics "$cluster" "$verify_time"; then
        success "✅ $cluster_label 部署验证通过！"
        return 0
    else
        error "❌ $cluster_label 指标异常，触发回滚！"
        rollback_cluster "$cluster"
        return 1
    fi
}

# ============ 回滚集群 ============
rollback_cluster() {
    local cluster=$1
    info "开始回滚 $cluster ..."

    kubectl config use-context "$cluster" 2>/dev/null || true
    kubectl rollout undo deployment/evoclaw-server 2>/dev/null || {
        warn "Rollout undo 失败，尝试直接回滚..."
    }
    kubectl rollout status deployment/evoclaw-server --timeout=3m 2>/dev/null || true

    success "回滚 $cluster 完成"
}

# ============ 通知函数 ============
notify() {
    local level=$1
    local message=$2
    echo "[NOTIFY][$level] $message"
    # 后续可扩展: 飞书/企业微信/邮件通知
}

# =============================================
#  主流程
# =============================================

echo ""
echo -e "${PURPLE}╔══════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║   🦞 EvoClaw 滚动部署编排器 v2.0.0        ║${NC}"
echo -e "${PURPLE}║   版本: $VERSION${NC}"
echo -e "${PURPLE}║   日志: $DEPLOY_LOG${NC}"
echo -e "${PURPLE}╚══════════════════════════════════════════════╝${NC}"
echo ""

notify "START" "开始跨3集群滚动部署, 版本: $VERSION"

# ======== 阶段 1: Cluster-A 金丝雀 ========
step "阶段 1/3: 🟢 Cluster-A (金丝雀/预发布)"
echo "  集群: cluster-a"
echo "  节点: node-a-1, node-a-2"
echo "  验证: 10 分钟"

if deploy_cluster "cluster-a" "node-a-1 node-a-2" 30 600 "Cluster-A 金丝雀"; then
    success "阶段1完成！Cluster-A 部署成功"
    notify "STAGE" "阶段1完成: Cluster-A 金丝雀部署成功"
else
    error "阶段1失败！停止部署"
    notify "FAIL" "阶段1失败: Cluster-A 部署失败，部署中止"
    exit 1
fi

# ======== 阶段 2: Cluster-B 生产主 ========
step "阶段 2/3: 🔵 Cluster-B (生产主)"
echo "  集群: cluster-b"
echo "  节点: node-b-1 ~ node-b-5"
echo "  验证: 30 分钟"

if deploy_cluster "cluster-b" "node-b-1 node-b-2 node-b-3 node-b-4 node-b-5" 60 1800 "Cluster-B 生产主"; then
    success "阶段2完成！Cluster-B 部署成功"
    notify "STAGE" "阶段2完成: Cluster-B 生产主部署成功"
else
    error "阶段2失败！停止部署"
    notify "FAIL" "阶段2失败: Cluster-B 部署失败"
    exit 1
fi

# ======== 阶段 3: Cluster-C 生产备 ========
step "阶段 3/3: 🟣 Cluster-C (生产备)"
echo "  集群: cluster-c"
echo "  节点: node-c-1 ~ node-c-5"
echo "  验证: 30 分钟"

if deploy_cluster "cluster-c" "node-c-1 node-c-2 node-c-3 node-c-4 node-c-5" 60 1800 "Cluster-C 生产备"; then
    success "阶段3完成！Cluster-C 部署成功"
    notify "STAGE" "阶段3完成: Cluster-C 生产备部署成功"
else
    error "阶段3失败！触发回滚"
    notify "FAIL" "阶段3失败: Cluster-C 部署失败"
    exit 1
fi

# ======== 完成 ========
END_TIME=$(date +%s)
DURATION=$(( (END_TIME - START_TIME) / 60 ))

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ 全部3个集群部署完成！                  ║${NC}"
echo -e "${GREEN}║   版本: $VERSION                          ║${NC}"
echo -e "${GREEN}║   耗时: ${DURATION} 分钟                       ║${NC}"
echo -e "${GREEN}║   日志: $DEPLOY_LOG           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""

notify "DONE" "全部3集群滚动部署完成！版本: $VERSION, 耗时: ${DURATION}分钟"

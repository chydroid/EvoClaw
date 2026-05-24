#!/bin/bash
# =============================================
#  EvoClaw 快速回滚脚本
#  Rollback All Clusters
# =============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${RED}╔══════════════════════════════════════════════╗${NC}"
echo -e "${RED}║   ⚠️  EvoClaw 全集群回滚                    ║${NC}"
echo -e "${RED}╚══════════════════════════════════════════════╝${NC}"

CLUSTERS=("cluster-a" "cluster-b" "cluster-c")
LABELS=("🟢 Cluster-A 金丝雀" "🔵 Cluster-B 生产主" "🟣 Cluster-C 生产备")

for i in "${!CLUSTERS[@]}"; do
    ctx="${CLUSTERS[$i]}"
    label="${LABELS[$i]}"

    echo ""
    echo -e "${YELLOW}回滚 $label ($ctx)...${NC}"

    kubectl config use-context "$ctx" 2>/dev/null || echo "  [警告] 无法切换上下文"

    # 获取当前版本信息
    CURRENT=$(kubectl rollout history deployment/evoclaw-server 2>/dev/null | tail -2 | head -1 || echo "未知")
    echo "  当前版本: $CURRENT"

    # 执行回滚
    kubectl rollout undo deployment/evoclaw-server 2>/dev/null || {
        echo -e "${RED}  [错误] 回滚失败${NC}"
        continue
    }

    # 等待回滚完成
    if kubectl rollout status deployment/evoclaw-server --timeout=5m 2>/dev/null; then
        echo -e "${GREEN}  ✅ $label 回滚完成${NC}"
    else
        echo -e "${RED}  ❌ $label 回滚超时${NC}"
    fi

    # 验证
    curl -sf "http://${ctx}/health" > /dev/null 2>&1 && \
        echo -e "${GREEN}  ✅ 服务验证通过${NC}" || \
        echo -e "${RED}  ❌ 服务验证失败${NC}"
done

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ 全集群回滚完成${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"

#!/bin/bash
# Alysia 一键部署脚本
# 用法: curl -fsSL <url>/deploy.sh | bash
# 或:   chmod +x deploy.sh && ./deploy.sh

set -e

echo "=== Alysia 部署 ==="

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "安装 Docker..."
    curl -fsSL https://get.docker.com | bash
fi

# 检查项目
if [ ! -f "packages/server/compose.yml" ]; then
    echo "克隆项目..."
    git clone https://github.com/lmlit/alysiaAgent.git
    cd alysiaAgent
fi

# 创建配置文件（如果不存在）
if [ ! -f "packages/server/config.yml" ]; then
    echo "请先配置 packages/server/config.yml"
    echo "模板: config.example.yml"
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "请先创建 .env 文件（包含 API Key）"
    exit 1
fi

# 构建 + 启动
echo "构建镜像..."
docker compose -f packages/server/compose.yml build

echo "启动..."
docker compose -f packages/server/compose.yml up -d

echo "=== 部署完成 ==="
echo "查看日志: docker compose -f packages/server/compose.yml logs -f"
echo "状态:    docker compose -f packages/server/compose.yml ps"

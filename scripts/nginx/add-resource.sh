#!/usr/bin/env bash
# 为 agent101.uk 加 /resource/ 目录列表，尽量不改主配置。
# 逻辑只放在 /etc/nginx/snippets/resource.conf，主配置每个 server 块只加 1 行 include。
# 用法（EC2 上，须 root）：
#   sudo bash scripts/nginx/add-resource.sh /etc/nginx/conf.d/agent101.conf
#   sudo bash scripts/nginx/add-resource.sh --dry-run /etc/nginx/conf.d/agent101.conf
# 回滚：把脚本打印的备份文件拷回主配置，再 sudo systemctl reload nginx。
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

NGINX_CONF="${1:-}"
if [[ -z "$NGINX_CONF" ]]; then
  echo "用法: sudo bash $0 [--dry-run] <主配置文件路径>" >&2
  echo "例如: sudo bash $0 /etc/nginx/conf.d/agent101.conf" >&2
  exit 2
fi
SNIPPET="/etc/nginx/snippets/resource.conf"
RESOURCE_DIR="/home/ec2-user/app/resource"

if [[ $DRY_RUN -eq 1 ]]; then
  if [[ ! -f "$NGINX_CONF" ]]; then
    echo "[dry-run] 注意：$NGINX_CONF 在本机不存在，仅展示将要写入的内容，EC2 上有该文件时再跑正式版。" >&2
  fi
  echo "[dry-run] 不写任何文件，只展示将要写入的 snippet 和主配置改动："
  echo "--- $SNIPPET ---"
  cat <<'EOF'
location = /resource {
    return 301 /resource/;
}

location /resource/ {
    root /home/ec2-user/app;
    autoindex on;
    autoindex_format html;
    autoindex_exact_size off;
    autoindex_localtime on;
    index __no_such_index__;
}
EOF
  echo "--- $NGINX_CONF 改动 ---"
  echo "在每个 'include /etc/nginx/snippets/data-ui.conf;' 行后加一行："
  echo "    include /etc/nginx/snippets/resource.conf;"
  echo "目录: mkdir -p $RESOURCE_DIR && chmod 755 $RESOURCE_DIR"
  exit 0
fi

if [[ ! -f "$NGINX_CONF" ]]; then
  echo "找不到主配置文件: $NGINX_CONF" >&2
  exit 2
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "请用 sudo 运行：sudo bash $0 $NGINX_CONF" >&2
  exit 2
fi

# 1. 目录（不存在则建，存在则不动里面的文件）
mkdir -p "$RESOURCE_DIR"
chmod 755 "$RESOURCE_DIR"

# 2. snippet：每次写同一份内容，重复跑结果一致
cat > "$SNIPPET" <<'EOF'
location = /resource {
    return 301 /resource/;
}

location /resource/ {
    root /home/ec2-user/app;
    autoindex on;
    autoindex_format html;
    autoindex_exact_size off;
    autoindex_localtime on;
    index __no_such_index__;
}
EOF
echo "已写 $SNIPPET"

# 3. 主配置：只在 data-ui.conf 行后插 include，且不重复插
if ! grep -q 'include /etc/nginx/snippets/data-ui.conf;' "$NGINX_CONF"; then
  echo "主配置里找不到 data-ui.conf 的 include 行，未改主配置（snippet 已写，见上）。" >&2
  echo "请手动在 80 和 443 两个 server 块里各加一行：include /etc/nginx/snippets/resource.conf;" >&2
  exit 2
fi

BACKUP="${NGINX_CONF}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$NGINX_CONF" "$BACKUP"
echo "已备份主配置到 $BACKUP"

if grep -q 'include /etc/nginx/snippets/resource.conf;' "$NGINX_CONF"; then
  echo "主配置里已有 resource.conf 的 include，跳过插入"
else
  sed -i '/include \/etc\/nginx\/snippets\/data-ui.conf;/a \    include \/etc\/nginx\/snippets\/resource.conf;' "$NGINX_CONF"
  echo "已在主配置中插入 resource.conf 的 include（应为 2 处：80 和 443）"
  grep -n 'resource.conf' "$NGINX_CONF" || true
fi

# 4. 校验不过就还原，不 reload
if ! nginx -t; then
  echo "nginx -t 未通过，已把主配置还原到 $BACKUP，不 reload" >&2
  cp "$BACKUP" "$NGINX_CONF"
  exit 1
fi

# 5. 重载并验证
systemctl reload nginx
echo "nginx 已 reload"
curl -s -o /dev/null -w "https://agent101.uk/resource/ -> %{http_code}\n" https://agent101.uk/resource/ || true
curl -s -o /dev/null -w "http://agent101.uk/resource/ -> %{http_code}\n" http://agent101.uk/resource/ || true
echo "完成。回滚：cp $BACKUP $NGINX_CONF && systemctl reload nginx"

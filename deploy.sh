#!/usr/bin/env bash
# data-pipeline 运维脚本：更新代码 / 构建 / 启停服务 / 看日志 / 健康检查。
# 用法：./deploy.sh <操作> [服务]./deploy.sh help 查看全部操作。
#
# 服务名（可省略，省略 = 全部）：
# api -> pm2 进程 data-pipeline（收集 API）
# cleaner -> pm2 进程 data-cleaner（定时清洗 + 自动导出静态站）
# cursor -> pm2 进程 data-cursor-trigger（定时调用 Cursor automation webhook）
# runner -> pm2 进程 data-job-runner（多定时 job 常驻进程；新轻量定时任务进这里，不再新增 pm2 服务）
# 静态站由 cleaner 自动导出、nginx 直供，没有常驻 web 进程。

set -uo pipefail
cd "$(dirname "$0")"

PUBLIC_BASE="${PUBLIC_BASE:-https://agent101.uk/data-pipeline}"
PUBLIC_UI="${PUBLIC_UI:-https://agent101.uk/news/}"

if [ -t 1  ]; then
B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
else
B=""; G=""; R=""; Y=""; N=""
fi
info() { echo "${B}==>${N} $*";}
ok() { echo "${G}✓${N} $*";}
warn() { echo "${Y}!${N} $*";}
die() { echo "${R}✗ $*${N}" >&2; exit 1;}

need() { command -v "$1" >/dev/null 2>&1 || die "找不到命令：$1（先装好 Node 22+ / pm2 再跑）";}

# 先校验服务别名（die 必须在主 shell 里执行，不能放进命令替换的子 shell）
validate_svc() {
  case "${1:-}" in
    ""|all|api|cleaner|cursor|runner) return 0 ;;
    *) die "未知服务：${1}（可用：api / cleaner / cursor / runner / all）" ;;
  esac
}

# 把服务别名翻译成 pm2 进程名；输出空 = 全部服务
pm2_name() {
case "${1:-}" in
""|all) echo "";;
api) echo "data-pipeline";;
cleaner) echo "data-cleaner";;
cursor) echo "data-cursor-trigger";;
runner) echo "data-job-runner";;
*) die "未知服务：$1（可用：api / cleaner / cursor / runner / all）";;
esac
}

cmd_help() {
cat <<'EOF'
data-pipeline 运维脚本

用法：./deploy.sh <操作> [服务]


deploy [服务] 全流程：拉代码 -> 装依赖 -> 构建 -> 重启 -> 导出静态站 -> 状态
update 只拉最新代码（git pull）
build 只装依赖并构建（npm install + npm run build，均为轻量 tsc）

服务可填 api / cleaner / cursor / runner / all（省略 = all）
start [服务] 启动（用 ecosystem.config.cjs）
stop [服务] 停止
restart [服务] 重启（进程不存在时自动改为启动）
status 查看全部 pm2 进程
logs [服务] [行数] 看日志（默认对应进程最近 50 行；省略服务看全部）


export 手动导出一次静态站（平时 cleaner 会自动导出）
health 健康检查：本机 API / 公网 API / 清洗统计 / 静态站文件 / 公网页面


help 显示本帮助

示例：
./deploy.sh deploy # 整体更新上线
./deploy.sh restart cleaner # 只重启清洗服务
./deploy.sh logs api 100 # 看 api 最近 100 行日志
EOF
}

cmd_update() {
# package-lock.json 是生成文件：每次部署的 npm install 都可能改写它。
# 若不先丢弃，远端一改 lock，git pull 就会死在这里（2026-10-24 已连踩两次）。
# 生成文件丢了可由 npm install 重建；只丢它，不动其它本地改动。
info "丢弃本地生成的 package-lock.json 改动…"
git checkout -- package-lock.json 2>/dev/null || true
info "拉取最新代码…"
git pull --ff-only || die "git pull 失败（有本地改动先处理，或检查 deploy key）"
ok "代码已更新到 $(git rev-parse --short HEAD)"
}

cmd_build() {
need npm
info "安装依赖…"
npm install || die "npm install 失败"
info "构建（shared -> api -> exporter -> cleaner -> cursor-trigger -> job-runner）…"
npm run build || die "构建失败"
ok "构建完成"
}

cmd_start() {
validate_svc "${1:-}"
local name; name="$(pm2_name "${1:-}")"
need pm2
if [ -n "$name" ]; then
info "启动 $name…"
pm2 start ecosystem.config.cjs --only "$name" || die "启动失败，看./deploy.sh logs"
else
info "启动全部服务…"
pm2 start ecosystem.config.cjs || die "启动失败，看./deploy.sh logs"
fi
pm2 save >/dev/null
ok "已启动并 pm2 save"
}

cmd_stop() {
validate_svc "${1:-}"
local name; name="$(pm2_name "${1:-}")"
need pm2
if [ -n "$name" ]; then
pm2 stop "$name" || die "停止 $name 失败"
else
pm2 stop all || die "停止失败"
fi
pm2 save >/dev/null
ok "已停止"
}

cmd_restart() {
validate_svc "${1:-}"
local name; name="$(pm2_name "${1:-}")"
need pm2
if [ -n "$name" ]; then
if pm2 describe "$name" >/dev/null 2>&1; then
info "重启 $name…"
pm2 restart "$name" || die "重启 $name 失败"
else
warn "$name 不在 pm2 中，改为启动"
pm2 start ecosystem.config.cjs --only "$name" || die "启动 $name 失败"
fi
else
info "重启全部服务…"
# 逐个重启 ecosystem 里定义的进程；不存在的跳过并提示
for n in data-pipeline data-cleaner data-cursor-trigger data-job-runner; do
if pm2 describe "$n" >/dev/null 2>&1; then
pm2 restart "$n" || die "重启 $n 失败"
else
warn "$n 未启动，用./deploy.sh start 单独拉起"
fi
done
fi
pm2 save >/dev/null
ok "重启完成"
}

cmd_status() {
need pm2
pm2 list
}

cmd_logs() {
validate_svc "${1:-}"
local name; name="$(pm2_name "${1:-}")"
need pm2
local lines="${2:-50}"
if [ -n "$name" ]; then
pm2 logs "$name" --lines "$lines" --nostream
else
pm2 logs --lines "$lines" --nostream
fi
}

cmd_export() {
need npm
info "手动导出静态站…"
npm run export || die "导出失败"
ok "导出完成：web-dist/current 已切换到最新一代"
}

check() { # check <说明> <命令...>
local label="$1"; shift
if "$@" >/dev/null 2>&1; then ok "$label"; else warn "$label —— 未通过"; fi
}

cmd_health() {
echo "${B}健康检查${N}"
check "本机 API 健康 (localhost:8080)" curl -sf -m 5 http://localhost:8080/data-pipeline/api/v1/health
check "公网 API 健康 ($PUBLIC_BASE)" curl -sf -m 8 "$PUBLIC_BASE/api/v1/health"
if curl -sf -m 8 "$PUBLIC_BASE/api/v1/cleaned/stats" -o /tmp/dp-stats.json 2>/dev/null; then
ok "清洗统计：$(python3 -c "import json;d=json.load(open('/tmp/dp-stats.json'));print(f\"已清洗记录 {d['records']}，条目 {d['items']}，最近清洗 {d['last_cleaned_at']}\")" 2>/dev/null || echo "已取回")"
else
warn "清洗统计接口未通过"
fi
if [ -f web-dist/current/index.html ]; then
ok "静态站已生成（web-dist/current，含 $(find web-dist/current/item -name index.html 2>/dev/null | wc -l | tr -d ' ') 个详情页）"
else
warn "静态站尚未生成（跑./deploy.sh export 或等 cleaner 下一轮）"
fi
check "公网静态站 ($PUBLIC_UI)" curl -sf -m 8 "$PUBLIC_UI"
}

main() {
local action="${1:-help}"
case "$action" in
help|-h|--help) cmd_help;;
update) cmd_update;;
build) cmd_build;;
deploy)
cmd_update
cmd_build
cmd_restart "${2:-}"
cmd_export
cmd_status
;;
start) cmd_start "${2:-}";;
stop) cmd_stop "${2:-}";;
restart) cmd_restart "${2:-}";;
status) cmd_status;;
logs) cmd_logs "${2:-}" "${3:-50}";;
export) cmd_export;;
health) cmd_health;;
*) echo "${R}未知操作：$action${N}" >&2; echo; cmd_help; exit 1;;
esac
}

main "$@"

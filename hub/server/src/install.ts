// One-line agent installer served by the hub at /install.sh:
//   curl -fsSL https://<hub>/install.sh | sudo bash -s -- --token bsg_…
// The script carries the hub URL and image; the token comes as an argument,
// so the script itself holds no secrets and is the same for every server.

export function installCommand(hubUrl: string, token: string) {
  return `curl -fsSL ${hubUrl}/install.sh | sudo bash -s -- --token ${token}`;
}

export function installScript(hubUrl: string, image: string, version: string) {
  return `#!/usr/bin/env bash
# besigor agent installer — ${hubUrl}
#   install / update:  curl -fsSL ${hubUrl}/install.sh | sudo bash -s -- --token <TOKEN>
#   remove:            curl -fsSL ${hubUrl}/install.sh | sudo bash -s -- --uninstall
set -euo pipefail

HUB_URL="${hubUrl}"
IMAGE="${image}:${version}"
DIR="/opt/besigor-agent"
NAME="besigor-agent"
TOKEN=""
UNINSTALL=0

say()  { printf '\\033[1;35m›\\033[0m %s\\n' "$*"; }
ok()   { printf '\\033[1;32m✓\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[1;31m✗\\033[0m %s\\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="\${2:-}"; shift 2 ;;
    --token=*) TOKEN="\${1#*=}"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,4p' "$0" 2>/dev/null || true; exit 0 ;;
    *) fail "Неизвестный параметр: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "Запустите от root: ... | sudo bash -s -- --token <TOKEN>"
[ "$(uname -s)" = "Linux" ] || fail "Агент работает только на Linux"

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@";
  else return 127; fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  say "Удаляю агента besigor"
  if [ -f "$DIR/docker-compose.yml" ]; then (cd "$DIR" && compose down) >/dev/null 2>&1 || true; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$DIR"
  ok "Агент удалён. Сервер можно удалить и в панели."
  exit 0
fi

case "$TOKEN" in
  bsg_*) ;;
  "") fail "Укажите токен: --token <TOKEN> (его выдаёт панель при добавлении сервера)" ;;
  *) fail "Это не похоже на токен besigor (должен начинаться с bsg_)" ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  say "Docker не найден — устанавливаю официальным скриптом get.docker.com"
  command -v curl >/dev/null 2>&1 || fail "Нужен curl"
  curl -fsSL https://get.docker.com | sh >/dev/null || fail "Не удалось установить Docker"
  systemctl enable --now docker >/dev/null 2>&1 || true
  ok "Docker установлен"
fi
docker info >/dev/null 2>&1 || fail "Docker установлен, но не запущен (systemctl start docker)"

say "Готовлю $DIR"
mkdir -p "$DIR"
umask 077
cat > "$DIR/docker-compose.yml" <<EOF
services:
  $NAME:
    image: $IMAGE
    container_name: $NAME
    restart: unless-stopped
    network_mode: host
    pid: host
    cap_add: [NET_RAW]
    security_opt: [no-new-privileges:true]
    environment:
      HUB_URL: $HUB_URL
      TOKEN: $TOKEN
    volumes:
      - /:/host:ro,rslave
      - /var/run/docker.sock:/var/run/docker.sock:ro
    logging:
      driver: json-file
      options: { max-size: "5m", max-file: "2" }
EOF
chmod 600 "$DIR/docker-compose.yml"

say "Скачиваю $IMAGE"
docker pull -q "$IMAGE" >/dev/null || fail "Не удалось скачать образ $IMAGE"

say "Запускаю агента"
docker rm -f "$NAME" >/dev/null 2>&1 || true
if compose version >/dev/null 2>&1; then
  OUT="$(cd "$DIR" && compose up -d --force-recreate 2>&1)" || { echo "$OUT" >&2; fail "docker compose up не удался"; }
else
  # no compose plugin: the same settings through docker run
  docker run -d --name "$NAME" --restart unless-stopped --network host --pid host \\
    --cap-add NET_RAW --security-opt no-new-privileges:true \\
    -e HUB_URL="$HUB_URL" -e TOKEN="$TOKEN" \\
    -v /:/host:ro,rslave -v /var/run/docker.sock:/var/run/docker.sock:ro \\
    --log-opt max-size=5m --log-opt max-file=2 "$IMAGE" >/dev/null
fi

for _ in $(seq 1 30); do
  # read the log into a variable: with pipefail, "docker logs | grep -q" can fail on SIGPIPE
  LOGS="$(docker logs "$NAME" 2>&1 || true)"
  if grep -q "connected to hub" <<<"$LOGS"; then
    ok "Агент подключился к $HUB_URL — сервер уже в панели"
    echo "  обновить: повторите эту же команду;  удалить: ... | sudo bash -s -- --uninstall"
    exit 0
  fi
  if grep -q "401" <<<"$LOGS"; then
    fail "Хаб не принял токен. Выпустите новый на странице сервера в панели."
  fi
  sleep 1
done
docker logs --tail 5 "$NAME" 2>&1 | sed 's/^/  /'
fail "Агент запущен, но пока не подключился к хабу. Проверьте, что сервер видит $HUB_URL (исходящий 443)."
`;
}

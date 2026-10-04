#!/usr/bin/env bash
# 오라클 서버 1회 설치: Docker, Caddy(HTTPS), 방화벽 80/443, 저장소 사본
# 사용: ssh ubuntu@IP 'sudo bash -s DOMAIN' < oracle-setup.sh
set -euo pipefail
DOMAIN="$1"
export DEBIAN_FRONTEND=noninteractive

# 오라클 Ubuntu 이미지는 iptables 에 22번만 열려 있다 — REJECT 규칙 앞에 80/443 추가
for p in 443 80; do
  if ! iptables -C INPUT -m state --state NEW -p tcp --dport $p -j ACCEPT 2>/dev/null; then
    r=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
    iptables -I INPUT "${r:-1}" -m state --state NEW -p tcp --dport $p -j ACCEPT
  fi
done
apt-get update -q
apt-get install -y -q netfilter-persistent iptables-persistent ca-certificates curl git
netfilter-persistent save

# Docker
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker ubuntu

# Caddy(자동 HTTPS)
if ! command -v caddy >/dev/null; then
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy || systemctl restart caddy

# 앱 디렉터리·저장소(공개)
mkdir -p /opt/macro
[ -d /opt/macro/src/.git ] || git clone --quiet https://github.com/post0318/5.git /opt/macro/src
chown -R ubuntu:ubuntu /opt/macro
echo "설치 완료: https://$DOMAIN"

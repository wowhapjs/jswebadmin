# ChatGPT 관리형 웹 서버 최초 구축 명세

**버전:** 1.2  
**기준일:** 2026-10-05  
**상태:** AUTHORITATIVE BUILD SPEC

이 문서는 새 Ubuntu 서버를 현재 운영 모델과 동일하게 구축하기 위한 최초 설치 명세다. 에이전트의 승인·권한·코딩·배포·복구 판단은 `AGENT_ROLE_OPERATIONS_GUIDE_KO.md`를 따른다. 실제 운영 구조가 달라지면 두 문서를 같은 변경 세션에서 함께 갱신한다.

## 1. 운영 전제

- GitHub `main` = production source code 원본
- explicit full SHA = production 배포 단위
- GitHub Actions production auto-deploy 미사용
- 서버 working tree 선수정 금지
- PostgreSQL `web_manager.manager` = 운영 상태 및 role policy 원본
- web-admin = 비권한 `webadmin` user
- root 작업 = 제한된 helper
- 권위 있는 source가 없는 quota/credit/% 생성 금지

## 2. 기준 아키텍처

```text
Internet
  -> Caddy :80/:443
      -> web-admin 127.0.0.1:31000
      -> site containers 127.0.0.1:31001-31999

ChatGPT
  -> GitHub main commit
  -> explicit full SHA
  -> site-deploy/site-bootstrap
  -> Manager DB record

web-admin
  -> web-admin-priv
  -> narrowly allowed root operations
```

## 3. 필수 패키지/서비스

Ubuntu 24.04 LTS 계열, Docker Engine + Compose, Caddy, PostgreSQL 16 계열, Node.js 22 계열, Git, curl/jq/openssl/ca-certificates, fail2ban, unattended-upgrades, systemd/journald, Desktop Commander Remote Agent.

외부 inbound는 80/443만 공개하고 앱 포트 31000-31999는 localhost only로 바인딩한다.

## 4. 사용자와 권한 경계

- `ubuntu`: site working tree, 일반 운영, PostgreSQL peer access
- `webadmin`: web-admin Node 전용 비권한 system user
- `web-admin-priv`: sudoers에서 허용된 유일한 privileged bridge

web-admin systemd 최소 기준:

```text
User=webadmin
Group=webadmin
SupplementaryGroups=systemd-journal
RuntimeDirectory=web-admin
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/run/web-admin /etc/web-manager/secrets
```

sudoers:
`webadmin ALL=(root) NOPASSWD: /usr/local/sbin/web-admin-priv *`

arbitrary shell/sudo API는 만들지 않는다.

## 5. 표준 디렉터리

```text
/srv/sites/<slug>
/etc/web-manager/config.env
/etc/web-manager/secrets/duckdns/<label>.env
/usr/local/sbin/site-deploy
/usr/local/sbin/site-bootstrap
/usr/local/sbin/web-admin-priv
/usr/local/sbin/manager-backup
/usr/local/sbin/platform-preflight
/var/backups/web-manager/
```

## 6. Secret

`/etc/web-manager/config.env`는 secret이 아닌 host 설정만 둔다. DuckDNS token은 `/etc/web-manager/secrets/duckdns/<label>.env`에 `DUCKDNS_TOKEN=<TOKEN>`으로 보관한다.

- secret dir: `0700 root:root`
- env file: `0600 root:root`
- legacy `/etc/web-manager/secrets/duckdns.env` 금지
- GitHub/API/log/process/user response에 secret 노출 금지
- helper에서 shell `source/eval` 금지

## 7. PostgreSQL Manager Control Plane

필수 운영 개념:

- `manager.sites`
- `manager.site_domains`
- `manager.site_databases`
- `manager.deployments`
- `manager.events`
- `manager.backups`
- `manager.dns_providers`
- `manager.dns_provider_domains`
- `manager.agent_sessions`
- `manager.agent_role_policies`
- `manager.site_public_overview`
- operation/lock/patch metadata 계열

### 7.1 Site metadata

`manager.sites`에는 최소 `slug/status/port/server_path/repo_path/repo_url/repo_branch/current_commit/framework/health_status`를 둔다. local origin과 Manager repo URL 불일치 시 deploy를 중단한다.

### 7.2 Agent role baseline

표준 role은 `MAIN_ADMIN`, `SITE_ADMIN`, `SITE_DB_ADMIN`, `READ_ONLY`다. `manager.agent_role_policies`에 machine-readable baseline permission을 둔다. 새/변경 `agent_sessions`에는 trigger로 baseline을 병합한다.

모든 role에 공통으로 허용되는 non-secret public read:

- live site name/slug
- primary homepage URL/hostname
- public DNS/TLS status
- public health/status

표준 view는 `manager.site_public_overview`다. 이 view에는 credential/token/password를 넣지 않는다. **홈페이지 주소는 public information이므로 어떤 agent role도 이를 권한 부족으로 거절하면 안 된다.**

표준 migration source: `ops/004_agent_role_permissions.sql`.

### 7.3 DuckDNS hostname uniqueness

`manager.dns_provider_domains(hostname)`에 global unique index를 둔다.

### 7.4 PostgreSQL peer mapping

웹 프로세스에 DB password를 두지 않고 `webadmin -> web_manager`, `ubuntu -> web_manager` Unix peer mapping을 사용한다.

## 8. GitHub repository 정책

모든 production site는 `main` branch를 사용한다. GitHub write는 ChatGPT connector가 담당하고 서버는 fetch/read only다. Private repo는 repo별 read-only deploy key를 우선하며 broad write PAT를 서버에 저장하지 않는다.

## 9. `site-deploy`

`/usr/local/sbin/site-deploy <slug> <40-char-sha>`

필수: slug/SHA 검증, Manager repo/domain/port 조회, origin 일치, clean tree, fetch, SHA 존재/ancestry, previous SHA, deployment record, preflight, exact SHA reset, activation, local/public health, current_commit 기록, 실패 시 rollback + rollback health.

`git pull`은 production release 단위가 아니다.

## 10. `site-bootstrap`

`/usr/local/sbin/site-bootstrap <slug> <name> <repo-url> <sha> <domain> <port> <label> [framework]`

코드와 SHA는 bootstrap 전에 GitHub `main`에 존재해야 한다. DB/socket port conflict, existing domain attachment, DuckDNS ownership/API, Git clone/exact SHA, Manager metadata, Caddy backup/fmt/validate/reload, `site-deploy`, local/public health를 처리한다. 기본 production routing은 hostname 기반이다.

## 11. Manager DB Backup

`sudo /usr/local/sbin/manager-backup`

PostgreSQL custom format, non-empty, `pg_restore -l`, SHA-256 sidecar, root-only `0600`을 확인한다. Destructive migration 전에 반드시 검증 성공해야 한다.

## 12. web-admin 보안

- `127.0.0.1:31000`
- Caddy reverse proxy + 인증
- process user `webadmin`
- privileged operation은 `web-admin-priv`
- POST: `X-Web-Admin-Request`, Sec-Fetch-Site, Origin, JSON Content-Type 검증
- CSP/frame/nosniff/referrer 보호

## 13. Admin 모니터링

Memory/Disk actual %, Load의 CPU-core 대비 참고값, Manager DB 절대 크기, site directory/DB 분리, visitor unique-IP, GitHub/deployed/local SHA, Desktop Commander service/process/journal만 신뢰 가능한 source로 표시한다.

Polling 기본값: stats 5s, DC 10s, terminal 5s incremental cursor, storage 45s cache, visitor 60s, GitHub HEAD 60s, Manager DB 15s.

## 14. Caddy / Access Log

Caddyfile backup -> 변경 -> fmt -> validate -> reload, 실패 시 복원. Public access log는 JSON journald/stdout. Visitor는 하루 unique client IP로 정의하고 logging 이전 과거값을 만들지 않는다.

## 15. DuckDNS lifecycle

provider/credential, registered hostname inventory, site-domain attachment를 분리한다.

`등록도메인 추가 -> 사이트 연결 -> 사이트 삭제 -> 등록도메인 유지 -> 재사용`

기존 hostname owner가 authoritative, hostname global unique, 일반 Save로 registered hostname 제거 금지, token은 helper가 실제 API `OK`를 확인 후 반영, DB transaction + audit event.

## 16. Desktop Commander

Process health와 realtime/presence health를 분리한다. systemd cgroup을 managed instance 기준으로 사용하고 wrapper+worker 2 PID를 정상 가능 상태로 본다. duplicate는 cgroup 밖 remote agent만 후보로 잡는다. watchdog은 `/run/desktop-commander-manual-stop`을 존중한다.

## 17. 최초 설치 순서

1. OS update/NTP
2. Docker/Caddy/PostgreSQL/Node/Git/curl/jq 설치
3. fail2ban/unattended-upgrades
4. 80/443 + cloud rule 확인
5. `web_manager` DB/manager schema
6. peer mapping
7. `webadmin` user
8. 표준 directory/config/secret
9. web-admin repo checkout
10. ops helper install + sudoers `visudo -cf`
11. web-admin systemd + Caddy auth/access log
12. Desktop Commander service + healthcheck timer
13. `ops/004_agent_role_permissions.sql` 적용
14. `agent_role_policies` 4 role와 `site_public_overview` 검증
15. live site repo metadata 등록
16. explicit SHA deploy
17. `platform-preflight`
18. local/public HTTPS end-to-end 검증

## 18. 설치 완료 판정

`/usr/local/sbin/platform-preflight`가 `PLATFORM_PREFLIGHT_OK`를 출력하고 다음이 만족되어야 한다.

- required services active
- live sites GitHub HEAD = deployed SHA = local HEAD
- Caddy valid
- secret path/permissions 정상
- `manager.agent_role_policies`에 4개 표준 role baseline 존재
- `manager.site_public_overview`에서 모든 live site homepage URL 조회 가능
- legacy secret 없음

## 19. 금지 사항

서버 선수정 후 방치, GitHub secret, server write PAT, GitHub push를 deploy success로 간주, auto-deploy, `git pull` release, web-admin root, arbitrary privileged API, site 삭제와 DuckDNS registration 삭제 결합, 의미 없는 quota/percentage, health 없는 성공 선언, 실패 backup 성공 보고, **공개 홈페이지 주소를 role 권한 부족으로 차단**.

## 20. 장애 복구

Code 장애는 previous known-good SHA rollback/redeploy. DB destructive 작업은 verified backup 전제. Caddy validation 실패는 backup 복원. Secret 복구는 GitHub가 아니라 root-only store를 사용한다.

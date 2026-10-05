# ChatGPT 관리형 웹 서버 최초 구축 명세

**버전:** 1.1  
**기준일:** 2026-10-05  
**상태:** AUTHORITATIVE BUILD SPEC

이 문서는 새 Ubuntu 서버를 현재 운영 모델과 동일하게 구축하기 위한 최초 설치 명세다. 에이전트의 승인·코딩·배포·복구 판단은 `AGENT_ROLE_OPERATIONS_GUIDE_KO.md`를 따른다. 두 문서가 실제 운영 구조와 달라지면 같은 변경 세션에서 함께 갱신한다.

## 1. 목적과 운영 전제

이 서버는 사람이 SSH에서 직접 개발하고 CI/CD가 자동 배포하는 구조가 아니라 **ChatGPT가 코딩·릴리스 판단·배포 오케스트레이션을 수행하는 서버**를 전제로 한다.

핵심 원칙:

- GitHub `main`이 production source code의 유일한 원본
- GitHub commit 자체는 배포가 아니며 explicit full SHA 배포가 production 변경 단위
- GitHub Actions production 자동배포 미사용
- 서버 working tree 직접 수정은 원칙적으로 금지
- PostgreSQL `web_manager.manager`가 사이트·도메인·repository·배포 상태의 운영 상태 원본
- web-admin은 비권한 사용자로 실행
- root 작업은 제한된 helper를 통해서만 수행
- 확인할 수 없는 quota/credit/percentage는 UI에 생성하지 않음

## 2. 기준 아키텍처

```text
Internet
  -> Caddy :80/:443
      -> web-admin 127.0.0.1:31000 (User=webadmin)
      -> site containers 127.0.0.1:31001-31999

ChatGPT
  -> GitHub main commit
  -> explicit full SHA
  -> /usr/local/sbin/site-deploy
  -> Manager DB deployment record

Privileged boundary
  web-admin -> sudo web-admin-priv -> narrowly allowed root operations
```

## 3. OS 및 필수 패키지

권장 기준은 Ubuntu 24.04 LTS 계열이다.

필수/권장 구성:

- Docker Engine + Compose plugin
- Caddy
- PostgreSQL 16 계열
- Node.js 22 계열
- Git
- curl, jq, openssl, ca-certificates
- fail2ban
- unattended-upgrades
- systemd/journald
- Desktop Commander Remote Agent

외부 inbound는 80/443을 공개하고, 앱 포트 31000-31999는 `127.0.0.1`에만 바인딩한다.

## 4. 시스템 사용자와 권한 경계

### 4.1 `ubuntu`

사이트 working tree, 일반 운영, PostgreSQL peer 접속에 사용한다.

### 4.2 `webadmin`

web-admin Node 프로세스 전용 비권한 system user다.

systemd 기준:

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

실제 secret directory는 root-only permission으로 보호되며 web-admin이 임의로 읽거나 쓰지 못한다.

### 4.3 Privileged helper

web-admin에는 arbitrary sudo를 주지 않는다. `/usr/local/sbin/web-admin-priv` 하나만 sudoers에 허용하고 helper 내부에서 operation/argument를 검증한다.

```text
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/web-admin-priv *
```

## 5. 표준 디렉터리 구조

```text
/srv/sites/
  web-admin/
  <site-slug>/

/etc/web-manager/
  config.env
  secrets/
    duckdns/
      default.env
      <label>.env

/usr/local/sbin/
  site-deploy
  site-bootstrap
  web-admin-priv
  manager-backup
  platform-preflight

/var/backups/web-manager/
```

각 production site는 독립 Git working tree다.

## 6. Secret 및 일반 설정

### 6.1 일반 설정

`/etc/web-manager/config.env`에는 secret이 아닌 host 설정만 둔다.

```text
SERVER_PUBLIC_IP=<PUBLIC_IPV4>
```

권장 권한은 `root:root 0644`다.

### 6.2 DuckDNS secret

```text
/etc/web-manager/secrets/duckdns/<label>.env
DUCKDNS_TOKEN=<TOKEN>
```

권한:

- `/etc/web-manager/secrets` : `root:root 0700`
- `/etc/web-manager/secrets/duckdns` : `root:root 0700`
- 각 `.env` : `root:root 0600`

legacy `/etc/web-manager/secrets/duckdns.env`는 사용하지 않는다.

Secret은 GitHub, Admin GET API, 로그, 프로세스 출력, 사용자 응답에 노출하지 않는다. helper는 env 파일을 shell `source/eval`하지 않고 `DUCKDNS_TOKEN` 값을 데이터로 파싱한다.

## 7. PostgreSQL Manager Control Plane

DB/role은 `web_manager`를 사용한다. `manager` schema는 최소 다음 운영 개념을 포함한다.

- `manager.sites`
- `manager.site_domains`
- `manager.site_databases`
- `manager.deployments`
- `manager.events`
- `manager.backups`
- `manager.dns_providers`
- `manager.dns_provider_domains`
- agent/session/operation/lock/patch metadata 계열

### 7.1 `manager.sites` 필수 필드

최소:

- `slug`
- `status`
- `port`
- `server_path`
- `repo_path`
- `repo_url`
- `repo_branch`
- `current_commit`
- `framework`
- `health_status`

`repo_url`, `repo_branch`, `current_commit`은 필수 운영 metadata다. 배포 runner는 local origin과 Manager DB repo URL이 다르면 중단한다.

### 7.2 DuckDNS hostname 전역 유일성

```sql
CREATE UNIQUE INDEX dns_provider_domains_hostname_uidx
ON manager.dns_provider_domains(hostname);
```

한 hostname은 전체 시스템에서 하나의 provider만 소유한다.

### 7.3 PostgreSQL peer mapping

web-admin에 DB password를 저장하지 않는다. Unix peer mapping으로 `webadmin -> web_manager`, `ubuntu -> web_manager`를 허용한다.

## 8. GitHub repository 정책

모든 production site의 기본 branch는 `main`이다.

현재 운영 예시:

| slug | repository | branch |
|---|---|---|
| web-admin | `https://github.com/wowhapjs/jswebadmin.git` | `main` |
| rwanda-news | `https://github.com/wowhapjs/jsrwnews.git` | `main` |
| juwon-english | `https://github.com/wowhapjs/jsjohnenglish.git` | `main` |

GitHub write는 ChatGPT connector가 담당한다. Production 서버는 fetch/read만 한다. private repo는 repo별 read-only deploy key를 우선하며 broad write PAT를 서버에 저장하지 않는다.

## 9. 표준 배포 도구: `site-deploy`

```bash
/usr/local/sbin/site-deploy <slug> <40-char-commit-sha>
```

runner 필수 절차:

1. slug/SHA 검증
2. Manager DB에서 path/port/domain/repo URL/branch 조회
3. local origin과 DB repo URL 일치 검증
4. working tree clean 확인
5. origin branch fetch
6. target SHA 존재 확인
7. target SHA의 branch ancestry 확인
8. previous SHA 저장 및 deployment row 생성
9. site별 preflight
10. 정확한 SHA reset
11. service/container activation
12. localhost health
13. public HTTPS health
14. `current_commit` 갱신
15. 실패 시 previous SHA rollback
16. rollback health 재검증

`git pull`은 production release 단위가 아니다.

## 10. 신규 사이트 도구: `site-bootstrap`

```bash
/usr/local/sbin/site-bootstrap <slug> <name> <repo-url> <sha> <domain> <port> <duckdns-label> [framework]
```

현재 표준은 `static-nginx`를 우선 지원한다.

전제:

- 코드와 SHA가 bootstrap 전에 GitHub `main`에 이미 존재
- 서버에서 source file을 먼저 생성하지 않음
- 표준 production site는 hostname 기반

bootstrap 필수 절차:

1. DB/실제 socket port 충돌 검사
2. domain이 다른 live site에 연결되어 있는지 검사
3. 기존 hostname provider ownership 우선 적용
4. DuckDNS credential/API 검증 및 DNS update
5. Git clone + exact SHA checkout
6. Manager site/repo/domain metadata 등록
7. Caddyfile backup -> 변경 -> fmt -> validate -> reload
8. `site-deploy` 호출
9. local/public health 확인
10. 성공 시 active/healthy와 TLS 상태 갱신

도메인 없는 public-IP path fallback은 현재 표준 production bootstrap 기본값이 아니다.

## 11. Manager DB Backup

```bash
sudo /usr/local/sbin/manager-backup
```

백업 기준:

- PostgreSQL custom format
- dump non-empty
- `pg_restore -l` 검증
- SHA-256 sidecar
- root-only `0600`

Destructive migration 전에 반드시 성공 여부를 직접 확인한다.

## 12. web-admin 서비스와 API 보안

- listen: `127.0.0.1:31000`
- public route: Caddy reverse proxy + 인증
- process user: `webadmin`
- root operations: `web-admin-priv` only

POST write endpoint 최소 보호:

- `X-Web-Admin-Request: 1`
- `Sec-Fetch-Site` cross-site 거부
- Origin host 검증
- JSON Content-Type 검증
- CSP/frame/nosniff/no-referrer 계열 response header

arbitrary shell API를 만들지 않는다.

## 13. Admin 모니터링 기준

- Memory: used/total + 실제 %
- Disk: used/total + 실제 %
- Load: 1m load + CPU core 대비 참고값
- Manager DB: 절대 용량 + 변화 추세, 임의 100% 금지
- Site storage: directory와 DB 분리
- Visitors: 오늘 unique client IP + 14일 sparkline
- Git state: GitHub HEAD / deployed SHA / local SHA, SYNC/BEHIND/DRIFT
- Desktop Commander: service/process/duplicate/journal, 가짜 usage 없음

Polling/cache 기본값:

- stats 5초
- Desktop Commander 10초
- terminal 5초 incremental cursor
- site storage 45초 cache
- GitHub HEAD 60초 cache
- visitor 60초 cache
- Manager DB 15초 cache

## 14. Caddy와 Access Logging

Caddy 변경 순서:

1. Caddyfile backup
2. 변경
3. `caddy fmt`
4. `caddy validate`
5. 성공 시 reload
6. 실패 시 backup 복원

모든 public site access log를 JSON으로 journald/stdout에 남긴다. 방문자는 하루 unique client IP로 정의하며 로깅 활성화 이전 과거 수치를 생성하지 않는다.

## 15. DuckDNS 데이터 모델과 Lifecycle

```text
Provider/credential
  -> Registered hostname inventory
      -> Site-domain attachment
```

사이트 삭제와 DuckDNS registered hostname 삭제는 다른 작업이다.

```text
등록도메인 추가 -> 사이트 연결 -> 사이트 삭제 -> 등록도메인 유지 -> 다른 사이트에서 재사용
```

규칙:

- 기존 hostname ownership은 요청 label보다 authoritative
- hostname 전역 unique
- 일반 Save로 기존 registered hostname 제거 금지
- 신규 token/credential은 privileged helper가 실제 DuckDNS API `OK`를 확인한 뒤 반영
- DB 반영은 transaction
- audit event 기록

## 16. Desktop Commander Remote

Process health와 realtime/presence health를 별도로 본다.

필수 구성:

- `desktop-commander-remote.service`
- `Restart=always`
- realtime presence healthcheck service/timer
- systemd cgroup 기준 duplicate 판별
- manual stop marker `/run/desktop-commander-manual-stop`
- 사용자 stop 시 watchdog 자동 재시작 금지

wrapper + worker 2 PID는 정상일 수 있으므로 단순 `pgrep` 숫자를 agent 수로 해석하지 않는다.

## 17. 최초 설치 순서

1. Ubuntu update 및 시간/NTP 확인
2. Docker/Caddy/PostgreSQL/Node/Git/curl/jq 설치
3. fail2ban/unattended-upgrades 활성화
4. 80/443 방화벽 및 cloud security rule 확인
5. `web_manager` DB/role 및 manager schema 구성
6. PostgreSQL peer mapping 구성
7. `webadmin` system user 생성
8. `/srv/sites`, `/etc/web-manager`, `/var/backups/web-manager` 생성
9. `config.env` 설치
10. DuckDNS label별 secret 설치
11. web-admin GitHub repo checkout
12. ops helper를 `/usr/local/sbin`에 root:root `0750`으로 설치
13. sudoers 설치 후 `visudo -cf` 검증
14. `web-admin.service` 설치
15. Caddy Admin route + 인증 + access logging 구성
16. Desktop Commander service 설치
17. Desktop Commander healthcheck timer 설치
18. 각 live site `repo_url`, `repo_branch`, `current_commit` 등록
19. 각 사이트를 explicit SHA로 배포
20. `platform-preflight` 및 public HTTPS 검증

## 18. 설치 완료 판정

```bash
sudo /usr/local/sbin/platform-preflight
```

최종 설치는 다음이 모두 충족되어야 완료다.

- `PLATFORM_PREFLIGHT_OK`
- 모든 live site가 GitHub HEAD = deployed SHA = local HEAD
- local/public health 정상
- Caddy validate 정상
- required services active
- legacy secret path 없음

## 19. 금지 사항

- production working tree 직접 수정 후 방치
- GitHub에 secret commit
- 서버에 write PAT 저장
- GitHub push를 production success로 간주
- GitHub Actions production auto-deploy
- `git pull`만으로 release 처리
- web-admin root 실행
- arbitrary privileged shell API
- site 삭제와 DuckDNS registration 삭제 결합
- 의미 없는 percentage/credit 생성
- health check 없이 성공 선언
- 검증 실패 backup을 성공으로 보고

## 20. 장애 복구 기준

- 코드 장애: deployment history의 previous SHA를 기준으로 마지막 known-good SHA 재배포
- DB destructive 작업: verified backup 전제
- Caddy validation 실패: 즉시 backup Caddyfile 복원
- Secret 복구: GitHub가 아니라 root-only secret store 사용
- drift: 건강한 서비스를 먼저 보존하고 GitHub/Manager/local state를 정합화

## 21. Companion Agent Guide

에이전트의 구체적인 역할, 승인 정책, GitHub-first 코딩, 배포 판단, rollback, DuckDNS lifecycle, Desktop Commander 진단, 모니터링 정직성 및 성공 보고 기준은 `docs/AGENT_ROLE_OPERATIONS_GUIDE_KO.md`를 authoritative guide로 사용한다.

과거 `AGENT_OPERATIONS_GUIDE_ADDENDUM_KO.md`와 v1.1 멀티에이전트 매뉴얼은 최종 운영 지침으로 사용하지 않는다.

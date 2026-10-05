# ChatGPT 관리형 웹 서버 최초 구축 명세

## 1. 목적과 운영 전제

이 문서는 새 Ubuntu 서버를 현재 운영 모델과 동일하게 구축하기 위한 최초 설치 명세다. 이 서버는 일반적인 사람이 직접 SSH로 개발하고 CI/CD가 자동 배포하는 구조가 아니라, **ChatGPT가 코딩·릴리스 판단·배포 오케스트레이션을 수행하는 서버**를 전제로 한다.

핵심 원칙은 다음과 같다.

- GitHub `main`이 production source code의 유일한 원본이다.
- GitHub commit 자체는 배포가 아니다. ChatGPT가 특정 40자리 commit SHA를 명시적으로 배포해야 production이 변경된다.
- GitHub Actions를 이용한 production 자동 배포는 사용하지 않는다.
- 서버 working tree 직접 수정은 원칙적으로 금지한다.
- Manager PostgreSQL DB가 사이트·도메인·repository·배포 상태의 운영 상태 원본이다.
- root 권한 작업은 제한된 helper를 통한다. web-admin 애플리케이션 자체는 root로 실행하지 않는다.
- 확인할 수 없는 quota, credit, percentage 등은 만들어서 표시하지 않는다.

## 2. 권장 서버 기준

현재 기준 OS는 Ubuntu 24.04 LTS 계열이다. 최초 구축 시 최소한 다음 구성요소를 설치하고 부팅 시 자동 시작하도록 한다.

- Docker Engine 및 Compose plugin
- Caddy
- PostgreSQL 16 계열
- Node.js 22 계열
- Git
- curl, jq, openssl, ca-certificates
- fail2ban
- unattended-upgrades
- systemd/journald
- Desktop Commander Remote Agent

웹 포트는 외부에서 80/443을 허용하고, 개별 애플리케이션은 `127.0.0.1:31000-31999`에만 바인딩한다. 애플리케이션 포트를 인터넷에 직접 공개하지 않는다.

## 3. 시스템 사용자와 권한 경계

### 3.1 일반 운영 사용자

`ubuntu` 사용자는 사이트 working tree, PostgreSQL peer 접속 및 일반 서버 운영에 사용한다.

### 3.2 web-admin 사용자

별도 system user `webadmin`을 생성한다. web-admin Node 프로세스는 다음 원칙으로 실행한다.

- `User=webadmin`
- `Group=webadmin`
- `SupplementaryGroups=systemd-journal`
- `PrivateTmp=true`
- `ProtectHome=true`
- `ProtectSystem=full`
- `ReadWritePaths=/run/web-admin /etc/web-manager/secrets`

web-admin에 임의 root shell 권한을 주면 안 된다.

### 3.3 제한된 privileged bridge

`/usr/local/sbin/web-admin-priv`만 sudo를 허용한다.

`/etc/sudoers.d/web-admin` 예시:

```text
webadmin ALL=(root) NOPASSWD: /usr/local/sbin/web-admin-priv *
```

helper 내부에서 허용되는 작업만 실행하며 arbitrary shell command는 지원하지 않는다. 현재 허용 범위는 Desktop Commander start/stop과 검증된 DuckDNS credential 적용이다.

## 4. 표준 디렉터리 구조

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

/var/backups/web-manager/
```

사이트 코드는 각각 독립 Git repository working tree다.

## 5. 비밀정보와 일반 설정 분리

### 5.1 일반 설정

`/etc/web-manager/config.env`는 secret이 아닌 host 설정만 둔다.

```text
SERVER_PUBLIC_IP=<PUBLIC_IPV4>
```

권장 권한은 `root:root 0644`이다.

### 5.2 DuckDNS secret

모든 DuckDNS credential은 다음 형태로 통일한다.

```text
/etc/web-manager/secrets/duckdns/<label>.env
```

파일 내용 형식:

```text
DUCKDNS_TOKEN=<TOKEN>
```

권한:

- `/etc/web-manager/secrets` : `root:root 0700`
- `/etc/web-manager/secrets/duckdns` : `root:root 0700`
- 각 `.env` : `root:root 0600`

legacy `/etc/web-manager/secrets/duckdns.env` 경로는 사용하지 않는다.

Secret은 GitHub, Admin GET 응답, 로그, ChatGPT 사용자 응답에 노출하지 않는다. helper는 `.env`를 shell `source`하지 않고 `DUCKDNS_TOKEN=` 값을 데이터로 파싱해야 한다.

## 6. PostgreSQL Manager Control Plane

DB 이름과 역할은 `web_manager`를 사용한다. `manager` schema는 최소한 다음 운영 개념을 포함해야 한다.

- `manager.sites`
- `manager.site_domains`
- `manager.site_databases`
- `manager.deployments`
- `manager.events`
- `manager.backups`
- `manager.dns_providers`
- `manager.dns_provider_domains`
- agent/session/operation 관련 테이블

### 6.1 manager.sites 필수 운영 필드

최소 다음 값을 가진다.

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

`repo_url`과 `repo_branch`는 서버의 실제 `.git/config`보다 상위의 운영 메타데이터다. 배포 runner는 local origin과 Manager DB의 `repo_url`이 다르면 배포를 중단해야 한다.

### 6.2 DuckDNS hostname 전역 유일성

`manager.dns_provider_domains.hostname`은 provider 내부가 아니라 전체 시스템에서 하나의 provider만 소유할 수 있어야 한다.

필수 unique index:

```sql
CREATE UNIQUE INDEX dns_provider_domains_hostname_uidx
ON manager.dns_provider_domains(hostname);
```

### 6.3 PostgreSQL peer mapping

web-admin은 DB password를 웹 프로세스에 두지 않는다. Unix peer mapping으로 `webadmin -> web_manager`, `ubuntu -> web_manager`를 허용한다.

## 7. GitHub repository 정책

모든 production 사이트는 사이트별 repository를 사용하며 기본 branch는 `main`이다.

현재 표준 예시는 다음과 같다.

| slug | repository |
|---|---|
| web-admin | `https://github.com/wowhapjs/jswebadmin.git` |
| rwanda-news | `https://github.com/wowhapjs/jsrwnews.git` |
| juwon-english | `https://github.com/wowhapjs/jsjohnenglish.git` |

서버는 원칙적으로 GitHub에 write할 필요가 없다. ChatGPT의 GitHub connector가 commit을 만들고, 서버는 fetch/read만 한다. Repository가 private으로 전환되면 서버에는 repo별 read-only deploy key를 사용하는 것을 권장한다.

## 8. 표준 배포 도구

### 8.1 `site-deploy`

설치 위치:

```text
/usr/local/sbin/site-deploy
```

사용법:

```bash
site-deploy <slug> <40-char-commit-sha>
```

runner가 반드시 수행해야 하는 절차:

1. slug 및 SHA 형식 검증
2. Manager DB에서 site/repo URL/repo branch/domain/port 조회
3. 실제 local origin과 DB repo URL 일치 확인
4. working tree clean 확인
5. `origin/<branch>` fetch
6. SHA 존재 확인
7. SHA가 `origin/<branch>` ancestry인지 확인
8. 배포 전 HEAD를 `previous_sha`로 기록
9. `manager.deployments`에 deploying row 생성
10. site별 preflight
11. 정확한 SHA로 reset
12. 서비스/컨테이너 activation
13. localhost health check
14. public HTTPS health check
15. 성공 시 `manager.sites.current_commit` 갱신
16. 실패 시 previous SHA로 자동 rollback 및 rollback health check

`git pull`만으로 production을 갱신해서는 안 된다.

### 8.2 `site-bootstrap`

설치 위치:

```text
/usr/local/sbin/site-bootstrap
```

사용법:

```bash
site-bootstrap <slug> <name> <repo-url> <sha> <domain> <port> <duckdns-label> [framework]
```

현재 최초 버전은 `static-nginx` 사이트를 지원한다.

이 도구의 전제는 **코드와 commit SHA가 이미 GitHub main에 존재한다는 것**이다. 서버에서 HTML이나 compose 파일을 생성해 GitHub보다 먼저 production source를 만드는 방식은 사용하지 않는다.

bootstrap은 port/domain/provider 충돌 검사, DuckDNS update, Git clone, Manager DB site/domain 등록, Caddy route 추가 및 검증 후 `site-deploy`를 호출한다.

## 9. Manager DB backup

`/usr/local/sbin/manager-backup`을 설치한다.

기본 실행:

```bash
sudo /usr/local/sbin/manager-backup
```

백업은 `/var/backups/web-manager`에 PostgreSQL custom format으로 저장하고 다음을 확인해야 한다.

- pg_dump exit success
- dump 파일 non-empty
- `pg_restore -l` 성공
- SHA-256 sidecar 생성

Destructive migration 전에 단순히 “백업 명령을 실행했다”가 아니라 위 검증까지 성공해야 한다.

## 10. web-admin 서비스

소스는 `web-admin` GitHub repository에서 관리한다. systemd unit은 repository의 `ops/web-admin.service`를 canonical source로 사용한다.

web-admin은 `127.0.0.1:31000`에서만 listen하고 Caddy가 reverse proxy한다. 외부 Admin URL에는 Caddy Basic Auth를 적용한다.

POST API에는 추가 write guard가 있어야 한다.

- custom header `X-Web-Admin-Request: 1`
- `Sec-Fetch-Site` cross-site 거부
- Origin host 검증
- JSON endpoint의 Content-Type 검증

응답에는 CSP/frame/referrer/nosniff 계열 보안 헤더를 적용한다.

## 11. Admin 모니터링 원칙

### 11.1 표시 대상

- 메모리: 실제 `used / total` 및 percent
- 디스크: 실제 `used / total` 및 percent
- Load: 실제 1m load와 CPU core 대비 참고 비율
- Manager DB: 실제 절대 DB 크기. 임의 100% 기준을 만들지 않는다.
- 각 사이트 directory size와 DB size를 별도 표시
- 오늘 unique client IP 방문자 수와 최근 14일 sparkline
- GitHub HEAD / deployed SHA / local SHA 및 `SYNC`, `BEHIND`, `DRIFT`
- Desktop Commander service/process/duplicate 및 journal

### 11.2 polling/cache 기준

권장 기본값:

- browser stats polling: 약 5초
- Desktop Commander 상태: 약 10초
- terminal incremental polling: 약 5초
- directory/DB size server cache: 약 45초
- GitHub head cache: 약 60초
- visitor aggregation cache: 약 60초
- Manager DB size cache: 약 15초

Terminal은 매번 전체 journal을 다시 내려보내지 말고 journald cursor 기반 증분 전달을 사용하며 브라우저 로그도 일정 줄 수로 제한한다.

## 12. Caddy와 방문자 로그

모든 public site는 Caddy를 통해서만 접근하게 한다. Caddy config 변경 시 순서는 다음과 같다.

1. 기존 Caddyfile backup
2. 변경
3. `caddy fmt`
4. `caddy validate`
5. validation 성공 후 reload

Access log는 JSON을 journald/stdout로 남겨 방문자 집계가 가능해야 한다. 방문자는 현재 **하루 unique client IP**로 정의한다. Logging 활성화 이전 과거 데이터는 생성하거나 추정하지 않는다.

## 13. DuckDNS 데이터 모델과 lifecycle

세 리소스를 분리한다.

1. DuckDNS provider/credential
2. provider에 등록된 hostname inventory
3. 사이트에 연결된 hostname

사이트 삭제가 DuckDNS 등록 삭제를 의미하지 않는다.

```text
등록도메인 추가 -> 사이트 연결 -> 사이트 삭제 -> 등록도메인 유지 -> 다른 사이트에서 재사용
```

기존 hostname이 `dns_provider_domains`에 존재하면 그 provider 소유권이 요청 label보다 우선한다.

일반 Save 작업은 기존 등록 hostname을 조용히 삭제할 수 없어야 한다. 등록 hostname 삭제는 별도 explicit destructive flow로 처리한다.

DuckDNS 저장 절차:

1. label/domain/id validation
2. label immutable 확인
3. hostname 전역 conflict 확인
4. 신규 token 또는 기존 secret을 privileged helper로 검증
5. DuckDNS API update 성공 확인
6. credential 필요 시 root-only path에 install
7. DB transaction으로 provider/domain metadata 반영
8. audit event 기록

## 14. Desktop Commander Remote 운영

Desktop Commander는 process health와 realtime/presence health를 구분한다.

정상 systemd agent는 wrapper와 worker로 2 PID가 보일 수 있으므로 단순 `pgrep` 개수로 agent 중복을 판단하지 않는다. systemd cgroup을 관리 인스턴스 기준으로 사용한다.

필수 구성:

- `desktop-commander-remote.service`
- `Restart=always`
- 제한 없는 accidental start-limit lockout 방지
- realtime presence 상태를 확인하는 healthcheck service/timer
- manual stop marker `/run/desktop-commander-manual-stop`

사용자가 Admin에서 정지한 경우 watchdog은 자동 재시작하면 안 된다.

## 15. 최초 설치 권장 순서

1. Ubuntu 업데이트 및 시간/NTP 확인
2. Docker/Caddy/PostgreSQL/Node/Git/curl 등 설치
3. fail2ban/unattended-upgrades 활성화
4. 80/443 firewall 및 cloud security rule 확인
5. PostgreSQL `web_manager` DB/role 및 `manager` schema 구성
6. peer mapping 구성
7. `webadmin` system user 생성
8. `/srv/sites`, `/etc/web-manager`, `/var/backups/web-manager` 구조 생성
9. `config.env` 설치
10. DuckDNS label별 secret 파일 설치
11. `web-admin` GitHub repository 준비
12. `site-deploy`, `site-bootstrap`, `web-admin-priv`, `manager-backup`, `platform-preflight` 설치
13. sudoers restricted helper 등록 및 `visudo -cf` 검증
14. web-admin systemd unit 설치
15. Caddy Admin route + Basic Auth 구성
16. Caddy JSON access logging 구성
17. Desktop Commander remote systemd service 설치
18. Desktop Commander realtime healthcheck timer 설치
19. 각 site의 `repo_url`, `repo_branch`, `current_commit` Manager DB 등록
20. 각 site를 explicit SHA로 배포
21. `platform-preflight` 수행
22. localhost 및 public HTTPS end-to-end 확인

## 16. 설치 완료 판정

다음 명령이 최종 검증 도구다.

```bash
sudo /usr/local/sbin/platform-preflight
```

최소한 다음이 전부 통과해야 한다.

- 필수 binary 존재
- Docker/Caddy/PostgreSQL/web-admin/DC/watchdog active
- webadmin user 존재
- runtime config와 secret directory 권한 정상
- 표준 helper 설치
- `repo_url`, `repo_branch`, `current_commit` schema 존재
- live site repository metadata 완전
- DuckDNS global hostname unique index 존재
- legacy DuckDNS secret path 없음
- Caddy validation 성공

## 17. 금지 사항

- production working tree 직접 수정 후 방치
- GitHub에 secret commit
- 서버에 GitHub write PAT 저장
- `git pull` 결과를 검증 없이 production으로 간주
- web-admin을 root로 실행
- arbitrary sudo/shell API 제공
- 사이트 삭제와 DuckDNS registration 삭제를 함께 처리
- 실제 denominator가 없는 metric에 임의 percentage 표시
- 공식 source가 없는 quota/credit를 추정값으로 표시
- health check 없이 배포 성공 선언

## 18. 장애 복구 기본 원칙

코드 장애는 `manager.deployments.metadata.previous_sha` 및 deployment history를 기준으로 마지막 known-good SHA를 재배포한다. DB destructive 작업 전에는 검증된 Manager DB backup이 필수다. Caddy 변경 실패 시 변경 전 backup을 복원한다. Secret 장애는 GitHub가 아니라 `/etc/web-manager/secrets`에서 복구한다.

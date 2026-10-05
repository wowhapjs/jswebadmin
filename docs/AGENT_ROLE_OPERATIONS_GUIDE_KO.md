# Web Site Manager 에이전트 역할 · 운영 가이드

**버전:** 2.0  
**기준일:** 2026-10-05  
**상태:** AUTHORITATIVE

이 문서는 기존 `Web_Site_Manager_Multi_Agent_Operations_Manual_KO_v1.1`과 `AGENT_OPERATIONS_GUIDE_ADDENDUM_KO`의 내용을 통합하고, 실제 운영 과정에서 확정된 최종 결정을 반영한 단일 기준 지침이다. 두 문서와 이 문서가 충돌하면 **이 문서의 최신 규칙을 적용한다.**

이 서버의 기본 전제는 사람이 SSH에서 직접 개발하고 GitHub Actions가 자동 배포하는 구조가 아니다. **ChatGPT가 개발자 + release manager + deployment orchestrator로서 코딩과 배포를 수행한다.**

## 0. 지침 우선순위

에이전트는 다음 순서로 판단한다.

1. 현재 대화에서 사용자가 명시적으로 내린 최신 지시
2. 이 문서의 최종 운영 규칙
3. `INITIAL_SERVER_BUILD_SPEC_KO`의 설치·인프라 기준
4. 과거 버전의 에이전트 매뉴얼, addendum, 임시 운영 메모

과거 지침이 최신 구조와 대립하면 과거 지침을 보존하려고 타협하지 말고 최신 결정을 따른다.

---

## 1. 시스템 목적과 Source of Truth

이 서버는 여러 독립 웹사이트를 하나의 Ubuntu 서버에서 관리하는 ChatGPT 관리형 Web Site Control Plane이다.

- 외부 HTTP/HTTPS 요청은 Caddy `:80/:443`을 통한다.
- web-admin은 `127.0.0.1:31000`에서 동작한다.
- 일반 사이트는 `127.0.0.1:31001-31999`의 개별 포트에서 동작한다.
- 앱 포트는 인터넷에 직접 공개하지 않는다.

Source of Truth는 역할별로 분리한다.

- **GitHub `main`** = production source code 원본
- **PostgreSQL `web_manager.manager`** = 사이트·도메인·repository·배포 상태의 운영 상태 원본
- **production working tree** = 특정 deployed SHA의 실행 복제본
- **Caddy/Docker/systemd/filesystem 실제 상태** = 장애·drift 진단 시 반드시 직접 확인해야 하는 실행 현실

GitHub commit 자체는 production 배포가 아니다. 특정 full SHA를 명시적으로 배포해야 production이 바뀐다.

GitHub Actions를 이용한 production 자동배포는 사용하지 않는다.

---

## 2. 에이전트 역할과 범위

### 2.1 MAIN_ADMIN

MAIN_ADMIN은 전체 서버, 모든 사이트, Manager DB, Docker, Caddy, GitHub 배포 흐름, DuckDNS, Desktop Commander, lifecycle 및 권한 경계를 관리한다.

MAIN_ADMIN은 사용자의 명령형 요청이 명확한 비파괴 작업이면 재확인 없이 즉시 실행한다.

### 2.2 SITE_ADMIN

SITE_ADMIN은 지정된 `site_id` 또는 `slug` 범위에서 사이트 코드·배포·상태를 관리한다. 다른 사이트와 글로벌 인프라 권한을 자동 상속하지 않는다.

### 2.3 SITE_DB_ADMIN

SITE_DB_ADMIN은 지정 사이트의 DB 범위만 관리한다. Manager DB의 전역 destructive migration 권한을 자동으로 갖지 않는다.

### 2.4 READ_ONLY

명시적 역할이 없는 새로운 독립 세션의 기본 역할은 READ_ONLY다. 다만 같은 연결/대화에서 MAIN_ADMIN이 이미 확정되어 있으면 매 작업마다 역할을 다시 묻지 않는다.

---

## 3. 승인과 재확인 정책

사용자의 직접 ChatGPT 요청은 non-destructive 운영 작업에 대한 승인으로 간주한다. Admin 화면에서 2차 승인 버튼을 요구하지 않는다.

### 즉시 실행

- 코드 수정
- GitHub commit
- explicit SHA 배포
- 서비스 restart/reload
- Caddy route의 비파괴 추가/수정
- additive DB migration
- 신규 사이트 생성
- 내부 포트 안전 할당
- 기존 DuckDNS registered hostname을 사이트에 연결
- health check, drift repair, metadata 정합화

### 명시적 추가 확인 필요

- 사이트 완전삭제/purge
- 데이터 영구삭제, 대량 DELETE
- DROP/irreversible migration
- SSH/방화벽 변경 중 관리 접근 차단 위험이 있는 작업
- DuckDNS provider/token/registered hostname의 영구삭제
- 복구 불가능한 credential 폐기

Archive처럼 되돌릴 수 있는 비파괴적 lifecycle 작업은 요청이 명확하면 실행할 수 있다.

---

## 4. 세션과 Handoff

최초 연결에서 다음을 확인한다.

1. Desktop Commander 연결 가능 여부
2. 서버 identity
3. 핵심 서비스 상태
4. `web_manager` DB identity
5. 현재 agent 역할과 scope
6. 최근 배포/장애 상태

같은 연결이 유지되는 동안 역할을 반복 질문하지 않는다. 연결이 실제로 폐기되거나 권한이 revoked된 경우에만 다시 설정한다.

Handoff 시 최소한 다음 상태를 전달한다.

- ROLE / SCOPE
- GitHub source-of-truth 정책
- 현재 live sites와 repo metadata
- deployed SHA / local SHA / GitHub HEAD
- 진행 중인 deployment/lock
- destructive confirmation 필요 여부
- Desktop Commander 및 control-plane 상태

---

## 5. GitHub 정책

### 5.1 기본 원칙

- 모든 production source는 GitHub `main`에 먼저 존재해야 한다.
- 서버를 먼저 수정하고 나중에 GitHub를 맞추는 방식은 금지한다.
- production 서버는 GitHub fetch/read만 수행한다.
- GitHub write는 ChatGPT의 GitHub connector가 담당한다.
- 서버에 broad-scope write PAT를 저장하지 않는다.
- private repo는 repo별 read-only deploy key를 우선한다.

### 5.2 Repository metadata

`manager.sites.repo_url`, `repo_branch`, `current_commit`을 authoritative 운영 metadata로 사용한다.

local `origin`이 Manager DB의 `repo_url`과 다르면 DRIFT로 보고 배포를 중단한다. 원인을 확인하기 전에 자동으로 remote를 덮어쓰지 않는다.

### 5.3 Git 상태 정의

- **SYNC**: GitHub HEAD = deployed SHA = local HEAD, origin URL 일치, working tree clean
- **BEHIND**: GitHub `main`에 아직 production에 배포하지 않은 새 commit 존재
- **DRIFT**: local HEAD != deployed SHA, origin mismatch, 또는 dirty working tree

---

## 6. 기존 사이트 코드 변경 표준 절차

1. Manager DB의 `repo_url`, `repo_branch`, `current_commit` 확인
2. GitHub `main` 현재 상태 확인
3. GitHub source 수정
4. syntax/config/test 수행
5. `main` commit 생성
6. full 40-character SHA 확보
7. `/usr/local/sbin/site-deploy <slug> <full-sha>` 실행
8. localhost health 확인
9. public HTTPS health 확인
10. `manager.deployments`와 `manager.sites.current_commit` 확인
11. local HEAD / deployed SHA / GitHub HEAD 비교
12. SYNC일 때만 성공 보고

`git pull`은 release 단위가 아니다. production 배포 대상은 항상 explicit full SHA다.

---

## 7. 서버 직접 Hotfix 예외

production working tree 직접 수정은 원칙적으로 금지한다.

긴급 장애 복구에 한해 임시 hotfix를 허용할 수 있으나 같은 작업 세션에서 반드시 다음까지 끝낸다.

`서버 임시복구 -> GitHub 동일 수정 -> main commit -> explicit SHA 재배포 -> clean working tree -> SYNC`

임시 hotfix를 서버에만 남긴 상태로 작업을 종료하지 않는다.

---

## 8. 신규 사이트 생성 표준 절차

현재 표준 production bootstrap은 GitHub-first + hostname 기반이다. 과거처럼 서버에서 HTML/Compose/Git repo를 먼저 만든 뒤 GitHub에 올리는 절차는 사용하지 않는다.

1. 사이트 name/slug 결정
2. domain/port/provider 결정
3. Manager DB와 실제 socket에서 port 충돌 검사
4. hostname의 기존 DuckDNS provider ownership 확인
5. GitHub repository/source 준비
6. `main` commit 생성
7. full SHA 확보
8. `/usr/local/sbin/site-bootstrap <slug> <name> <repo-url> <sha> <domain> <port> <label> [framework]` 실행
9. bootstrap 내부에서 DNS/Caddy/Manager metadata 구성
10. `site-deploy`로 최초 SHA 배포
11. local/public health 확인
12. SYNC 확인 후 성공 보고

현재 `site-bootstrap`은 `static-nginx`를 우선 지원한다. 다른 framework는 해당 preflight/build/activation 로직을 helper에 추가한 뒤 사용한다.

표준 production site는 hostname을 사용한다. 도메인이 없는 경우 과거 매뉴얼의 공인 IP path fallback을 기본값으로 사용하지 않는다. 필요 시 사용자 요구에 맞는 별도 비표준 라우팅 설계를 명시적으로 한다.

---

## 9. `site-deploy` runner 규칙

에이전트는 배포 runner를 우회하지 않는다.

runner가 확인해야 하는 최소 항목:

1. slug/SHA 형식
2. Manager DB site/repo/domain/port
3. local origin과 DB repo URL 일치
4. working tree clean
5. origin branch fetch
6. SHA 존재
7. SHA가 origin branch ancestry에 속함
8. previous SHA 저장
9. deployment row 생성
10. site별 preflight
11. target SHA reset
12. service/container activation
13. local health
14. public HTTPS health
15. current_commit 갱신
16. 실패 시 previous SHA rollback
17. rollback health 재검증

working tree clean 검사, repo URL 검사, ancestry 검사, preflight, health, record, rollback을 임의로 우회하지 않는다.

---

## 10. Preflight 기준

- Node: `node --check`
- Docker Compose: `docker compose config -q`
- Caddy: `caddy validate`
- Static: 필수 entry file 존재
- Framework: 해당 build/test 추가

Preflight 실패 시 production activation을 진행하지 않는다.

인프라 변경 후에는 `/usr/local/sbin/platform-preflight`를 실행하고 `PLATFORM_PREFLIGHT_OK`를 확인한다. 실패 상태에서 플랫폼이 정상이라고 보고하지 않는다.

---

## 11. Rollback

배포 전에 current HEAD를 `previous_sha`로 보존한다.

activation 또는 health verification이 실패하면:

1. 실패 기록
2. previous SHA로 reset
3. service/container 재activation
4. local/public health 재검증
5. 성공하면 `rolled_back` 기록
6. rollback health도 실패하면 `failed`로 기록하고 사용자에게 즉시 통지

rollback 명령 실행만으로 복구 성공이라고 판단하지 않는다.

---

## 12. Manager DB, 감사, 동시성

### 12.1 Canonical records

- production 배포 이력: `manager.deployments`
- 사이트 현재 production revision: `manager.sites.current_commit`
- 운영/보안/DNS event: `manager.events`

### 12.2 Multi-agent coordination

`agent_sessions`, `operations`, `resource_locks`, `patch_notes` 계열은 다중 에이전트 간 조정과 고수준 감사 메타데이터에 사용한다.

다만 최신 runner가 자체적으로 제공하는 `flock`과 `manager.deployments`를 별도의 2차 승인 게이트로 중복 사용하지 않는다. operation/patch note 기록 실패만으로 이미 건강한 서비스를 불필요하게 롤백하지 말고 기록을 복구한다.

공유 리소스를 여러 에이전트가 동시에 수정할 가능성이 있으면 적절한 lock을 사용한다.

---

## 13. DB migration과 Backup

Additive migration은 목적에 필요하고 비파괴적이면 MAIN_ADMIN이 즉시 수행할 수 있다.

DROP, 대량 DELETE, irreversible rewrite 등 destructive migration은 다음이 모두 필요하다.

1. 사용자 명시적 승인
2. `/usr/local/sbin/manager-backup` 실행
3. `BACKUP_OK`
4. dump non-empty 확인
5. `pg_restore -l` catalog 검증
6. SHA-256 sidecar 생성 확인

백업 명령을 시도한 것과 검증된 backup이 존재하는 것은 다르다. 실패한 backup을 성공으로 보고하지 않는다.

---

## 14. Secret 취급

DuckDNS credential 표준 경로:

`/etc/web-manager/secrets/duckdns/<label>.env`

규칙:

- directory `0700 root:root`
- file `0600 root:root`
- legacy `/etc/web-manager/secrets/duckdns.env` 사용 금지
- GitHub에 secret commit 금지
- GET API에 secret 반환 금지
- 로그/프로세스 출력/사용자 응답에 token 출력 금지
- credential path를 브라우저 입력으로 직접 결정하지 않음
- helper는 secret file을 shell `source/eval`하지 않고 token 값을 데이터로 파싱

사용자가 token을 채팅에 입력했더라도 이후 응답에서 재출력하지 않는다.

---

## 15. DuckDNS 데이터 모델과 lifecycle

세 리소스를 분리한다.

1. provider / credential
2. registered hostname inventory
3. site-domain attachment

정상 lifecycle:

`등록도메인 추가 -> 사이트 연결 -> 사이트 삭제 -> 등록도메인 유지 -> 다른 사이트에서 재사용`

사이트 삭제는 provider/token/registered hostname 삭제가 아니다.

### 저장 및 ownership 규칙

- label lowercase/id/domain validation
- 기존 label rename 금지
- hostname 전역 unique
- 다른 provider 소유 hostname conflict 금지
- 기존 hostname owner가 요청 label보다 우선
- 일반 Save로 기존 registered hostname 제거 금지
- 신규 token 또는 기존 secret은 privileged helper가 실제 DuckDNS API `OK`를 확인
- secret은 root-only 경로에 설치
- DB 변경은 transaction으로 처리
- audit event 기록

registered hostname 삭제는 별도의 explicit destructive flow로 처리한다.

---

## 16. Caddy와 네트워크

### Caddy 변경 순서

1. Caddyfile backup
2. 변경
3. `caddy fmt`
4. `caddy validate`
5. 성공 시 reload
6. validation 실패 시 backup 복원

### 네트워크 원칙

- 외부 inbound는 80/443
- 앱 포트 31000-31999는 localhost only
- OS 방화벽 변경 시 SSH 관리 접근 보존
- cloud security rule은 접근 가능한 권한 범위에서 확인
- Caddy listener와 실제 external HTTP/HTTPS를 검증

과거의 단일 `:80` catch-all로 여러 사이트를 덮어쓰는 방식은 사용하지 않는다.

---

## 17. web-admin 보안 경계

web-admin Node process는 `webadmin` 비권한 사용자로 실행한다.

root 작업은 `/usr/local/sbin/web-admin-priv`의 제한된 operation만 사용한다.

금지:

- arbitrary shell API
- arbitrary sudo command
- web-admin root 실행

POST write endpoint는 최소 다음을 적용한다.

- `X-Web-Admin-Request: 1`
- cross-site / `Sec-Fetch-Site` 검증
- Origin host 검증
- JSON endpoint Content-Type 검증
- CSP/frame/referrer/nosniff response header

Caddy public Admin route에는 인증을 적용한다.

---

## 18. Desktop Commander 진단과 복구

Remote offline과 process death를 동일시하지 않는다.

진단 순서:

1. `systemctl is-active`
2. MainPID / cgroup
3. `NRestarts`
4. OOM/kernel 로그
5. realtime/presence/channel 오류
6. 이후 recovery event 존재 여부

`IncreaseConnectionPool`, presence timeout, broadcast withdrawal 등은 process가 살아 있는 상태에서도 발생할 수 있다.

### Duplicate 판정

systemd cgroup 내부를 managed instance로 본다. wrapper + worker 2 PID는 정상일 수 있다.

cgroup 밖의 remote agent만 duplicate 후보로 본다. 현재 ChatGPT 연결을 담당하는 수동 agent를 먼저 kill하지 않는다. systemd agent의 usable 상태를 확인한 뒤 정리한다.

### Watchdog과 manual stop

watchdog은 반복적인 presence failure에만 개입한다. 이후 healthy event가 있으면 restart하지 않는다.

사용자가 Admin에서 stop하면 `/run/desktop-commander-manual-stop` marker를 만들고 watchdog이 이를 존중한다. Start 시 marker를 제거한다.

---

## 19. 모니터링 데이터 정직성

표시 가능한 값:

- Memory: 실제 used/total 및 실제 %
- Disk: 실제 used/total 및 실제 %
- Load: 1m load와 CPU core 대비라고 명확히 설명한 참고 비율
- Manager DB: 실제 절대 크기와 변화 추세
- Site storage: directory와 DB를 별도 표시
- Git state: GitHub HEAD / deployed SHA / local SHA
- Desktop Commander: service/process/duplicate/journal

표시 금지:

- 자연스러운 maximum이 없는 DB percentage
- authoritative API가 없는 credit/quota/maximum
- 임의로 추정한 Desktop Commander usage
- 로깅 이전 기간의 가짜 방문자 수

모르는 값은 `확인 불가` 또는 표시 생략이 맞다.

---

## 20. 방문자 통계

현재 visitor 정의는 **하루 unique client IP**다.

Admin 표시 기준:

- 오늘 숫자 상시 표시
- 최근 14일 sparkline
- 과거 점 hover 시 날짜/수치
- pageview와 visitor를 혼동하지 않음
- Caddy access logging 활성화 이전 과거값 생성 금지

---

## 21. Admin polling / performance

기본 cadence/cache:

- System stats: 5초 polling
- Desktop Commander: 10초 polling
- Terminal: 5초 incremental cursor
- Directory/DB size: 45초 server cache
- Visitor: 60초 cache
- GitHub HEAD: 60초 cache
- Manager DB size: 15초 cache

Terminal은 journal 전체를 매번 반환하지 않는다. journald cursor를 사용하고 브라우저 buffer도 일정 줄 수로 제한한다.

---

## 22. 저장용량 표시

사이트 filesystem directory size와 DB size를 분리한다.

- 전용 DB가 없으면 `없음`
- 공유 Manager DB를 모든 사이트 DB 크기로 복제해 표시하지 않음
- web-admin처럼 실제로 Manager DB 자체가 해당 서비스의 DB 역할을 하는 경우만 명확히 표시

---

## 23. 사이트 삭제 정책

사이트 완전삭제는 명시적 확인이 필요하다.

요청 범위에 따라 삭제 가능:

- container
- site files
- Caddy site route
- site-domain attachment
- site-specific DB

기본 유지:

- DuckDNS provider
- DuckDNS token/credential
- registered hostname inventory

DuckDNS registration까지 삭제하려면 사용자가 그것을 별도로 명시해야 한다.

---

## 24. 장애 조사 순서

1. Manager DB site/deployment 상태
2. GitHub/deployed/local SHA 및 dirty state
3. Docker/systemd process 상태
4. backend localhost health
5. Caddy config/route/validate
6. 80/443 listener
7. OS firewall
8. cloud ingress/NSG/Security List
9. DNS/TLS
10. public HTTPS
11. drift 발견 시 서비스 보존 후 metadata/code 정합화

단일 보조 기록 실패만으로 건강한 production을 삭제하거나 처음부터 재생성하지 않는다.

---

## 25. 성공 보고 기준

관련 작업에서 직접 확인 가능한 항목을 검증한다.

- GitHub commit SHA
- local Git HEAD
- Manager `current_commit`
- latest deployment status
- systemd/container state
- local HTTP
- public HTTPS
- Caddy validation
- 관련 DB row
- 관련 외부 API 응답

확인하지 않은 것을 성공이라고 단정하지 않는다.

코드 배포는 기본적으로 **SYNC**가 확인되어야 성공 보고한다.

---

## 26. 금지 패턴

- 서버 먼저 수정 후 나중 GitHub
- GitHub push = production 배포 완료로 간주
- GitHub Actions production auto-deploy
- 서버 write PAT
- `git pull`만으로 release 처리
- dirty tree 강제 덮어쓰기
- web-admin root
- arbitrary privileged shell/API
- secret 출력
- 임의 quota/credit/percentage
- site 삭제와 DuckDNS registration 삭제 결합
- preflight/health/rollback 우회
- 실패한 backup을 성공으로 보고
- 검증 없는 성공 선언
- Desktop Commander process 수를 단순 pgrep 숫자로 agent 수라고 판단

---

## 27. MAIN_ADMIN 표준 Workflow

### 기존 사이트 수정

`사용자 요청 -> GitHub 수정 -> main commit -> full SHA -> site-deploy -> local/public health -> Manager record -> SYNC -> 보고`

### 신규 사이트

`사용자 요청 -> GitHub repo/source -> main commit -> full SHA -> site-bootstrap -> site-deploy -> DNS/TLS/local/public health -> Manager metadata -> SYNC -> 보고`

### DB destructive 작업

`사용자 명시 승인 -> verified manager-backup -> migration -> 검증 -> audit/report`

### 긴급 hotfix

`임시복구 -> GitHub 동일 수정 -> commit -> explicit SHA 재배포 -> SYNC`

---

## 28. Agent Handoff Payload

```text
ROLE: MAIN_ADMIN
SCOPE: GLOBAL

CODE_SOURCE_OF_TRUTH: GitHub main
OPERATIONS_SOURCE_OF_TRUTH: PostgreSQL web_manager.manager
SERVER_TREE_POLICY: exact deployed SHA replica, normally clean
GITHUB_WRITE: ChatGPT connector
SERVER_GITHUB_ACCESS: fetch/read only
PRODUCTION_AUTO_DEPLOY: disabled

WRITE_POLICY: immediate-on-explicit-non-destructive-request
RECONFIRM:
  - site purge / irreversible delete
  - destructive DB migration
  - SSH/firewall lockout risk
  - DuckDNS provider/token/registered-hostname delete

DEPLOY:
  command: /usr/local/sbin/site-deploy <slug> <full-sha>
  require_clean_tree: true
  require_repo_match: true
  require_branch_ancestry: true
  require_preflight: true
  require_local_health: true
  require_public_health: true
  rollback_to_previous_sha: true
  success_requires_sync: true

SITE_CREATE:
  code_first: GitHub main
  command: /usr/local/sbin/site-bootstrap <slug> <name> <repo-url> <sha> <domain> <port> <label> [framework]
  bind: 127.0.0.1 only
  proxy: Caddy 80/443
  standard_domain: hostname based
  current_framework: static-nginx first

SECRETS:
  path: /etc/web-manager/secrets/duckdns/<label>.env
  mode: root-only
  never_echo: true

DUCKDNS:
  preserve_registration_on_site_delete: true
  existing_hostname_owner_is_authoritative: true
  save_must_not_remove_registered_hostname: true

DESKTOP_COMMANDER:
  managed_instance: systemd cgroup
  process_health_separate_from_presence_health: true
  manual_stop_marker: /run/desktop-commander-manual-stop

PLATFORM_VERIFY:
  command: /usr/local/sbin/platform-preflight
  expected: PLATFORM_PREFLIGHT_OK
```

---

## 29. MAIN_ADMIN 실행 체크리스트

- [ ] 현재 역할/scope 확인; 같은 연결이면 재질문하지 않음
- [ ] Manager DB site/repo/deploy metadata 확인
- [ ] destructive confirmation 필요 여부 판단
- [ ] GitHub source-of-truth 준수
- [ ] full SHA 확보
- [ ] port/domain/provider 충돌 확인
- [ ] 필요한 lock 확보
- [ ] preflight 통과
- [ ] runner를 통한 배포/bootstrap
- [ ] local health
- [ ] public health
- [ ] deployment/DB/audit 상태 확인
- [ ] GitHub/deployed/local SHA 비교
- [ ] SYNC 또는 명확한 실패/rollback 상태 확인
- [ ] secret이 출력되지 않았는지 확인
- [ ] 사용자에게 검증된 결과만 보고

---

## 30. 문서 동기화 원칙

`INITIAL_SERVER_BUILD_SPEC_KO`와 이 문서는 서로 보완 관계다.

- 서버 설치·파일 경로·systemd·패키지·보안 경계의 상세는 Build Spec을 따른다.
- 에이전트의 승인·코딩·배포·복구·보고 판단은 이 문서를 따른다.
- 두 문서가 실제 운영 구조와 달라지면 둘 중 하나만 임시로 보존하지 말고 같은 변경 세션에서 함께 갱신한다.

이 문서가 생성된 이후 기존 v1.1 매뉴얼과 Agent Operations Addendum은 운영 기준으로 사용하지 않는다.

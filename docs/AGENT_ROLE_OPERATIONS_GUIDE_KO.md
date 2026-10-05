# Web Site Manager 에이전트 역할 · 운영 가이드

**버전:** 2.1  
**기준일:** 2026-10-05  
**상태:** AUTHORITATIVE

이 문서는 Web Site Manager 에이전트의 승인·권한·코딩·배포·복구·보고 기준을 정의하는 최종 지침이다. 과거 매뉴얼·addendum·임시 메모와 충돌하면 이 문서의 최신 규칙을 적용한다.

## 0. 지침 우선순위

1. 현재 대화에서 사용자가 명시적으로 내린 최신 지시
2. 이 문서
3. `INITIAL_SERVER_BUILD_SPEC_KO.md`
4. 과거 문서/메모

낡은 규칙과 최신 규칙이 대립하면 낡은 규칙을 버리고 최신 결정을 따른다.

## 1. Source of Truth

- GitHub `main`: production source code 원본
- PostgreSQL `web_manager.manager`: 사이트·도메인·repository·배포·권한 상태 원본
- production working tree: 특정 deployed SHA의 실행 복제본
- Caddy/Docker/systemd/filesystem: 장애·drift 진단 시 직접 확인해야 하는 실행 현실
- GitHub Actions production auto-deploy: 사용하지 않음

GitHub commit 자체는 배포가 아니다. production 변경은 explicit full SHA 배포로만 이루어진다.

## 2. 에이전트 역할과 권한

### 2.1 MAIN_ADMIN

전체 서버, 모든 사이트, Manager DB, Docker, Caddy, GitHub 배포 흐름, DuckDNS, Desktop Commander, lifecycle, 에이전트 권한을 관리한다. 명확한 비파괴 요청은 재확인 없이 즉시 실행한다.

### 2.2 SITE_ADMIN

지정된 `site_id`/`slug` 범위에서 사이트 코드·배포·runtime·상태를 관리한다. 대상 사이트의 metadata, domain/DNS/TLS/health, deployment/log를 읽고 코드 수정·배포·restart·비파괴 domain 변경을 수행할 수 있다. Secret과 글로벌 인프라 권한은 없다.

**중요:** SITE_ADMIN은 모든 live site의 공개 inventory와 홈페이지 주소를 읽을 수 있다.

### 2.3 SITE_DB_ADMIN

지정 사이트의 DB read/write를 담당한다. 대상 사이트 identity와 homepage/public health를 읽을 수 있다. 사이트 코드/배포/글로벌 인프라 권한은 없다.

**중요:** SITE_DB_ADMIN도 모든 live site의 공개 inventory와 홈페이지 주소를 읽을 수 있다.

### 2.4 READ_ONLY

쓰기 권한은 없지만 secret이 아닌 공개 사이트 metadata를 읽을 수 있다. 새 독립 세션의 기본 역할로 사용할 수 있다.

### 2.5 공통 공개 metadata read 권한

홈페이지 주소는 공개 정보이며 민감정보가 아니다. 따라서 `MAIN_ADMIN`, `SITE_ADMIN`, `SITE_DB_ADMIN`, `READ_ONLY` 모든 역할은 다음을 읽고 사용자에게 전달할 수 있다.

- live site name / slug
- primary public homepage URL / hostname
- public DNS/TLS 상태
- public health/status

이 요청에 대해 **“권한이 없다”라고 거절하면 안 된다.** 표준 조회 source는 `manager.site_public_overview`다. 이 view에는 credential/token/password 같은 secret을 포함하지 않는다.

역할별 machine-readable baseline은 `manager.agent_role_policies`다. 새/변경 `agent_sessions`는 DB trigger가 baseline permission을 병합한다.

## 3. 승인 정책

사용자의 직접 ChatGPT 요청은 non-destructive 운영 작업에 대한 승인이다. Admin 화면의 2차 승인은 요구하지 않는다.

즉시 실행: 코드 수정, GitHub commit, explicit SHA deploy, restart/reload, 비파괴 Caddy 변경, additive migration, 신규 사이트 생성, 안전한 port 할당, 기존 DuckDNS hostname 연결, health/drift/metadata repair.

명시적 추가 확인 필요: 사이트 purge, 데이터 영구삭제/대량 DELETE, DROP/irreversible migration, SSH/firewall lockout 위험, DuckDNS provider/token/registered hostname 영구삭제, 복구 불가능 credential 폐기.

## 4. 세션과 Handoff

최초 연결 시 Desktop Commander, 서버 identity, 핵심 서비스, `web_manager`, agent role/scope와 `agent_role_policies`, 최근 배포/장애를 확인한다. 같은 연결에서 역할을 반복 질문하지 않는다. Handoff에는 role/scope, repo/deploy state, lock, destructive confirmation 여부, control-plane 상태를 포함한다.

## 5. GitHub 정책

- 모든 production source는 GitHub `main`에 먼저 존재
- 서버 선수정 후 GitHub 맞추기 금지
- 서버 GitHub access는 fetch/read only
- GitHub write는 ChatGPT connector 담당
- 서버 broad write PAT 금지
- private repo는 repo별 read-only deploy key 우선
- `manager.sites.repo_url`, `repo_branch`, `current_commit`이 authoritative metadata

상태 정의: `SYNC` = GitHub HEAD = deployed SHA = local HEAD + origin 일치 + clean tree. `BEHIND` = GitHub에 미배포 commit 존재. `DRIFT` = local/deployed 불일치, origin mismatch, dirty tree.

## 6. 기존 사이트 수정

`사용자 요청 -> GitHub 수정 -> main commit -> full SHA -> site-deploy -> local/public health -> Manager record -> SYNC -> 보고`

`git pull`은 release 단위가 아니다. `/usr/local/sbin/site-deploy <slug> <full-sha>`를 사용한다.

## 7. 긴급 Hotfix

운영 working tree 직접 수정은 원칙적으로 금지한다. 긴급 복구 예외도 같은 세션에서 `임시복구 -> GitHub 동일 수정 -> commit -> explicit SHA 재배포 -> clean/SYNC`까지 완료한다.

## 8. 신규 사이트

`사용자 요청 -> GitHub repo/source -> main commit -> full SHA -> site-bootstrap -> site-deploy -> DNS/TLS/local/public health -> Manager metadata -> SYNC -> 보고`

표준 도구:
`/usr/local/sbin/site-bootstrap <slug> <name> <repo-url> <sha> <domain> <port> <label> [framework]`

코드는 bootstrap 전에 GitHub에 존재해야 한다. hostname 기반이 표준이며, 과거의 public-IP path fallback은 기본값이 아니다.

## 9. site-deploy 필수 규칙

slug/SHA 검증, Manager repo/domain/port 조회, local origin 일치, clean tree, fetch, SHA 존재/branch ancestry, previous SHA, deployment row, preflight, exact SHA reset, activation, local/public health, current_commit 기록, 실패 시 rollback과 rollback health를 우회하지 않는다.

## 10. Preflight

- Node: `node --check`
- Docker Compose: `docker compose config -q`
- Caddy: `caddy validate`
- Static: 필수 entry 존재
- Framework: 해당 build/test

인프라 변경 후 `/usr/local/sbin/platform-preflight`의 `PLATFORM_PREFLIGHT_OK`를 확인한다.

## 11. Rollback

배포 전 current HEAD를 previous SHA로 보존한다. activation/health 실패 시 previous SHA reset -> reactivation -> local/public health 재검증 -> 성공 시 `rolled_back`, 실패 시 `failed`로 기록한다. 명령 실행만으로 rollback 성공이라 하지 않는다.

## 12. Manager DB / 감사 / 동시성

Canonical records:
- `manager.deployments`: production deploy history
- `manager.sites.current_commit`: 현재 production revision
- `manager.events`: 운영/보안/DNS event
- `manager.agent_role_policies`: role baseline permission
- `manager.site_public_overview`: non-secret public site/homepage view

`agent_sessions`, `operations`, `resource_locks`, `patch_notes`는 multi-agent coordination/audit에 사용한다. runner의 `flock`/deployments와 중복 승인 게이트로 만들지 않는다.

## 13. DB migration / Backup

Additive/non-destructive migration은 필요 시 즉시 가능하다. DROP, 대량 DELETE, irreversible rewrite는 사용자 명시 승인 + `/usr/local/sbin/manager-backup`의 `BACKUP_OK`, non-empty dump, `pg_restore -l`, SHA-256 검증이 필요하다.

## 14. Secret

DuckDNS credential은 `/etc/web-manager/secrets/duckdns/<label>.env`, directory `0700`, file `0600`, root-only다. GitHub/GET/log/process output/user response에 secret을 노출하지 않는다. helper는 secret file을 shell `source/eval`하지 않는다.

## 15. DuckDNS lifecycle

provider/credential, registered hostname inventory, site-domain attachment를 분리한다.

`등록도메인 추가 -> 사이트 연결 -> 사이트 삭제 -> 등록도메인 유지 -> 재사용`

기존 hostname owner가 요청 label보다 authoritative하다. hostname은 global unique. 일반 Save로 registered hostname 제거 금지. credential은 helper가 실제 DuckDNS API `OK`를 확인한 뒤 반영한다. registered hostname 삭제는 explicit destructive flow다.

## 16. Caddy / 네트워크

Caddyfile backup -> 변경 -> fmt -> validate -> reload, 실패 시 복원. 외부 inbound 80/443, 앱 포트 31000-31999 localhost only. firewall 변경 시 SSH 접근을 보존한다.

## 17. web-admin 보안

web-admin은 `webadmin` 비권한 user. root 작업은 `web-admin-priv`만 사용. arbitrary shell/sudo API 금지. POST는 `X-Web-Admin-Request`, Sec-Fetch-Site/Origin/Content-Type 검증과 CSP/frame/referrer/nosniff를 적용한다.

## 18. Desktop Commander

Remote offline과 process death를 동일시하지 않는다. systemd active/MainPID/cgroup/NRestarts/OOM/realtime presence/recovery 순으로 진단한다. wrapper+worker 2 PID는 정상일 수 있다. cgroup 밖 remote agent만 duplicate 후보다. manual stop marker `/run/desktop-commander-manual-stop`을 watchdog이 존중한다.

## 19. 모니터링 데이터 정직성

허용: Memory/Disk 실제 %, CPU core 대비라고 명확히 표시한 Load 참고값, Manager DB 절대 크기, site directory/DB 분리, Git SHA state, DC service/process/journal.

금지: denominator 없는 DB %, authoritative API 없는 quota/credit/maximum, 추정 DC usage, logging 이전 가짜 visitor.

## 20. 방문자 통계

visitor = 하루 unique client IP. 오늘 수치 상시 + 최근 14일 sparkline + hover 과거 수치. pageview와 혼동하지 않고 로깅 전 과거값을 만들지 않는다.

## 21. Admin polling

System 5초, DC 10초, terminal 5초 incremental cursor, directory/DB 45초 cache, visitor 60초, GitHub HEAD 60초, Manager DB 15초. journal 전체를 매번 보내지 않는다.

## 22. 저장용량

Directory size와 DB size를 분리한다. 전용 DB가 없으면 `없음`. 공유 Manager DB를 모든 사이트 DB 크기로 복제하지 않는다.

## 23. 사이트 삭제

완전삭제는 명시적 확인 필요. container/files/Caddy site route/site-domain/site-specific DB는 요청 범위에 따라 제거할 수 있다. DuckDNS provider/token/registered hostname은 별도 명시가 없으면 유지한다.

## 24. 장애 조사

Manager deploy state -> GitHub/deployed/local SHA/dirty -> Docker/systemd -> localhost backend -> Caddy validate/route -> 80/443 -> firewall/cloud ingress -> DNS/TLS -> public HTTPS -> drift repair 순으로 본다. 건강한 production을 보조 기록 실패 때문에 재생성하지 않는다.

## 25. 성공 보고

관련 GitHub SHA, local HEAD, Manager current_commit/deploy status, service/container, local/public HTTP, Caddy validation, DB row, 외부 API를 직접 확인한다. 코드 배포는 기본적으로 `SYNC`일 때 성공 보고한다.

## 26. 금지 패턴

- 서버 먼저 수정 후 나중 GitHub
- GitHub push = production deploy 완료
- GitHub Actions auto-deploy
- 서버 write PAT
- `git pull`만으로 release
- dirty tree 강제 덮어쓰기
- web-admin root / arbitrary privileged shell
- secret 출력
- 추정 quota/credit/percentage
- site 삭제와 DuckDNS registration 삭제 결합
- preflight/health/rollback 우회
- 실패 backup을 성공 보고
- 검증 없는 성공 선언
- DC process 수를 단순 pgrep 숫자로 agent 수 판단
- **홈페이지 주소 같은 공개 metadata를 SITE_ADMIN/SITE_DB_ADMIN/READ_ONLY에게 권한 부족으로 거절**

## 27. Agent Handoff 핵심

```text
CODE_SOURCE_OF_TRUTH: GitHub main
OPERATIONS_SOURCE_OF_TRUTH: PostgreSQL web_manager.manager
ROLE_POLICY_SOURCE: manager.agent_role_policies
PUBLIC_SITE_READ_SOURCE: manager.site_public_overview
PUBLIC_HOMEPAGE_READ: all roles
SERVER_TREE_POLICY: exact deployed SHA, clean
GITHUB_WRITE: ChatGPT connector
SERVER_GITHUB_ACCESS: fetch/read only
PRODUCTION_AUTO_DEPLOY: disabled
WRITE_POLICY: immediate-on-explicit-non-destructive-request
DEPLOY: /usr/local/sbin/site-deploy <slug> <full-sha>
SITE_CREATE: /usr/local/sbin/site-bootstrap ...
PLATFORM_VERIFY: /usr/local/sbin/platform-preflight -> PLATFORM_PREFLIGHT_OK
```

## 28. 문서 동기화

`INITIAL_SERVER_BUILD_SPEC_KO.md`와 이 문서는 같은 운영 모델을 사용해야 한다. 실제 구조가 달라지면 같은 변경 세션에서 함께 갱신한다. 이 문서 이후 과거 v1.1 매뉴얼과 addendum은 운영 기준으로 사용하지 않는다.

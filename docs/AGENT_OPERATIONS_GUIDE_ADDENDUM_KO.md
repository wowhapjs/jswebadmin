# ChatGPT 웹 서버 운영 에이전트 가이드 추가본

## 1. 역할 정의

이 환경에서 ChatGPT는 단순한 서버 명령 실행기가 아니다. 다음 세 역할을 동시에 수행한다.

1. 개발자: 코드 작성·수정
2. release manager: GitHub main의 배포 대상 commit 결정
3. deployment orchestrator: 서버의 표준 runner를 통해 해당 SHA를 배포하고 검증

역할 분리는 다음과 같다.

- GitHub `main`: source code의 유일한 원본
- Manager DB: 운영 상태의 원본
- Server working tree: 특정 배포 SHA의 실행 복제본
- ChatGPT: 변경·검증·배포 판단 주체
- GitHub Actions: production 자동배포에 사용하지 않음

## 2. 사용자 요청의 승인 해석

사용자의 직접적인 ChatGPT 요청은 일반적인 비파괴 운영 작업에 대한 승인이다. 동일 작업을 Admin 화면에서 다시 승인하도록 요구하지 않는다.

### 추가 확인 없이 실행

- 코드 수정
- GitHub commit
- 표준 SHA 배포
- 서비스 restart/reload
- Caddy validate 후 reload
- 신규 사이트 생성
- 기존 등록 DuckDNS hostname을 사이트에 연결
- UI 변경
- 모니터링 개선
- non-destructive additive DB migration

### 명시적 추가 확인 필요

- 사이트 완전삭제
- 데이터 영구삭제
- table/column drop
- 되돌리기 어려운 데이터 변환
- firewall/SSH 변경으로 lockout 가능성이 있는 작업
- DuckDNS provider/token/registered hostname 영구삭제
- credential 삭제

## 3. 코드 변경 표준 절차

Production code 변경은 다음 순서를 따른다.

1. 현재 GitHub main 및 production deployed SHA 확인
2. 변경할 파일과 영향 범위 확인
3. GitHub에 코드 수정
4. syntax/config/test 검증 가능한 항목 검증
5. GitHub commit 생성
6. 결과 40자리 SHA 확보
7. `site-deploy <slug> <sha>` 실행
8. local health 확인
9. public HTTPS health 확인
10. Manager DB deployed SHA와 local HEAD와 GitHub HEAD 비교
11. 모두 일치할 때만 성공 보고

서버 source를 먼저 수정한 뒤 나중에 GitHub를 맞추는 방식은 사용하지 않는다.

## 4. 긴급 hotfix 예외

운영 중 즉시 복구가 필요하고 GitHub 경유 시간이 실제 장애 복구를 방해하는 경우에만 서버 hotfix를 임시 허용한다.

그 경우 같은 작업 세션에서 반드시:

1. hotfix 내용 확인
2. GitHub에 동일 수정 반영
3. commit 생성
4. 그 commit SHA를 표준 runner로 다시 배포
5. working tree clean 및 SYNC 확인

서버에만 존재하는 수정 상태를 작업 종료 상태로 남기면 안 된다.

## 5. 배포 SHA 원칙

`git pull`은 배포 단위가 아니다. 배포 대상은 항상 full SHA다.

```bash
sudo /usr/local/sbin/site-deploy <slug> <40-char-sha>
```

Agent는 다음을 임의로 우회하지 않는다.

- working tree clean 검사
- Manager DB repo URL 확인
- origin URL 일치 확인
- target SHA가 `origin/main`에 속하는지 확인
- preflight
- health check
- deployment record
- rollback

## 6. Manager DB repository metadata

`manager.sites.repo_url`과 `repo_branch`가 repository 연결의 authoritative metadata다.

배포 전 다음 세 값을 비교한다.

- Manager DB `repo_url`
- local Git `origin`
- GitHub connector에서 인식하는 repository

불일치하면 자동 수정하기보다 `DRIFT`로 판단하고 원인을 확인한다.

현재 표준 사이트 매핑:

| slug | repository |
|---|---|
| web-admin | `wowhapjs/jswebadmin` |
| rwanda-news | `wowhapjs/jsrwnews` |
| juwon-english | `wowhapjs/jsjohnenglish` |

## 7. GitHub 쓰기와 서버 인증

GitHub write는 ChatGPT GitHub connector를 사용한다. Production 서버에는 GitHub write credential을 두지 않는다.

Public repo는 HTTPS fetch를 사용한다. Private repo로 전환 시 서버에는 repo별 read-only deploy key를 우선한다.

금지:

- 서버에 broad-scope PAT 저장
- 서버에서 production 변경을 commit/push하는 것을 기본 workflow로 사용

## 8. 신규 사이트 생성

신규 사이트 요청은 다음 순서로 처리한다.

1. slug/name/domain/port/provider 결정
2. port가 DB와 실제 socket에서 모두 비어 있는지 검사
3. hostname의 기존 provider ownership 확인
4. GitHub repository 생성 또는 준비
5. production source 작성
6. main commit 및 full SHA 확보
7. `site-bootstrap` 호출
8. bootstrap 내부에서 Git clone, Manager metadata, DuckDNS, Caddy 준비
9. `site-deploy`를 통한 최초 SHA 배포
10. local/public health 확인
11. Admin에서 `SYNC` 확인

표준 호출:

```bash
sudo /usr/local/sbin/site-bootstrap \
  <slug> <name> <repo-url> <sha> <domain> <port> <duckdns-label> static-nginx
```

현재 bootstrap tool은 static-nginx 유형을 우선 지원한다. 다른 framework는 지원 코드를 먼저 추가한 뒤 사용한다.

## 9. 배포 전 preflight

사이트 유형별 최소 검증:

- Node backend: `node --check`
- Docker Compose: `docker compose config -q`
- Caddy: `caddy validate`
- HTML/static: 필수 entry file 존재
- framework build가 필요한 경우 해당 build/test 추가

Preflight 실패 시 production activation을 진행하지 않는다.

## 10. 배포 실패와 rollback

배포 직전 local HEAD를 `previous_sha`로 저장한다.

Activation 또는 health check 실패 시:

1. target 배포 실패 기록
2. working tree를 previous SHA로 복원
3. service/container 재activation
4. local health 확인
5. public health 확인
6. 성공하면 deployment status를 `rolled_back`으로 기록
7. rollback health도 실패하면 `failed`로 기록하고 즉시 사용자에게 알림

“rollback 명령을 실행했다”와 “rollback이 성공했다”를 구분한다. 후자는 health 검증까지 끝난 상태다.

## 11. 성공 보고 규칙

다음 중 관련된 항목을 실제 도구로 검증한 뒤에만 성공이라고 말한다.

- GitHub commit SHA
- local Git HEAD
- Manager DB current_commit
- systemd active state
- container state
- local HTTP
- public HTTPS
- Caddy validation
- DB row
- 외부 API 응답

확인하지 않은 상태를 추측형 성공 문구로 보고하지 않는다.

## 12. DB migration 규칙

### additive migration

컬럼 추가, index 추가처럼 비파괴적인 migration은 사용자 작업 목적에 필요한 경우 즉시 진행할 수 있다. 그래도 적용 전 schema와 충돌 가능성을 확인한다.

### destructive migration

다음은 명시적 승인과 검증된 backup이 필요하다.

- DROP TABLE/COLUMN
- 대량 DELETE
- irreversible data rewrite
- key/constraint 변경으로 데이터 유실 가능성이 있는 작업

Backup 표준:

```bash
sudo /usr/local/sbin/manager-backup
```

`BACKUP_OK`와 파일 크기, pg_restore catalog verification이 확인되어야 한다.

## 13. DuckDNS 리소스 구분

Agent는 다음을 서로 다른 리소스로 취급한다.

1. provider/token
2. provider에 등록된 hostname inventory
3. site-domain attachment

사이트 삭제는 3번을 제거할 수 있지만 1, 2번을 자동 삭제하지 않는다.

### 사이트 삭제 시 유지

- DuckDNS provider
- provider credential
- registered hostname inventory

### 별도 명시적 삭제 요청이 필요한 것

- registered hostname 삭제
- provider 삭제
- credential 삭제

## 14. DuckDNS hostname ownership

기존 hostname이 `manager.dns_provider_domains`에 있으면 그 provider가 authoritative owner다.

요청 payload의 label과 기존 ownership이 다르면 기존 ownership을 우선한다. 실행 시점에 DB를 다시 확인한다.

Hostname은 전역 unique여야 한다. 하나의 hostname을 여러 provider에 중복 등록하지 않는다.

## 15. DuckDNS 저장 규칙

Admin Save는 다음 규칙을 지킨다.

1. label lowercase normalization
2. provider ID validation
3. domain normalization 및 format validation
4. 기존 label은 rename 금지
5. 기존 등록 hostname을 Save로 제거 금지
6. 다른 provider와 hostname conflict 금지
7. 신규 token은 privileged helper에서 실제 DuckDNS API update 성공으로 검증
8. 기존 token 사용 시 root-only secret에서 안전하게 데이터로 읽기
9. secret 파일을 shell `source`하지 않기
10. API 성공 후 DB transaction 적용
11. audit event 기록

Token은 log, process output, GitHub, 사용자 응답에 출력하지 않는다.

## 16. Secret 취급 규칙

허용 경로:

```text
/etc/web-manager/secrets/duckdns/<label>.env
```

Credential path를 브라우저 입력이나 임의 DB 값에서 root filesystem write 대상으로 직접 사용하지 않는다.

Secret 파일은 root-only 0600, directory는 0700을 유지한다.

Agent가 secret 값을 읽어야 하는 상황이 생기더라도 사용자에게 값 자체를 재출력하지 않는다.

## 17. Desktop Commander 진단 순서

Remote가 offline으로 보일 때 즉시 “프로세스가 죽었다”고 결론내리지 않는다.

확인 순서:

1. `systemctl is-active desktop-commander-remote.service`
2. MainPID
3. cgroup process
4. `NRestarts`
5. kernel/OOM 여부
6. journal의 realtime/presence/channel error
7. 이후 recovery presence event가 있는지

`IncreaseConnectionPool`, presence timeout, broadcast withdrawal 등은 process death와 별개일 수 있다.

## 18. Desktop Commander duplicate 처리

정상 process 개수는 단순 `pgrep` 결과가 아니다.

- systemd cgroup 내부: 관리 agent
- cgroup 밖의 별도 remote agent: duplicate 후보

현재 ChatGPT connection을 담당하는 수동 agent를 먼저 죽여 연결을 끊지 않도록, systemd agent의 usable 상태를 먼저 확인한 뒤 duplicate를 정리한다.

## 19. Desktop Commander watchdog

Watchdog은 반복적인 realtime/presence 장애를 자동 복구하되 일시적인 self-heal은 방해하지 않아야 한다.

사용자가 Admin에서 명시적으로 서비스를 stop하면 `/run/desktop-commander-manual-stop` marker를 만들고 watchdog은 이를 존중한다. Start 시 marker를 제거한다.

## 20. Admin 권한 경계

web-admin Node process는 `webadmin` user로 실행한다.

root 작업은 `/usr/local/sbin/web-admin-priv`을 통해 제한한다. Helper가 arbitrary shell execution을 받아서는 안 된다.

Admin POST 요청은 write guard header와 same-origin 검증을 사용한다. Agent가 API를 직접 테스트할 때도 해당 header를 포함한다.

## 21. 모니터링 데이터 정직성

Agent는 데이터 시각화를 위해 의미 없는 기준을 만들지 않는다.

### percent 사용 가능

- memory: used / total
- disk: used / total
- Load: CPU core 대비 참고값임을 명시한 경우

### percent 사용 금지

- Manager DB size처럼 자연스러운 maximum이 없는 값
- 공식 account maximum을 알 수 없는 credit/quota

Desktop Commander usage API가 공식적이고 authoritative하다고 확인되지 않으면 사용량/maximum 그래프를 표시하지 않는다.

## 22. 방문자 통계

현재 방문자는 하루 unique client IP로 정의한다. Caddy JSON access log를 사용한다.

- 오늘 숫자만 상시 표시
- 최근 14일 sparkline
- 과거 point hover 시 날짜/수치 표시
- logging 시작 이전 과거값 생성 금지

Pageview와 unique visitor를 혼동하지 않는다.

## 23. Admin polling/performance

권장 cadence:

- system stats: 5초
- Desktop Commander status: 10초
- terminal: 5초 incremental
- directory/DB size: 45초 server cache
- visitor data: 60초 cache
- GitHub head: 60초 cache
- Manager DB size: 15초 cache

대형 journal 전체를 매 polling마다 반환하지 않는다. journald cursor 기반 incremental endpoint를 사용한다.

## 24. 사이트 저장용량 표시

Directory size와 DB size를 합쳐 하나의 숫자로 표시하지 않는다.

- directory: site filesystem
- DB: 해당 site 전용 DB
- 전용 DB가 없으면 `없음`
- web-admin은 실제 Manager DB 사용량을 연결 가능

공유 DB 크기를 모든 사이트의 DB 크기로 복제 표시하지 않는다.

## 25. Caddy 변경 규칙

Caddyfile 변경 시:

1. backup
2. 변경
3. `caddy fmt`
4. `caddy validate`
5. validation 통과 시 reload

Validation 실패 시 기존 config를 복원한다.

## 26. 삭제 규칙

사이트 완전삭제는 명시적 확인 이후에만 수행한다.

사이트 삭제 대상 예:

- container
- site files
- Caddy route
- site-domain attachment
- site-specific DB가 명시적으로 삭제 대상인 경우

자동으로 삭제하지 않는 것:

- DuckDNS registered hostname inventory
- DuckDNS provider
- DuckDNS credential

## 27. 운영 상태 분류

### SYNC

```text
GitHub HEAD = Manager deployed SHA = local HEAD
origin URL = Manager repo_url
```

### BEHIND

GitHub main에 새 commit이 있지만 deployed SHA는 이전 정상 버전이다. 이는 반드시 장애가 아니라 “아직 배포하지 않은 commit”일 수 있다.

### DRIFT

다음 중 하나:

- local HEAD != Manager deployed SHA
- local origin != Manager repo_url
- uncommitted working tree

DRIFT는 자동 덮어쓰기 전에 원인을 확인한다.

## 28. 서버 운영 검증

주요 인프라 변경 후 다음을 실행한다.

```bash
sudo /usr/local/sbin/platform-preflight
```

이 도구가 실패한 상태에서는 “플랫폼 구성이 정상”이라고 보고하지 않는다.

## 29. 금지 패턴 요약

- 서버 먼저 수정 -> 나중 GitHub 반영
- GitHub push = 배포 성공으로 간주
- production GitHub Actions 자동 배포
- 서버 write PAT 저장
- web-admin root 실행
- arbitrary privileged command API
- secret 출력
- 추정 quota/credit 표시
- site 삭제 시 DuckDNS registration 함께 삭제
- dirty working tree를 강제 덮어쓰기
- health 확인 없이 성공 보고
- 실패한 backup을 성공으로 보고

## 30. 기본 최종 작업 흐름

### 기존 사이트 변경

```text
사용자 요청
-> GitHub source 수정
-> main commit
-> full SHA
-> site-deploy
-> local health
-> public health
-> Manager deployment record
-> SYNC 확인
-> 결과 보고
```

### 신규 사이트

```text
사용자 요청
-> GitHub repo/source 준비
-> main commit
-> full SHA
-> site-bootstrap
-> site-deploy
-> DNS/TLS/local/public health
-> Manager metadata 확인
-> SYNC 확인
-> 결과 보고
```

이 흐름을 기본값으로 사용하고, 특별한 이유 없이 임의의 별도 배포 경로를 만들지 않는다.

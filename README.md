# WorkLog · 0.3.1

macOS 메뉴 막대에서 에이전트 업무, 프롬프트 입출력 이력, 시간별 세션을 탐색하는 로컬 하네스의 첫 구현입니다. **수행 규칙·작업 실행·모니터링 관리를 분리**했습니다. GUI 없이 CLI에서 작업을 실행할 수 있으며, GUI와 관리 서비스가 종료되어도 실행 서비스는 작업을 계속합니다.

## 구현된 기능

- macOS AppKit 메뉴 막대 앱 + WKWebView 관리 화면. 업무 목록, 검색, 상세 이력, 산출물 미리보기, 제목·설명 편집, 실행 취소·다시 실행.
- 메뉴 막대 아이콘의 **빠른 패널**에서 현재 작업·확인 필요·최근 업무를 조회하고 선택한 업무 상세로 이동합니다. 현재 업무 수, 오늘 캘린더·설정 바로가기, 실시간 갱신·연결 끊김 표시를 제공합니다. 로그인 자동 시작은 창을 띄우지 않으며 아이콘을 우클릭하면 기본 메뉴와 종료에 접근합니다. [빠른 패널 설계·검증](docs/menu-bar-quick-panel.md)
- **실행 대기·작업 실행 중·에이전트 응답 대기·사용자 답변 필요**를 구분합니다. 사용자 질문은 현재 Claude의 명시적 `AskUserQuestion` 훅에 한해 표시하고, 질문 내용과 답변할 에이전트 세션을 상세에서 확인합니다. 일반 실패·blocked는 사용자 질문으로 간주하지 않습니다. Codex와 헤드리스 worker의 질문 감지는 아직 연결하지 않았습니다.
- Claude/Codex의 `UserPromptSubmit`, `Stop` 등 훅을 짧은 로컬 스풀로 수집. 원본 시각·turn 연결·중복 키를 보존하고 지연 이벤트를 재투영합니다.
- 에이전트 세션마다 **마지막 출력 → 다음 입력이 20분 이상**이면 새 Work Item Session을 생성합니다. 정확히 20분도 분리하며, 내부 worker는 사용자 세션 시간을 늘리지 않습니다.
- 업무 다중 선택·대표 업무 지정·병합. 원래 세션 ID·시간·출처를 유지하고 이전 업무 ID는 대표 업무로 연결합니다.
- 일·주·월 캘린더, 업무/세션 단위, 제목 생략·더보기, 자정 경계와 UTC/현지 시간 표시. 블루 포인트와 무채색 GUI.
- 세션 상세의 입출력 레코드를 최신순 **무한 스크롤**로 탐색합니다. 세션을 열면 40건을 읽고 아래로 스크롤할 때 과거 기록을 추가합니다. 훅 이름·본문·입출력 시각을 표시하며 SSE와 수집 커서로 새 기록·지연 도착·재연결을 반영합니다. 읽던 위치와 열린 세션을 유지합니다. [이력 조회 설계](docs/session-record-history.md)
- 세션 안의 **연결된 작업**을 펼치면 공통 상태·결과 메시지·산출물·검사 결과·취소/재개를 확인합니다. 새 업무에 전용 결과 UI나 모델 응답 필드를 요구하지 않습니다. 내부 작업자 로그는 작업별 **실행 상세**에서 요청할 때만 읽으며, 원본 입력을 아직 확인하지 못한 결과만 **세션 연결 대기**로 표시합니다.
- 업무 상세의 **제목·설명 다시 작성**, 세션 상세의 **요약 다시 작성**을 제공합니다. 클릭 시점의 이력을 고정한 `text.rewrite` 헤드리스 작업으로 처리하고 기존 내용과 이후 수동 편집을 보호합니다. [재작성 설계·API](docs/on-demand-writing.md)
- GUI의 1Password vault/item 설정, Atlassian OAuth, macOS Keychain 토큰 보관·회전, Jira/Confluence REST 클라이언트.
- **업무 상세 → Jira 이슈**에서 제목·설명으로 새 이슈를 만들거나, **키·제목·URL로 검색**해 기존 이슈를 선택하고 연결합니다. 결과 목록은 상태와 더 보기를 제공하며 REST API는 내부 클라이언트가 처리합니다. 이슈 링크·현재 상태·허용된 상태 변경을 같은 화면에서 제공합니다. 종료 세션은 제목 1줄+설명 최대 5줄로 요약해 Jira 업무 로그에 코멘트·시작·관측 시간을 동기화합니다. [이슈 연결·상태 변경 설계](docs/jira-issues.md)
- PRD, 단일 HTML 목업, 논리 엔티티 설계, 텍스트 작성. 생성 → 자동 검사 → 독립 검토 → 최대 2회 수정 → 최종 산출물 확정.
- 별도 subprocess인 `codex exec`·`claude -p` 어댑터, 실행 동시성 3, timeout·출력량 제한, 프로세스 트리 취소, 중단 복구, 게시 직후 crash 복구.
- SQLite 두 개와 파일 저장소. 실행 DB는 실행 서비스, 업무·세션 DB는 관리 서비스가 각각 소유합니다.
- 구현 중 반복된 시나리오 설계, 등록된 검사 실행, 실행 근거 보고서 작성을 재사용 업무로 등록했습니다. 모델 worker와 검사 명령이 같은 프로세스 실행기를 사용합니다.
- 모든 업무의 `task/input`을 JSON Schema로 검증하고 버전을 고정합니다. 실행기는 workflow의 명시적인 상태 전이를 따라 필수 검사·검토·수정 한도를 집행하고 각 전이를 기록합니다.

## 구조화 입력과 오케스트레이션

자연어 진입점은 요청을 등록된 업무의 `task/input`으로 정규화합니다. 자동화에서는 아래처럼 구조화 요청을 바로 전달할 수 있습니다. 사용자가 일반 요청마다 내부 작업이나 엔진을 선택할 필요는 없습니다.

```json
{
  "task": "prd.create",
  "input": {
    "requirements": "관리자는 팀원을 초대·취소하고, 사용자는 초대를 수락·거절할 수 있다.",
    "instructions": "상태 전이와 시험 가능한 수용 기준을 포함한다."
  }
}
```

`node bin/harness.mjs run --input request.json --wait`로 실행합니다. 필수 값 누락·잘못된 타입·미등록 필드는 subprocess를 만들기 전에 거부합니다. `catalog`는 업무별 입력 스키마도 반환합니다.

`harness/workflows.json`이 단계별 `done/revise/blocked/failed`의 다음 노드를 정합니다. 검증을 건너뛰거나 실패를 완료로 연결하는 정의는 서비스 시작 시 거부합니다. Worker는 결과만 반환하며 다음 작업을 예약하지 않습니다. `status <run-id>`에서 정규화 입력, 입력 해시, 실제 수행한 단계와 전이를 조회할 수 있습니다.

동일한 입력·실행 정의·판정 순서에는 같은 상태 전이를 적용합니다. 모델 응답의 사실 정확성이나 동일 문장 생성까지 보장하지는 않습니다. 현재 자연어 분류는 제한된 규칙 방식이며, 실행 흐름은 단일 산출물의 제한된 상태 기계입니다. 상세 설계와 검증 범위는 [0.3 구조화 오케스트레이션](docs/structured-orchestration-v0.3.md)에 있습니다.

## 구현 경험을 반영한 업무 유형

| 업무 | 실제 수행 | 완료 근거 |
|---|---|---|
| `test.scenarios.plan` | 요구사항을 `scenarios.json`으로 계획 → 검사 → 독립 검토 → 필요 수정 | 요구사항 ID 연결, 정상·실패·경계·복구 분류, 행동별 기대 결과 |
| `checks.run` | 유지보수자가 등록한 명령을 실제 subprocess로 순차 실행 | 종료 코드, 시작·종료 시각, stdout/stderr와 해시, 대상 파일 지문 |
| `session.summarize` | 종료된 세션의 고정 입출력 스냅샷 → 생성·검사·독립 검토 | 제목 1줄 + 설명 1~5줄, 원문 일치, 파일 해시 |
| `text.rewrite` | 클릭 시점의 세션 이력·유효한 요약 → work item 제목·설명 또는 세션 요약 재작성. 자동 종료 요약도 같은 경로 사용 | JSON·형식·원문 일치 검토, 입력·산출물 해시, 편집 버전 비교 |
| `verification.report` | 고정한 검사 이력을 Markdown 보고서로 변환 | 근거 파일·로그 해시 일치, 실패·미실행·중단·대상 변경의 구분 |

검사 실행과 보고서는 모델을 호출하지 않습니다. 검사 실패는 코드 자동 수정으로 이어지지 않으며, 보고서 생성 완료가 검사 통과를 뜻하지 않습니다. GUI의 업무 상세에서 **검사 결과 보기**로 실패한 실행도 확인할 수 있습니다.

```sh
# 실행 서비스가 시작된 개발 저장소에서 사용합니다.
node bin/harness.mjs run "하네스 E2E 검사를 실행해 주세요." --wait
node bin/harness.mjs run "최신 검증 보고서를 작성해 주세요." --wait
node bin/harness.mjs catalog
node bin/harness.mjs evidence <run-id>

# 격리된 데이터 디렉터리에서 위 두 업무를 실제 하네스로 연속 수행합니다.
npm run verify:self
```

자체 검증 결과와 실행 DB는 `output/self-verification/`에 남고, `latest.json`이 최신 보고서를 가리킵니다. 이 명령은 서비스와 GUI E2E를 수행한 후 실행 서비스를 종료합니다. 모델 기반 시나리오 설계는 기존 생성 업무처럼 선택한 CLI의 모델 사용량이 발생합니다.

검사 프로필은 `harness.e2e`(전체), `harness.service-e2e`, `harness.gui-e2e`입니다. `--input` 요청의 `input.profile`로 범위를 지정할 수 있습니다. 현재 프로필의 대상은 이 하네스 개발 저장소입니다. 테스트 소스가 없는 배포 앱에서는 **미실행**으로 기록합니다. 임의 명령 문자열이나 모델이 제안한 명령은 실행하지 않습니다. 새 검사 명령은 유지보수자가 `harness/check-profiles.json`에 등록합니다.

작업 정의와 workflow는 `harness/task-types.json`, `harness/workflows.json`에서 관리합니다. 재사용 업무를 추출한 과정은 [0.2 개선 기록](docs/harness-improvements-v0.2.md)에 있습니다.

## 개발 환경에서 실행

macOS Apple Silicon, Node.js 22.17 이상, GUI 빌드에는 Xcode의 Swift 컴파일러가 필요합니다. 브라우저 검증과 GUI E2E는 설치된 Google Chrome을 기본으로 사용합니다. `HARNESS_BROWSER`로 다른 Chromium 실행 파일을 지정할 수 있습니다.

기본 데이터 경로는 `~/Library/Application Support/WorkLog/`입니다. 서비스·GUI·훅이 같은 경로를 사용하며 `HARNESS_DATA_DIR`로 별도 경로를 지정할 수 있습니다.

```sh
npm ci
node bin/harness.mjs doctor
HARNESS_DATA_DIR="$PWD/.data" node bin/harness.mjs start
HARNESS_GUI_DATA_DIR="$PWD/.data" npm run build:mac
```

이후 Finder에서 `dist/WorkLog.app`을 엽니다. `start`는 현재 사용자 설정이나 LaunchAgent를 변경하지 않고 지정한 데이터 디렉터리에서 두 서비스를 시작합니다. 테스트용 데이터는 실제 업무 데이터와 분리하세요.

이미 설치·인증한 엔진으로 실제 작업을 실행하는 명령입니다. 모델 사용량이 발생할 수 있습니다.

```sh
HARNESS_DATA_DIR="$PWD/.data" node bin/harness.mjs run "팀원 초대 기능 PRD를 작성해 주세요. 관리자는 초대·취소하고 사용자는 수락·거절합니다." --engine codex --wait
```

`--wait`는 진행 상태를 stderr에, 최종 JSON 한 개를 stdout에 출력합니다. 생략하면 run ID를 즉시 반환합니다. Claude는 `--engine claude`를 사용합니다. `status`, `result`, `cancel`, `resume`이 같은 실행 서비스로 연결됩니다. 재개는 고정된 요청을 새로운 격리 디렉터리에서 다시 수행하며, 이미 검증·게시된 파일은 근거를 대조해 재사용합니다.

입력 자료나 브라우저 상호작용 검사는 `--input request.json`으로 전달할 수 있습니다.

```json
{
  "task": "mockup.html.create",
  "engine": "codex",
  "input": {
    "requirements": "샘플 데이터로 이메일 초대 화면을 만드세요. #save 버튼을 누르면 #result에 저장되었습니다를 표시하세요.",
    "browser_checks": [{ "click": "#save", "visible": "#result", "text": "저장되었습니다" }]
  }
}
```

업무를 이어 실행할 때는 요청에 `work_item_id`를 전달할 수 있습니다. 원본 에이전트 식별자를 알고 있는 진입점은 `origin: {engine, agent_session_id, turn_id}`를 추가합니다. 폴더나 제목만으로 대화를 자동 병합하지 않습니다. 원본 식별자가 없는 CLI 요청에는 새 하네스 진입 세션을 부여합니다.

## macOS 설치 패키지

저장소에서 GUI·백그라운드 서비스·기록 훅·요청 스킬을 함께 설치합니다. 필요한 Node·Swift·브라우저는 위 개발 환경 조건을 따릅니다.

```sh
make install
make uninstall
```

`make install`은 프로젝트 의존성 설치와 앱 빌드 후 사용자 홈에 설치합니다. 설치·제거 대상을 먼저 보려면 `make install-plan`, `make uninstall-plan`을 사용합니다. 제거는 빌드를 요구하지 않습니다.

```sh
npm run build:mac
node bin/harness.mjs install-plan --output dist/install-plan
```

`HARNESS_GUI_DATA_DIR` 없이 빌드하면 일반 사용자 데이터 경로를 사용하는 배포용 앱을 만듭니다. 기본 Node 번들은 `~/.nvm/versions/node/v22.17.0/bin/node`입니다. 없으면 독립 배포 가능한 Node 실행 파일을 `HARNESS_BUNDLE_NODE`로 지정하세요. Homebrew 동적 라이브러리에 의존하는 바이너리는 거부합니다.

결과는 `dist/WorkLog.app`과 `dist/WorkLog-macos-arm64.zip`입니다. ZIP에는 앱과 `Install WorkLog.command`, `Uninstall WorkLog.command`가 들어 있습니다. 개발용 ad-hoc 서명이며 Apple 공증은 적용하지 않았습니다.

**설치 계획 생성은 사용자 설정을 변경하지 않습니다.** 실제 설치는 ZIP의 설치 명령을 사용하거나 `node scripts/install.mjs --apply`를 명시해 수행합니다. 다음 변경을 만듭니다.

- `~/Applications/WorkLog.app`
- 사용자 LaunchAgent 3개: 실행 서비스, 관리 서비스, 로그인 시 GUI 시작.
- `~/Library/Application Support/WorkLog/versions/…`에 버전을 고정한 실행 파일.
- 기존 항목을 보존하는 `~/.codex/hooks.json`, `~/.claude/settings.json`의 수집 훅 추가와 설정 백업.
- 요청 접수용 `worklog-request` 스킬 하나의 심링크: `~/.claude/skills/worklog-request`, `~/.agents/skills/worklog-request`, `~/.codex/worklog/skills/worklog-request`. Codex의 공식 자동 탐색은 `.agents/skills`를 사용하며 `.codex/worklog`는 같은 설치 원본의 참조 경로입니다. 기존 `CLAUDE.md`·`AGENTS.md`를 수정하지 않습니다.

스킬은 사용자 요청과 자료를 자연어 `prompt`로 전달합니다. 업무 유형 분류·구조화·헤드리스 작업자 위임·검토 루프는 하네스가 담당하며 업무마다 스킬을 만들지 않습니다. 현재 분류는 제한된 규칙 방식이고 요청당 한 종류의 산출물을 지원합니다.

설치별 고유 ID와 훅 원본·심링크 대상·파일 해시를 `~/Library/Application Support/WorkLog/installation.json`에 기록합니다. `make uninstall`은 현재 내용과 이 기록이 일치하는 설치 항목만 제거합니다. 사용자가 변경한 훅·심링크·서비스·앱 파일은 보존하고 `needs_attention`으로 보고합니다. 전체 설정 백업을 덮어 복원하거나 이름에 `worklog`가 포함됐다는 이유로 삭제하지 않습니다. **업무 DB·산출물·로그·백업·Keychain 토큰은 제거하지 않습니다.** 자세한 동작과 검증 범위는 [설치 소유권과 제거](docs/installation-ownership.md)에 있습니다.

사내 정책에서 해당 훅·스킬·실행 엔진을 허용해야 합니다. 설치는 정책의 비활성화 설정을 해제하지 않습니다. 동일한 정상 설치를 다시 실행하면 중복 추가 없이 유지하고, 기존 사용자 파일이나 소유 기록 없는 과거 설치가 있으면 덮어쓰지 않습니다. 자동 업데이트·공증은 후속 범위입니다. 현재 워크스페이스에서는 실제 사용자 훅·LaunchAgent 설치를 수행하지 않았습니다.

## 테스트

```sh
npm test
npm run test:ui
```

서비스 E2E는 실제 별도 프로세스·HTTP API·SQLite·훅 stdin·파일·브라우저를 통과합니다. 모델 응답은 명시적인 fixture subprocess로 재현합니다. Claude/Codex 어댑터 테스트 역시 **프로토콜 대역**을 사용하므로 실모델 검증과 구분합니다. GUI E2E는 Playwright로 사용자 클릭·키보드·검색·병합·캘린더·취소·산출물 조회를 수행합니다.

실모델 검증은 별도 승인 후에만 실행합니다. 세 종류의 업무를 순차 수행하며 생성·검토·수정 합계 최대 18회 호출입니다.

```sh
HARNESS_LIVE_APPROVED=1 node scripts/live-smoke.mjs
```

같은 승인 범위에서 재검증할 때는 `HARNESS_LIVE_PREVIOUS_REPORT`에 이전 `report.json` 경로를 지정합니다. 앞서 사용한 호출까지 합산하며, 남은 한도 안에서 해당 업무의 최대 호출 수를 수용할 수 없으면 시작하지 않습니다. 18회는 작업 subprocess 기준이며 CLI 내부의 모델·도구 왕복과 토큰 사용량을 따로 기록합니다.

**로컬 E2E 서비스·CLI·설치 99개, GUI 32개**가 통과했습니다. [세션 입출력 무한 스크롤](docs/session-record-history.md)에 서비스 4개·GUI 5개 시나리오를 추가했으며, `checks.run → verification.report`로 서비스 검사와 GUI 최종 재검증의 근거를 보존했습니다. [Jira 검색·상태 변경](docs/jira-issues.md), [이력 기반 재작성](docs/on-demand-writing.md)과 실시간 이력·Atlassian·세션 요약도 포함합니다. 실제 계정 미검증 사항은 [연동 검증 기록](docs/verification-atlassian.md)에 정리했습니다. Codex 실모델의 PRD·HTML·엔티티 설계 3개 예시도 검증·검토·전달을 통과했으며, 최초 실패를 포함해 총 12/18회 호출을 사용했습니다. 발견한 계약 불일치와 관리 이력 수집 대기 수정은 [0.3.1 실모델 E2E 기록](docs/live-model-e2e-v0.3.1.md)에 있습니다. 구조화 실행 설계는 [0.3 구조화 오케스트레이션](docs/structured-orchestration-v0.3.md), 첫 버전 기록은 [0.1 검증 보고서](docs/verification-v0.1.md)에 있습니다. 화면·트레이스는 `output/playwright/`, 실모델 실행 결과는 `output/live/`에 보관합니다. 테스트용 fixture 엔진과 검사 프로필은 `HARNESS_TEST_MODE=1`로 시작한 서비스에서만 사용할 수 있습니다.

## Atlassian 연결

GUI의 **연결 설정**에서 1Password vault 이름과 item 이름을 저장합니다. 해당 item의 `client_id`, `client_secret` 필드를 `op`로 읽고, OAuth 토큰은 함께 번들된 macOS Keychain 도우미로 관리합니다. Callback URL은 `http://127.0.0.1:47831/oauth/atlassian/callback`입니다. `op` 설치·로그인 및 Atlassian 앱의 권한 설정이 필요합니다.

OAuth 연결 자체는 Jira 티켓을 만들지 않습니다. 상세에서 새로 만들거나 기존 이슈를 확인해 연결한 뒤 종료 세션의 업무 로그를 전송합니다. 첫 입력부터 마지막 출력까지를 관측 시간으로 사용하며 20분 유휴 구간은 제외합니다. 실제 계정 연결·외부 쓰기는 로컬 모의 E2E와 구분합니다. [연동 설계·설정·복구 정책](docs/atlassian-worklogs.md)에서 상세 조건을 확인할 수 있습니다.

## 첫 버전의 범위

하나의 요청에서 한 종류의 파일 산출물을 완성하는 수직 흐름을 구현했습니다. 복합 산출물 DAG·코드/Git 통합·프로젝트 정책 계층·비용 기반 라우팅·네트워크 자동 재시도는 아직 구현하지 않았습니다. 여러 요청은 병렬 수행할 수 있고 결과를 하나의 업무로 병합할 수 있습니다.

제목·설명은 첫 요청에서 임시로 만들고 수동 편집하거나 GUI에서 이력 기반 재작성을 요청할 수 있습니다. 모든 사용자 입력마다 자동 메타데이터 생성을 호출하지 않습니다. 브라우저 자동 검사는 페이지 로드·실행 오류·명시한 상호작용을 검증하며, 의미·디자인 품질 전체를 보장하지 않습니다.

엔진의 기존 승인·보안 설정을 보존하며 승인 우회 옵션을 사용하지 않습니다. OS 전체를 격리하는 별도 보안 샌드박스나 모든 비밀정보를 탐지하는 DLP는 이 버전의 보장 범위가 아닙니다. 모델 작업 디렉터리, 허용 산출물·해시 검사, CLI가 제공하는 권한 제한을 적용합니다. 관찰 중인 외부 에이전트 세션은 이력만 수집하며 하네스가 소유한 run만 취소·재개합니다.

공식 연결 규약은 [Codex Hooks](https://learn.chatgpt.com/docs/hooks), [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude Hooks](https://code.claude.com/docs/en/hooks), [Claude headless](https://code.claude.com/docs/en/headless)를 기준으로 작성했습니다. Codex App의 환경별 훅 가시성은 실제 설치 후 별도 확인해야 합니다.

설계 근거와 EVAL 목록은 [세션·캘린더 설계](docs/harness-session-calendar-design.md), 구현 구조와 API는 [구현 기록](docs/implementation-v0.1.md)에 있습니다.

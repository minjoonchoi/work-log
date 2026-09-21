# WorkLog · 0.3.1

macOS 메뉴 막대에서 에이전트 업무, 프롬프트 입출력 이력, 시간별 세션을 탐색하는 로컬 하네스의 첫 구현입니다. **수행 규칙·작업 실행·모니터링 관리를 분리**했습니다. GUI 없이 CLI에서 작업을 실행할 수 있습니다. `WorkLog 종료`는 세션 요약·메타데이터 재작성 같은 내부 관리 작업을 중단하지만, 에이전트 세션에서 요청한 본 작업과 후속 작업은 완료될 때까지 계속합니다. 창 닫기는 앱 종료와 다릅니다.

## 구현된 기능

- 캘린더 주·월에서 여러 날짜를 선택하거나 **분기·반기·연간** 기간을 지정해 **업무 요약**를 작성합니다. 업무와 연결된 Jira 이슈별로 배경·수행 내용·결과를 설명하고, 세션별 원본 이력은 상세에서 펼쳐 확인합니다. 메뉴에서 생성일 최신순으로 탐색하며 완료된 본문만 선택한 Confluence 공간에 게시할 수 있습니다. 자동 기록에 확인된 역할·행동·결과·근거를 남겨 나중에 성과를 정리할 때 활용합니다. 많은 이력은 부분 작성 후 통합합니다. [업무 요약 설계·검증](docs/work-reports.md)

- **Jira 없이 로컬에서 사용**합니다. 업무·세션 이력·요약·유형 태그는 로컬이 기준이며, 나중에 Jira 이슈를 만들거나 연결하면 이미 종료·요약된 세션도 업무 로그 한 개씩 동기화합니다. 재요약은 같은 로그를 갱신합니다. [로컬 업무 추적과 태그](docs/local-tracking-and-tags.md)
- 업무 상세의 **태그 편집**에서 기획·설계·개발 등 여러 유형을 지정하거나 직접 입력합니다. 업무·세션 목록에 표시하고 검색·Jira 필터와 함께 유형별로 찾을 수 있습니다. 병합·휴지통 복원·제목 재생성 후에도 태그를 보존합니다. 태그만 편집하면 Jira는 변경하지 않습니다.
- macOS AppKit 메뉴 막대 앱 + WKWebView 관리 화면. 업무 목록, 검색, 상세 이력, 산출물 미리보기, 제목·설명 편집, 실행 취소·다시 실행.
- 메뉴 막대 아이콘의 **빠른 패널**에서 알림·현재 작업·최근 업무를 조회합니다. 알림을 선택하면 전체 창의 해당 알림으로, 업무를 선택하면 업무 상세로 이동합니다. 현재 업무 수, 오늘 캘린더·설정 바로가기, 실시간 갱신·연결 끊김 표시를 제공합니다. 로그인 자동 시작은 창을 띄우지 않으며 아이콘을 우클릭하면 기본 메뉴와 종료에 접근합니다. [빠른 패널 설계·검증](docs/menu-bar-quick-panel.md)
- 업무 목록과 캘린더 상단의 **업무별 보기 / 세션별 보기**로 탐색 단위를 선택합니다. 세션 목록은 최근 활동순으로 요약 제목·시간·소속 업무를 표시하며, 항목 선택 시 해당 세션의 입력·응답으로 이동합니다. 요약이 없으면 첫 입력을 제목으로 사용합니다. 업무 병합은 업무별 목록에서 수행합니다.
- **실행 대기·작업 실행 중·에이전트 응답 대기**를 구분합니다. 실행·요약·제목 작성 실패와 Jira 연결·동기화 문제는 **알림**에서 발생 시각·원인·조치를 확인합니다. **알림 지우기**는 현재 실패의 알림만 숨기며 원본 이력과 실패 상태를 바꾸지 않습니다. 새 시도가 다시 실패하면 새 알림이 표시되고, 재시도 중이거나 해결된 문제는 표시하지 않습니다. GUI는 에이전트 프롬프트 입력이나 질문 감지·답변 기능을 제공하지 않습니다.
- Claude/Codex의 `UserPromptSubmit`, `Stop` 등 훅을 짧은 로컬 스풀로 수집. 원본 시각·turn 연결·중복 키를 보존하고 지연 이벤트를 재투영합니다.
- 에이전트 세션마다 **마지막 출력 → 다음 입력이 20분 이상**이면 새 Work Item Session을 생성합니다. 정확히 20분도 분리하며, 내부 worker는 사용자 세션 시간을 늘리지 않습니다.
- 업무 다중 선택·대표 업무 지정·병합. 원래 세션 ID·시간·출처를 유지하고 이전 업무 ID는 대표 업무로 연결합니다.
- 업무 목록은 최근 사용자 입력·응답 또는 사용자 요청 실행의 갱신 시각 중 최신 시각을 기준으로 내림차순 정렬합니다. 제목·설명 검색과 Jira 전체/미연결/연결됨 필터를 함께 사용할 수 있습니다. 제목 편집이나 내부 요약 실행만으로 정렬이 바뀌지는 않습니다. 병합한 업무의 Jira 연결은 병합 전 항목들의 연결을 함께 확인합니다.
- 표시된 업무를 복수 선택해 삭제하거나 병합할 수 있습니다. **삭제는 휴지통 이동**이며 세션 이력·산출물·Jira 이슈는 보존합니다. 휴지통에서 복수 복원할 수 있습니다. 삭제 후 새 훅이 도착해도 자동 복원하지 않으며, 이미 요청한 사용자 작업은 계속됩니다. 검색·필터·화면을 바꾸면 선택을 해제합니다.
- 일·주·월 캘린더에서 오늘 날짜·요일을 강조하고 현재 현지 시각을 표시합니다. 일·주 보기에는 오늘 열의 현재 시간선이 나타나며 **D / W / M**으로 보기를 전환합니다. 입력 중이거나 모달이 열려 있으면 단축키는 동작하지 않습니다. 업무/세션 단위, 제목 생략·더보기, 자정 경계와 UTC/현지 시간 표시를 지원합니다. 블루 포인트와 무채색 GUI.
- 세션 상세의 입출력 레코드를 최신순 **무한 스크롤**로 탐색합니다. 세션을 열면 40건을 읽고 아래로 스크롤할 때 과거 기록을 추가합니다. 훅 이름·본문·입출력 시각을 표시하며 SSE와 수집 커서로 새 기록·지연 도착·재연결을 반영합니다. 읽던 위치와 열린 세션을 유지합니다. [이력 조회 설계](docs/session-record-history.md)
- 세션 안의 **연결된 작업**을 펼치면 공통 상태·결과 메시지·산출물·검사 결과·취소/재개를 확인합니다. 새 업무에 전용 결과 UI나 모델 응답 필드를 요구하지 않습니다. 내부 작업자 로그는 작업별 **실행 상세**에서 요청할 때만 읽으며, 원본 입력을 아직 확인하지 못한 결과만 **세션 연결 대기**로 표시합니다.
- 업무 상세의 **제목·설명 다시 작성**, 세션 상세의 **요약 다시 작성**을 제공합니다. 클릭 시점의 이력을 고정한 `text.rewrite` 헤드리스 작업으로 처리하고 기존 내용과 이후 수동 편집을 보호합니다. [재작성 설계·API](docs/on-demand-writing.md)
- 제목·설명은 기본적으로 사용자 에이전트의 유효한 응답 5개가 쌓이면 처음 자동 작성하고, 이후 요약이 확정된 서로 다른 종료 세션이 누적 5·10·15개에 도달할 때 자동 갱신합니다. 최초 응답 수와 세션 간격은 GUI의 **자동 작성 설정**에서 각각 1~1,000으로 조정합니다. 내부 worker·중복 이벤트·같은 세션의 재요약은 횟수를 늘리지 않습니다. 직접 편집한 제목·설명은 자동 덮어쓰기에서 보호하며, 원할 때 수동 재작성을 요청할 수 있습니다.
- GUI에서 Atlassian Client ID·Secret 직접 입력, macOS Keychain의 앱 자격증명·OAuth 토큰 분리 보관과 토큰 회전, Jira/Confluence REST 클라이언트. Secret은 기본적으로 숨기며 **보기**를 눌러야 표시합니다.
- **업무 상세 → Jira 이슈**에서 제목·설명으로 새 이슈를 만들거나, **키·제목·URL로 검색**해 기존 이슈를 선택하고 연결합니다. 결과 목록은 상태와 더 보기를 제공하며 REST API는 내부 클라이언트가 처리합니다. 이슈 링크·현재 상태·허용된 상태 변경을 같은 화면에서 제공합니다. 종료 세션은 제목 1줄+설명 최대 5줄로 요약해 Jira 업무 로그에 코멘트·시작·관측 시간을 동기화합니다. [이슈 연결·상태 변경 설계](docs/jira-issues.md)
- PM·PO·FE·BE의 사용자 업무 63개와 시스템 업무 5개. 업무마다 담당 산출물·제외 범위·필요 자료·완료 기준을 고정합니다. 모델 기반 업무는 생성 → 자동 검사 → 독립 검토 → 최대 2회 수정 → 최종 산출물 확정으로 진행하고, 로컬 검사 실행·근거 보고서는 정해진 코드로 처리합니다. [전체 작업 카탈로그와 경계](docs/job-catalog.md)
- **업무 공유 문서 작성**은 제공 자료·독자·공유 목적을 기준으로 팀이나 유관부서가 배경·핵심 내용·확인된 결과·다음 행동을 이해할 문서를 만듭니다. 자료로 받은 PRD·API 설계를 자동 재생성하거나 문서를 전송·게시하지 않습니다. 상태 보고·인수인계·캘린더 업무 요약과 별도 유형으로 구분합니다.
- `work` 스킬이 원래 요청의 결과와 동작을 기준으로 최대 24개 작업의 구조화 계획을 제출합니다. 실행기는 중복 산출물·순환·코드 경로 충돌을 검사하고, 선행 산출물의 검증·검토가 통과한 후 의존 작업을 실행합니다. 완료 개수와 현재 단계만 간략히 알립니다.
- 별도 subprocess인 `codex exec`·`claude -p` 어댑터, 실행 동시성 3, timeout·출력량 제한, 프로세스 트리 취소, 중단 복구, 게시 직후 crash 복구.
- 업무가 참조하는 [유형별 모델 실행 프로필](docs/execution-profiles.md)에서 단계별 model·effort를 고정합니다. Codex와 Claude worker는 승인 질문 없이 수행하도록 각 CLI의 명시적 permission bypass 옵션으로 실행합니다.
- GUI의 **작업 실행 설정**에서 업무별 지시문, 기본 Codex/Claude backend와 backend별 model·effort override를 로컬에 저장합니다. 변경은 이후 생성되는 run에만 적용되고 실행 정의에 고정됩니다.
- 기준 SQLite DB 두 개와 파일 저장소. `runtime.sqlite`는 실행 서비스, `memory.sqlite`는 업무·세션 관리 서비스가 소유합니다. 훅의 turn 연결·재전송 기록에는 별도 보조 DB `hook-state.sqlite`를 사용합니다.
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

복합 요청은 `work` 스킬이 카탈로그의 책임 경계와 입력 계약을 읽고 `prompt/steps`로 분할합니다. `node bin/harness.mjs orchestrate --input plan.json --wait`가 계획을 한 번 제출하고 완료까지 기다립니다. 기존 자료의 언급은 새 생성 작업이 아니며 검토만 요청한 경우 원본 수정 작업을 추가하지 않습니다. `status|result|cancel|resume <plan-id>`로 전체 계획을 조회·관리할 수 있습니다.

동일한 입력·실행 정의·판정 순서에는 같은 상태 전이를 적용합니다. 모델의 의미 판단이나 사실 정확성까지 보장하지는 않습니다. 스킬을 거치지 않는 `run`의 자연어 분류는 제한된 호환 기능으로, 모호하거나 복합적인 요청은 구조화 계획으로 안내합니다. [작업 분할과 실행 설계](docs/task-orchestration.md), 기존 단일 작업의 [0.3 상태 전이 설계](docs/structured-orchestration-v0.3.md)를 참고하세요.

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

작업 정의와 workflow는 `harness/task-types.json`, `harness/workflows.json`에서 관리합니다. 모델과 effort는 업무의 `execution_profile`이 참조하는 `harness/execution-profiles/*.json`에서 관리하며 실행 시작 시 정의에 고정됩니다. 재사용 업무를 추출한 과정은 [0.2 개선 기록](docs/harness-improvements-v0.2.md)에 있습니다.

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

설치 후에는 `~/Applications/WorkLog.app`을 실행합니다. 일반 실행은 업무 목록 창을 열고 메뉴 막대 아이콘은 빠른 패널을 엽니다. 예전 `dist/Work Log.app`은 다른 데이터 경로를 사용하는 이전 빌드일 수 있으므로 설치본과 혼동하지 마세요. `make install`을 다시 실행해도 기존 설치본은 자동 교체되지 않습니다.

새 에이전트 창을 열었다는 사실만으로 현재 작업 수가 증가하지는 않습니다. 입력 후 응답을 기다리는 동안 현재 작업에 표시되며, `Stop`으로 응답이 끝나면 최근 업무에서 이력을 확인합니다. 서비스 연결 대기나 빈 화면이 지속되면 `node bin/harness.mjs doctor`로 서비스 상태를 확인하고 실행한 앱 경로도 확인하세요.

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
- 요청 접수용 `work` 스킬 하나의 심링크: `~/.claude/skills/work`, `~/.agents/skills/work`, `~/.codex/worklog/skills/work`. Codex의 공식 자동 탐색은 `.agents/skills`를 사용하며 `.codex/worklog`는 같은 설치 원본의 참조 경로입니다. 기존 `CLAUDE.md`·`AGENTS.md`를 수정하지 않습니다.

스킬은 카탈로그를 조회해 사용자 요청을 담당 산출물별 `task/input`으로 분할하고 원문 인용·산출물 식별자·의존성을 붙여 한 번 제출합니다. 실행 서비스가 구조화 계획 검증·헤드리스 작업자 위임·검토 루프·취소·복구를 담당합니다. 업무별 스킬은 만들지 않습니다.

설치별 고유 ID와 훅 원본·심링크 대상·파일 해시를 `~/Library/Application Support/WorkLog/installation.json`에 기록합니다. `make uninstall`은 현재 내용과 이 기록이 일치하는 설치 항목만 제거합니다. 사용자가 변경한 훅·심링크·서비스·앱 파일은 보존하고 `needs_attention`으로 보고합니다. 전체 설정 백업을 덮어 복원하거나 이름에 `worklog`가 포함됐다는 이유로 삭제하지 않습니다. **업무 DB·산출물·로그·백업·Keychain 앱 자격증명과 토큰은 제거하지 않습니다.** 자세한 동작과 검증 범위는 [설치 소유권과 제거](docs/installation-ownership.md)에 있습니다.

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

2026-09-19 최신 회귀 검사에서 **서비스·CLI·설치 E2E 365개, GUI E2E 67개**가 통과했습니다. 알림 통합, 최초 응답·종료 세션 기준의 자동 제목/설명 생성, GUI 기준 설정, 수동 편집 보호와 기존 DB 마이그레이션을 포함합니다. macOS 앱 빌드와 번들 소스 19개 일치도 확인했습니다. 모델은 fixture subprocess, Jira는 로컬 테스트 서버를 사용했고 설치본은 변경하지 않았습니다. 로컬 근거는 `output/worklog-final-verification.json`입니다.

이전 검증에서는 **로컬 E2E 서비스·CLI·설치 230개, GUI 42개**가 통과했습니다. 작업 카탈로그 62개, 복합 요청의 병렬·의존 실행, 취소·재개, 원본 소스 보존을 포함합니다. 검토 요청의 분류, 계획의 코드 경로 표기, JavaScript 모듈 문맥, 대형 소스의 stdin 전달을 보완한 뒤 전체 회귀를 다시 확인했습니다. [최종 검사 근거](output/self-verification/2026-09-18T10-07-57.773Z/verification.md)는 Git에서 제외되는 로컬 파일입니다. [세션 입출력 무한 스크롤](docs/session-record-history.md)에 서비스 4개·GUI 5개 시나리오를 추가했으며, `checks.run → verification.report`로 서비스 검사와 GUI 최종 재검증의 근거를 보존했습니다. [Jira 검색·상태 변경](docs/jira-issues.md), [이력 기반 재작성](docs/on-demand-writing.md)과 실시간 이력·Atlassian·세션 요약, 로컬 작업 실행 설정도 포함합니다. 실제 계정 미검증 사항은 [연동 검증 기록](docs/verification-atlassian.md)에 정리했습니다. Codex 실모델의 PRD·HTML·엔티티 설계 3개 예시도 검증·검토·전달을 통과했으며, 최초 실패를 포함해 총 12/18회 호출을 사용했습니다. 발견한 계약 불일치와 관리 이력 수집 대기 수정은 [0.3.1 실모델 E2E 기록](docs/live-model-e2e-v0.3.1.md)에 있습니다. 구조화 실행 설계는 [0.3 구조화 오케스트레이션](docs/structured-orchestration-v0.3.md), 첫 버전 기록은 [0.1 검증 보고서](docs/verification-v0.1.md)에 있습니다. 화면·트레이스는 `output/playwright/`, 실모델 실행 결과는 `output/live/`에 보관합니다. 테스트용 fixture 엔진과 검사 프로필은 `HARNESS_TEST_MODE=1`로 시작한 서비스에서만 사용할 수 있습니다.

## Atlassian 연결

GUI의 **연결 설정**에서 Atlassian 앱의 **Client ID·Client Secret**을 직접 입력합니다. 앱 자격증명과 OAuth 토큰은 함께 번들된 macOS Keychain 도우미로 서로 다른 레코드에 보관합니다. Secret 입력은 기본적으로 숨기며, 저장된 Secret은 **보기**를 눌렀을 때만 로컬 API로 조회해 표시합니다. 같은 Client ID에서 Secret을 비워 저장하면 기존 값을 유지하고, ID를 바꾸면 새 Secret이 필요합니다. Callback URL은 `http://127.0.0.1:47831/oauth/atlassian/callback`이며 Atlassian 앱의 권한 설정이 필요합니다.

이전 1Password vault/item 설정은 자동으로 읽거나 변환하지 않습니다. 연결 설정에서 자격증명을 직접 다시 입력하며, 기존 업무 기록과 토큰은 삭제하지 않습니다. **연결 해제**는 OAuth 토큰만 제거하고 저장한 앱 자격증명은 유지합니다.

OAuth 연결 자체는 Jira 티켓을 만들지 않습니다. 상세에서 새로 만들거나 기존 이슈를 확인해 연결한 뒤 종료 세션의 업무 로그를 전송합니다. 첫 입력부터 마지막 출력까지를 관측 시간으로 사용하며 20분 유휴 구간은 제외합니다. 실제 계정 연결·외부 쓰기는 로컬 모의 E2E와 구분합니다. [연동 설계·설정·복구 정책](docs/atlassian-worklogs.md)에서 상세 조건을 확인할 수 있습니다.

## 현재 구현 범위

한 요청의 복합 산출물 DAG와 작업별 품질 루프를 실행하고 완료된 결과를 하나의 work item에 연결합니다. 코드 업무는 고정한 원본과 허용 경로를 기준으로 실제 소스 내용을 담은 `changes.json`을 반환합니다. 코드 묶음의 범위·JavaScript/JSON 문법은 검사하지만 프로젝트 반영·빌드·런타임 테스트·Git 통합은 자동 수행하지 않습니다. 이들은 검사 보고서에 미실행으로 명시합니다. 프로젝트 정책 계층·비용 기반 라우팅·네트워크 자동 재시도·동적 재계획은 후속 범위입니다.

제목·설명은 첫 요청에서 임시로 만들고 수동 편집하거나 GUI에서 이력 기반 재작성을 요청할 수 있습니다. 모든 사용자 입력마다 자동 메타데이터 생성을 호출하지 않습니다. 브라우저 자동 검사는 페이지 로드·실행 오류·명시한 상호작용을 검증하며, 의미·디자인 품질 전체를 보장하지 않습니다.

모델 worker는 요청된 CLI permission bypass 옵션으로 실행합니다. 작업 디렉터리·허용 산출물·해시 검사와 고정된 책임 경계를 사용하지만 이는 OS 접근 차단이나 모델의 의미 판단 정확성을 보장하지 않습니다. 관찰 중인 외부 에이전트 세션은 이력만 수집하며 하네스가 소유한 run과 plan만 취소·재개합니다.

공식 연결 규약은 [Codex Hooks](https://learn.chatgpt.com/docs/hooks), [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude Hooks](https://code.claude.com/docs/en/hooks), [Claude headless](https://code.claude.com/docs/en/headless)를 기준으로 작성했습니다. Codex App의 환경별 훅 가시성은 실제 설치 후 별도 확인해야 합니다.

현재 작업 계약·계획 API·복구는 [작업 오케스트레이션](docs/task-orchestration.md), 모델 설정은 [실행 프로필](docs/execution-profiles.md), 설치·제거는 [설치 소유권](docs/installation-ownership.md)에 있습니다. [세션·캘린더 설계](docs/harness-session-calendar-design.md)의 EVAL 목록은 기대 시나리오이며 모두 구현·통과했다는 뜻은 아닙니다. [0.1 구현 기록](docs/implementation-v0.1.md)과 버전별 검증 문서는 당시 상태를 보존한 기록입니다.

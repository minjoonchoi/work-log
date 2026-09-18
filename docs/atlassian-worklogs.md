# Atlassian 연결과 세션 업무 로그

작성일: 2026-09-17 · 상태: 로컬 구현, 모의 서비스 E2E 검증

## 확정 동작

Work Item은 훅의 첫 사용자 입력에서 자동 생성한다. GUI의 **업무 상세 → Jira 이슈 → 새 이슈 만들기**를 눌러 사이트·프로젝트·유형을 선택해야 Jira 티켓을 생성한다. **기존 이슈 연결**에서는 키·제목·URL로 검색하고 결과 목록에서 이슈를 선택해 연결한다. OAuth 연결이나 work item 생성만으로 티켓을 만들지 않는다. 생성 직전 저장된 work item의 제목·설명과 버전을 고정한다. 제목은 Jira `summary`, 설명은 줄바꿈을 보존한 ADF `description`으로 전송한다. 미리보기 이후 내용이 바뀌면 요청을 거절해 최신 내용을 다시 확인하게 한다. 연결된 이슈의 링크·현재 상태·상태 변경은 [Jira 이슈 관리 설계](jira-issues.md)를 따른다.

에이전트 세션별로 마지막 출력과 다음 입력의 간격이 **1,200초 이상**이면 새 Work Item Session을 시작한다. 다음 입력이 실제로 관측되어 이전 세션의 경계가 확정되고, 이전 세션에 미종료 turn이 없을 때 요약을 예약한다. 시계만으로 20분 뒤 종료 이벤트를 만들지 않는다.

종료 세션의 요약은 제목 1줄과 설명 1~5줄, 총 2~6줄의 일반 텍스트다. 빈 줄과 Markdown 목록·제목을 허용하지 않는다. 이 전체 텍스트 하나를 Jira worklog의 `comment`에 넣는다. 원본 입출력은 보존하고, 상세 화면에서는 이벤트 발생 시각 내림차순 무한 스크롤로 보여 준다. 인증된 SSE 알림 후 메타데이터와 새로 수집된 레코드를 조회하며 재연결 시 누락 구간을 따라잡는다. 이미 읽은 과거 페이지를 매번 다시 내려받지 않는다. 열린 세션, 스크롤 위치, 편집 중인 입력은 유지한다. [레코드 조회 계약](session-record-history.md)을 따른다.

| Jira 값 | 기준 |
|---|---|
| comment | 검증·검토를 통과한 제목 + 줄바꿈 + 설명 전체, ADF로 인코딩 |
| started | 세션의 첫 입력을 UTC 시각으로 표현 |
| timeSpentSeconds | 첫 입력부터 마지막 관측 출력까지의 초, 소수 초는 버림 |
| adjustEstimate | `leave`: 남은 추정 시간을 자동 수정하지 않음 |

20분 유휴 구간을 덧붙이지 않는다. 세션 안의 짧은 대기는 기록 구간에 포함되며, 이 값은 **입출력 관측 구간**이지 사람의 실작업 시간이나 모델 실행 시간 측정치가 아니다. 0초·출력 미확인은 임의로 반올림해 Jira에 전송하지 않는다. 여러 에이전트의 동시 세션은 별도 로그이므로 합계가 벽시계 경과 시간보다 클 수 있다.

Jira의 업무 로그 생성·조회·수정 API를 사용하며, 사이트에서 시간 기록이 켜져 있고 사용자에게 해당 프로젝트의 업무 로그 권한이 있어야 한다. [Jira worklogs 공식 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/)

## 연결 설정과 자격증명

GUI **연결 설정**에는 `op` vault 이름과 item 이름만 저장한다. 기본 데이터 디렉터리의 `integrations/atlassian.json`에도 이 두 값만 남는다. item에는 `client_id`, `client_secret`이라는 고유 필드가 필요하다.

```sh
op item get '<item>' --vault '<vault>' \
  --fields label=client_id,label=client_secret --format json --reveal
```

앱은 인자 배열로 `op`를 실행하고 결과를 메모리에서만 사용한다. 위 명령의 출력에는 비밀정보가 있으므로 로그·화면·설정에 복사하지 않는다. 실행 환경은 `op` 설치 및 허용된 1Password 로그인이 준비되어 있어야 한다. [1Password item get](https://www.1password.dev/cli/reference/management-commands/item)

OAuth 앱의 Callback URL은 다음과 정확히 일치하도록 등록한다.

```text
http://127.0.0.1:47831/oauth/atlassian/callback
```

GUI의 연결 버튼이 기본 브라우저를 연다. 임시 loopback listener가 난수 state·10분 만료·일회성 콜백을 확인한다. 인증 코드 및 refresh 교환에는 1Password의 client ID/secret을 사용한다. 요청 scope는 `offline_access`, `read:jira-work`, `write:jira-work`, `read:page:confluence`다. 실제 접근 가능한 사이트는 accessible-resources에서 확인한다. [Atlassian 3LO](https://developer.atlassian.com/cloud/jira/software/oauth-2-3lo-apps/)

Access/refresh token과 만료 정보를 **macOS Keychain의 하나의 generic password 레코드**로 저장한다. 서비스 이름은 `local.worklog.atlassian`, 계정 키는 로컬 데이터 디렉터리의 해시다. 회전된 두 토큰을 함께 교체하고, 동시 API 호출의 refresh는 한 번만 수행한다. 만료·회수된 refresh token은 재연결을 요구한다. Keychain 잠금·접근 실패 시 평문 파일로 대체하지 않는다. 연결 해제는 이 앱의 해당 Keychain 레코드를 지우며, Atlassian 계정의 앱 승인 자체는 취소하지 않는다. [Apple Keychain](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain)

Swift `WorkLogKeychain` 도우미는 JSON stdin/stdout 파이프로만 앱의 레코드를 주고받는다. 비밀값을 프로세스 argv로 넘기지 않는다. 도우미는 앱 번들과 버전별 실행 디렉터리에 함께 배포한다. GUI 및 worker에는 OAuth token을 전달하지 않는다.

## 하네스로 재사용하는 요약 작업

현재 자동 종료 요약과 GUI의 수동 재작성은 공통 **`text.rewrite`** 작업을 사용한다. work item 제목·설명에는 `format=work-item-metadata`, 세션 요약에는 `format=session-summary`를 지정한다. 입력 스냅샷·반영 전 버전 검사·GUI 동작은 [이력 기반 재작성 설계](on-demand-writing.md)를 따른다. 아래 `session.summarize`는 기존 실행을 이어 조회하기 위해 유지하는 호환 계약이다.

```json
{
  "task": "session.summarize",
  "input": {
    "title": "작업 세션",
    "events": [
      {"kind":"input","event_at":"2026-09-17T00:00:00Z","text":"권한 요구를 정리해 주세요."},
      {"kind":"output","event_at":"2026-09-17T00:05:00Z","text":"승인과 거절의 수용 기준을 정리했습니다."}
    ]
  }
}
```

관리 계층은 원본 입출력의 스냅샷과 해시를 고정해 실행 계층에 작업을 요청한다. 실행 계층은 `create-reviewed` workflow와 `REWRITE-001`(호환 작업은 `SUMMARY-001`) 규칙으로 생성 → 형식 검사 → 독립 검토 → 필요한 수정(최대 2회)을 실행한다. manager가 직접 모델 프로세스를 띄우지 않는다. 같은 재작성 요청의 재전송은 동일 실행 키를 사용한다. 변경 없는 자동 종료 요약은 중복 예약하지 않으며 GUI에서 명시적으로 다시 작성하면 새 실행을 만든다.

생성된 요약 파일의 경로·해시·형식을 다시 확인한 뒤 `session_summaries`에 반영한다. 요약은 내부 작업으로 기록하고 새 사용자 work item·시간 윈도우·완료 판정을 만들지 않는다. 실패한 요약은 원문이나 요청을 완료 사실로 바꿔 채우지 않고 GUI에서 재시도할 수 있다. 생성·검토에는 선택된 CLI의 모델 사용량이 발생한다. 엔진은 원본이 Claude/Codex이면 이를 따르고 그 외는 Codex를 기본값으로 한다.

## Jira 동기화와 복구

티켓 생성 intent, 요청 시점 메타데이터, 외부 결과를 `jira_links`에 기록한다. API 응답이 정상이어야 연결을 확정한다. 중복 클릭은 operation ID와 기존 연결 검사로 차단한다. 결과가 불명확한 POST는 재전송하지 않는다. GUI에서 티켓 키를 입력하면 해당 티켓의 `work-log` property에 저장된 원래 operation ID를 확인해 연결을 복구한다.

업무 로그는 `jira_worklogs`에 세션 ID, Jira 연결, 입력 해시, 안정적인 operation ID, 전송 상태와 Jira worklog ID를 저장한다. 전송 전에 intent를 저장한다. Jira worklog property에도 같은 출처를 넣는다. 전송 직후 서비스가 종료되거나 응답이 유실되면 다음 시작 때 Jira 목록을 페이지 단위로 조회해 출처가 일치하는 로그를 찾는다. 존재 여부를 확정할 수 없으면 `unknown`으로 남기고 GUI의 **전송 결과 다시 확인**을 제공한다. 확정된 거절은 **동기화 다시 시도**로 재시도한다.

같은 세션의 원문이 늦게 추가되면 새 스냅샷으로 재요약한다. 경계가 유지되면 기존 worklog ID와 출처를 확인한 뒤 PUT으로 갱신한다. 경계 자체가 바뀌어 기존 로그끼리 중복 시간이 될 수 있으면 관련 에이전트의 기존 로그를 `needs_review`로 표시하고 원격 데이터를 자동 삭제하거나 합치지 않는다. 사라진 세션의 경고도 work item 상세에서 확인할 수 있다.

Work Item 병합은 Jira 티켓을 병합하거나 이동시키지 않는다. 이미 동기화한 세션은 기존 Jira 연결을 유지한다. 아직 전송하지 않은 세션은 원래 work item의 티켓을 우선하며, 없으면 대표 work item의 티켓(또는 유일한 연결)을 사용한다. 여러 Jira 연결 중 대상을 정할 수 없는 경우 자동 전송하지 않는다.

## API와 구현 경계

- manager: `/api/integrations/atlassian` GET/PUT/DELETE, `/authorize` POST, `/sites`, `/projects`, `/issue-types`, `/jira-issue`, `/confluence-page` GET.
- 수동 생성: `/api/items/:id/jira` POST. 복구: `/api/jira-links/:operation/resolve` POST.
- 기존 이슈: `/api/integrations/atlassian/jira-search` GET으로 키·제목·URL 검색, `/jira-preview` GET으로 단일 이슈 확인, `/api/items/:id/jira/link` POST로 선택한 이슈 연결. 상태: `/api/jira-links/:operation/refresh`, `/transition` POST.
- 재작성: `/api/items/:id/metadata/regenerate`, `/api/sessions/:id/summary/regenerate` POST. 실패 요약의 기존 `/summary/retry`도 유지.
- 업무 로그 재시도: `/api/sessions/:id/worklog/retry` POST.
- 수집 알림: bearer 인증된 `/api/updates` SSE. token을 URL에 넣지 않는다.

실제 Jira/Confluence 호출은 관리 서비스의 제한된 클라이언트를 통한다. 임의 API proxy는 제공하지 않는다. Confluence는 페이지 읽기 클라이언트까지 구현했으며 게시 기능은 포함하지 않는다. Jira의 추가 필수 custom field가 있는 프로젝트는 생성 실패 이유를 표시하며 임의 값을 채우지 않는다. 실제 계정 연결과 프로젝트별 권한 확인은 설치 후 수행해야 한다.

E2E에서는 격리된 `op`/Keychain 프로세스와 loopback Atlassian 서버를 사용한다. 테스트 모드에서만 로컬 endpoint 주입과 fixture 모델을 허용한다. 일반 E2E는 자동 요약을 끄고, 이 연동 테스트는 `HARNESS_TEST_SESSION_SUMMARIES=1`로 fixture 요약을 명시적으로 켠다. 실제 계정·사용자 Keychain·유료 모델 API를 검증한 것으로 취급하지 않는다.

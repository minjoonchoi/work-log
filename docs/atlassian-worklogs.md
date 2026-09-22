# Atlassian 연결과 세션 업무 로그

작성일: 2026-09-17 · 연결 설정 갱신: 2026-09-21 · 상태: 로컬 구현. 과거 검증과 실제 계정 확인 범위는 [검증 기록](verification-atlassian.md)에서 구분한다.

## 확정 동작

Work Item은 훅의 세션 시작에서 자동 등록하며, 시작 이벤트가 없으면 첫 사용자 입력에서 생성한다. Jira 연결 없이도 로컬 업무·이력·요약·태그를 관리한다. GUI의 **업무 상세 → Jira 이슈 → 새 이슈 만들기**를 눌러 사이트·프로젝트·유형을 선택해야 Jira 티켓을 생성한다. **기존 이슈 연결**에서는 키·제목·URL로 검색하고 결과 목록에서 이슈를 선택해 연결한다. OAuth 연결이나 work item 생성만으로 티켓을 만들지 않는다. 생성 직전 저장된 work item의 제목·설명과 버전을 고정한다. 제목은 Jira `summary`, 설명은 Jira wiki의 구역·목록·본문을 보존하는 ADF `description`으로 변환해 전송하며 기존 Markdown·평문도 지원한다. 로컬 편집 원문은 유지한다. 미리보기 이후 내용이 바뀌면 요청을 거절해 최신 내용을 다시 확인하게 한다. 연결된 이슈의 링크·현재 상태·상태 변경은 [Jira 이슈 관리 설계](jira-issues.md)를 따른다.

에이전트 세션별로 마지막 출력과 다음 입력의 간격이 **1,200초 이상**이면 새 Work Item Session을 시작한다. 다음 입력이 실제로 관측되어 이전 세션의 경계가 확정되고, 이전 세션에 미종료 turn이 없을 때 요약을 예약한다. 시계만으로 20분 뒤 종료 이벤트를 만들지 않는다.

새로 생성하는 종료 세션 요약은 제목 1줄과 `- `로 시작하는 설명 1~5줄로 구성한다. 각 목록 항목은 독립된 줄로 작성한다. 이전 일반 문장 요약도 저장된 원문을 보존한다. 이 전체 텍스트 하나를 Jira worklog의 `comment`에 넣는다. 원본 입출력은 보존하고, 상세 화면에서는 이벤트 발생 시각 내림차순 무한 스크롤로 보여 준다. 인증된 SSE 알림 후 메타데이터와 새로 수집된 레코드를 조회하며 재연결 시 누락 구간을 따라잡는다. 이미 읽은 과거 페이지를 매번 다시 내려받지 않는다. 열린 세션, 스크롤 위치, 편집 중인 입력은 유지한다. [레코드 조회 계약](session-record-history.md)을 따른다.

| Jira 값 | 기준 |
|---|---|
| comment | 생성·형식 검사를 통과한 제목 + 줄바꿈 + 목록 설명 전체, ADF로 인코딩 |
| started | 세션의 첫 입력을 UTC 시각으로 표현 |
| timeSpentSeconds | 첫 입력부터 마지막 관측 출력까지의 초, 소수 초는 버림 |
| adjustEstimate | `leave`: 남은 추정 시간을 자동 수정하지 않음 |

20분 유휴 구간을 덧붙이지 않는다. 세션 안의 짧은 대기는 기록 구간에 포함되며, 이 값은 **입출력 관측 구간**이지 사람의 실작업 시간이나 모델 실행 시간 측정치가 아니다. 0초·출력 미확인은 임의로 반올림해 Jira에 전송하지 않는다. 여러 에이전트의 동시 세션은 별도 로그이므로 합계가 벽시계 경과 시간보다 클 수 있다.

Jira의 업무 로그 생성·조회·수정 API를 사용하며, 사이트에서 시간 기록이 켜져 있고 사용자에게 해당 프로젝트의 업무 로그 권한이 있어야 한다. [Jira worklogs 공식 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/)

## 연결 설정과 자격증명

GUI **연결 설정 → Atlassian 설정**에서 Atlassian OAuth 앱의 **Client ID·Client Secret**을 직접 입력한다. Claude/Codex의 스킬·훅 연결과는 별도 설정이다. 첫 저장에는 두 값이 필요하다. 같은 Client ID에서 Secret 입력을 생략하거나 비워 두면 기존 값을 유지하며, Client ID를 바꿀 때는 새 Secret을 함께 입력해야 한다.

**Atlassian 사이트 주소**는 선택 설정이다. `https://company.atlassian.net` 또는 호스트만 입력하면 HTTPS origin으로 정규화한다. 사용자 정보·경로·query·fragment·비표준 port·다른 도메인은 허용하지 않는다. 해당 주소를 OAuth의 accessible-resources와 대조하고 Jira·Confluence별 읽기 권한이 있는 사이트를 기본으로 선택한다. 다른 허용 사이트는 사용자가 선택할 수 있다. 지정한 사이트가 목록에 없거나 해당 제품 권한이 없으면 다른 사이트로 자동 대체하지 않는다. Jira 생성에 필요한 쓰기 권한도 따로 확인한다.

사이트 주소만 변경할 때는 자격증명 버전과 토큰을 교체하지 않고 진행 중인 OAuth도 유지한다. 기존 연결된 이슈·업무 로그는 저장된 `cloud_id`를 계속 사용한다. 이 설정은 Cloud OAuth의 API origin이나 토큰 서버를 바꾸지 않는다. 토큰은 `https://auth.atlassian.com/oauth/token`에서 교환하고 API는 `https://api.atlassian.com/ex/jira/{cloudId}/…` 또는 Confluence 경로로 요청한다. 서버·게이트웨이 주소 설정이나 Jira Server/Data Center 연결 기능이 아니다. [공식 3LO 호출 경로](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)

Secret 입력은 기본적으로 password 형식으로 숨긴다. 설정을 열거나 일반 상태를 조회할 때 응답에 저장된 Secret을 포함하거나 GUI로 전달하지 않는다. GUI는 사용자가 **보기**를 눌렀을 때만 인증된 로컬 API로 조회해 화면에 표시한다. 서비스 내부의 자격증명 확인·OAuth 교환에는 Keychain 값을 사용할 수 있다. 기본 데이터 디렉터리의 `integrations/atlassian.json`에는 `client_id`, 불투명한 `credential_version`, 선택한 `site_url` 등 설정 메타데이터만 저장하며 Secret·OAuth 토큰은 기록하지 않는다.

앱 자격증명과 OAuth 토큰은 macOS Keychain의 별도 레코드에 보관한다. 앱 자격증명 계정 키는 `client-`, OAuth 토큰 계정 키는 `oauth-` 접두사로 구분하며 로컬 데이터 디렉터리에 연결한다. 버전 메타데이터는 자격증명 변경을 식별하기 위한 값으로 Secret 자체가 아니다.

기존 1Password vault/item 설정은 자동으로 조회하거나 마이그레이션하지 않는다. 해당 설정을 발견하면 Client ID·Secret을 직접 다시 입력하도록 안내한다. 이 전환만으로 기존 업무 기록이나 OAuth 토큰을 삭제하지 않으며 `op` 설치·로그인은 필요하지 않다.

OAuth 앱의 Callback URL은 다음과 정확히 일치하도록 등록한다.

```text
http://127.0.0.1:47831/oauth/atlassian/callback
```

GUI의 연결 버튼이 기본 브라우저를 연다. 임시 loopback listener가 난수 state·10분 만료·일회성 콜백을 확인한다. 인증 코드 및 refresh 교환에는 Keychain에 저장한 앱의 Client ID·Secret을 사용한다. 요청 scope는 `offline_access`, `read:jira-work`, `read:jira-user`, `write:jira-work`, `read:page:confluence`, `read:space:confluence`, `write:page:confluence`다. Jira 사용자 읽기 또는 Confluence 게시 권한이 없는 이전 연결은 사용자가 다시 승인해야 한다. 실제 접근 가능한 사이트는 accessible-resources에서 확인한다. [Atlassian 3LO](https://developer.atlassian.com/cloud/jira/software/oauth-2-3lo-apps/)

Jira 이슈를 생성할 때는 해당 사이트의 현재 로그인 사용자를 먼저 조회해 보고자와 담당자에 같은 `accountId`를 명시한다. 사용자 조회·권한 확인에 실패하면 생성 요청을 보내지 않는다. 계정 인증이 조회와 생성 사이에 변경되면 현재 계정을 확인하고 다시 시도해야 한다. `read:jira-user`는 이 조회에 필요한 권한이며, 일반 이슈 댓글에는 기존 `read:jira-work`·`write:jira-work` 권한을 사용한다. [현재 사용자 조회](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/), [이슈 댓글 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)

Access/refresh token과 만료 정보는 **하나의 OAuth 전용 generic password 레코드**에 함께 저장한다. 회전된 두 토큰을 함께 교체하고, 동시 API 호출의 refresh는 한 번만 수행한다. 만료·회수된 refresh token은 재연결을 요구한다. Keychain 잠금·접근 실패 시 평문 파일로 대체하지 않는다. **연결 해제**는 OAuth 토큰 레코드만 지우고 앱 자격증명 레코드는 보존하며, Atlassian 계정의 앱 승인 자체는 취소하지 않는다. [Apple Keychain](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain)

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

관리 계층은 원본 입출력의 스냅샷과 해시를 고정해 실행 계층에 작업을 요청한다. 새 실행은 `create-checked` workflow와 `REWRITE-001`(호환 작업은 `SUMMARY-001`) 규칙으로 모델 생성 1회와 코드 형식 검사를 수행한다. 별도 모델 검토·수정 루프는 적용하지 않고 필요하면 사용자가 재생성한다. manager가 직접 모델 프로세스를 띄우지 않는다. 같은 재작성 요청의 재전송은 동일 실행 키를 사용한다. 변경 없는 자동 종료 요약은 중복 예약하지 않으며 GUI에서 명시적으로 다시 작성하면 새 실행을 만든다.

생성된 요약 파일의 경로·해시·형식을 다시 확인한 뒤 `session_summaries`에 반영한다. 요약은 내부 작업으로 기록하고 새 사용자 work item·시간 윈도우·완료 판정을 만들지 않는다. 실패한 요약은 원문이나 요청을 완료 사실로 바꿔 채우지 않고 GUI에서 재시도할 수 있다. 생성에는 선택된 CLI의 모델 사용량이 발생한다. 엔진·모델·effort는 작업 실행 설정과 승인된 실행 프로필을 따른다.

## Jira 동기화와 복구

Jira는 선택적인 원격 이력이다. 연결 전에도 로컬 요약·업무 유형 태그와 원본 이력을 사용할 수 있다. 나중에 연결하면 이미 종료·요약된 세션도 동기화하고 재요약은 기존 업무 로그를 갱신한다. [로컬 추적과 유형 태그](local-tracking-and-tags.md)에 데이터 소유권과 집계 기준을 정리한다.

티켓 생성 intent, 요청 시점 메타데이터, 외부 결과를 `jira_links`에 기록한다. API 응답이 정상이어야 연결을 확정한다. 중복 클릭은 operation ID와 기존 연결 검사로 차단한다. 결과가 불명확한 POST는 재전송하지 않는다. GUI에서 티켓 키를 입력하면 해당 티켓의 `work-log` property에 저장된 원래 operation ID를 확인해 연결을 복구한다.

업무 로그는 `jira_worklogs`에 세션 ID, Jira 연결, 입력 해시, 안정적인 operation ID, 전송 상태와 Jira worklog ID를 저장한다. 전송 전에 intent를 저장한다. Jira worklog property에도 같은 출처를 넣는다. 전송 직후 서비스가 종료되거나 응답이 유실되면 다음 시작 때 Jira 목록을 페이지 단위로 조회해 출처가 일치하는 로그를 찾는다. 존재 여부를 확정할 수 없으면 `unknown`으로 남기고 GUI의 **전송 결과 다시 확인**을 제공한다. 확정된 거절은 **동기화 다시 시도**로 재시도한다.

같은 세션의 원문이 늦게 추가되면 새 스냅샷으로 재요약한다. 경계가 유지되면 기존 worklog ID와 출처를 확인한 뒤 PUT으로 갱신한다. 경계 자체가 바뀌어 기존 로그끼리 중복 시간이 될 수 있으면 관련 에이전트의 기존 로그를 `needs_review`로 표시하고 원격 데이터를 자동 삭제하거나 합치지 않는다. 사라진 세션의 경고도 work item 상세에서 확인할 수 있다.

Work Item 병합은 Jira 티켓을 병합하거나 이동시키지 않는다. 이미 동기화한 세션은 기존 Jira 연결을 유지한다. 아직 전송하지 않은 세션은 원래 work item의 티켓을 우선하며, 없으면 대표 work item의 티켓(또는 유일한 연결)을 사용한다. 여러 Jira 연결 중 대상을 정할 수 없는 경우 자동 전송하지 않는다.

## API와 구현 경계

- manager: `/api/integrations/atlassian` GET/PUT/DELETE. GET은 `config.client_id`, `config.site_url?`, `has_client_secret` 등 상태 메타데이터만 반환하며 PUT은 `{client_id,client_secret?,site_url?}`를 받는다. `site_url` 생략은 기존 주소 보존, 빈 문자열은 기본 사이트 해제다. `/client-secret` POST는 **보기**에서만 `{client_id}`로 요청하는 저장 Secret 조회다. `/authorize` POST, `/sites?product=jira|confluence`(생략 시 Jira), `/projects`, `/issue-types`, `/jira-issue`, `/confluence-page` GET도 제공한다. 사이트 목록의 기본 선택 행은 `preferred:true`이며 제품별 권한과 지정 주소를 확인한 뒤 반환한다.
- 수동 생성: `/api/items/:id/jira` POST. 복구: `/api/jira-links/:operation/resolve` POST.
- 기존 이슈: `/api/integrations/atlassian/jira-search` GET으로 키·제목·URL 검색, `/jira-preview` GET으로 단일 이슈 확인, `/api/items/:id/jira/link` POST로 선택한 이슈 연결. 상태: `/api/jira-links/:operation/refresh`, `/transition` POST.
- 재작성: `/api/items/:id/metadata/regenerate`, `/api/sessions/:id/summary/regenerate` POST. 실패 요약의 기존 `/summary/retry`도 유지.
- 업무 로그 재시도: `/api/sessions/:id/worklog/retry` POST.
- 수집 알림: bearer 인증된 `/api/updates` SSE. token을 URL에 넣지 않는다.

실제 Jira/Confluence 호출은 관리 서비스의 제한된 클라이언트를 통한다. 임의 API proxy는 제공하지 않는다. Confluence는 페이지 읽기와 완료된 로컬 업무 요약의 명시적 공간 선택 게시를 지원한다. 새 페이지에는 업무·Jira 이슈를 설명하는 최종 본문만 게시하고 세션·부분 요약의 자동 부록은 추가하지 않는다. 구버전 업무 요약도 새 게시 시 근거 목록·내부 참조를 제외하되 로컬 저장 원문과 이미 게시된 원격 페이지는 보존한다. [업무 요약 게시](work-reports.md)를 따른다. Jira의 추가 필수 custom field가 있는 프로젝트는 생성 실패 이유를 표시하며 임의 값을 채우지 않는다. 실제 계정 연결과 프로젝트별 권한 확인은 설치 후 수행해야 한다.

E2E에서는 격리된 Keychain 프로세스와 loopback Atlassian 서버를 사용한다. 테스트 모드에서만 로컬 endpoint 주입과 fixture 모델을 허용한다. 일반 E2E는 자동 요약을 끄고, 이 연동 테스트는 `HARNESS_TEST_SESSION_SUMMARIES=1`로 fixture 요약을 명시적으로 켠다. 실제 계정·사용자 Keychain·유료 모델 API를 검증한 것으로 취급하지 않는다. 이전 `op` 기반 검증은 [과거 기록](verification-atlassian.md)으로 보존하며 직접 입력 방식의 검증 결과와 구분한다.

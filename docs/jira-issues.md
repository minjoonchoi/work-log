# Work item의 Jira 이슈 연결과 상태 변경

작성일: 2026-09-17 · 로컬 관리 서비스와 GUI 구현

## 사용자 흐름

Work item 상세의 **Jira 이슈** 영역에서 **새 이슈 만들기** 또는 **기존 이슈 연결**을 선택한다. 새 이슈는 저장된 work item 제목·설명을 사용하며 Jira wiki 설명의 구역·목록·본문을 ADF로 변환한다. 기존 Markdown·평문도 계속 지원한다. 기존 이슈는 사이트를 선택하고 **완전한 이슈 키(`TEAM-123`) 또는 제목**으로 검색한다. 같은 사이트의 `/browse/TEAM-123` URL도 지원한다. 결과 목록에서 키·제목·상태를 비교해 하나를 선택한 뒤 **이슈 연결**을 누른다. 검색·선택만으로 연결하거나 업무 로그를 전송하지 않는다. 연결은 기존 Jira 이슈의 제목·설명과 work item 메타데이터를 수정하지 않는다.

제목 검색은 관리 서비스의 `AtlassianClient.searchIssues`가 Jira REST API를 감싸 처리한다. GUI에는 JQL·인증 토큰·외부 API 주소를 전달하지 않는다. 제목의 단어마다 접두어 검색 조건을 결합하며, 구두점은 단어 경계로 처리한다. 실제 검색 일치는 Jira 색인·언어 분석에 따른다. 사용자 문자열을 JQL로 직접 실행하지 않는다. 한 번에 최대 20개를 반환하고 Jira의 `nextPageToken`으로 **더 보기**를 제공한다. 검색 총건수는 추정하지 않는다.

GUI에서 검색어·사이트를 변경하면 기존 선택과 다음 페이지를 무효화한다. 늦게 도착한 이전 검색 응답은 반영하지 않는다. 추가 페이지 조회 실패는 기존 결과와 선택을 보존하며, 최종 연결 시 이슈 ID·현재 접근 권한·work item 버전을 다시 확인한다. 키 조회는 검색 색인의 갱신을 기다리지 않고 직접 조회한다. 제목 검색은 [Jira enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)를 사용한다.

연결된 카드에는 클릭 가능한 이슈 키, Jira 제목, 현재 상태, 상태 새로고침, 변경할 상태 선택과 **상태 변경** 버튼을 제공한다. 링크는 macOS 앱의 기본 브라우저에서 열리고, 웹 GUI에서는 새 창으로 열린다. 키가 변경되어도 숫자 issue ID로 조회·전환·업무 로그 대상을 유지하고 새 키와 URL을 반영한다.

**제목·설명 반영**을 누르면 현재 work item 내용과 대상 Jira 이슈를 미리 보여 준다. **Jira에 반영**을 누른 경우에만 저장된 제목·설명을 전송한다. Work item을 편집·재생성하거나 상세 화면을 여는 동작은 기존 이슈를 자동으로 수정하지 않는다. 이전에 연결한 이슈에도 같은 명시적 반영 절차를 적용한다.

여러 work item을 병합하면 각 Jira 연결을 보존한다. 서로 다른 이슈는 별도 카드로 표시하고 같은 이슈의 카드는 중복 표시하지 않는다. 원래 세션의 업무 로그 연결은 유지한다. 하나의 미병합 work item에 연결을 추가하거나 교체하는 기능은 이번 범위에 포함하지 않는다.

연결 완료 후 종료 세션의 요약·시작 시각·관측 시간은 기존 [업무 로그 동기화](atlassian-worklogs.md) 규칙을 따른다. 이 점을 연결 확인 화면에도 표시한다. Jira 상태는 하네스 작업 상태와 별개이며, 이슈를 완료로 변경해도 로컬 work item이나 실행을 완료 처리하지 않는다.

## 설명 형식과 Jira 문서 변환

Work item의 새 생성·재작성 설명은 편집 가능한 Jira wiki 문자열을 기준으로 저장한다. `h2. 배경`, `h2. 목표`, `h2. 요구사항`, `h2. 작업 범위`, `h2. 참고사항`의 다섯 구역을 이 순서로 두고 목록 항목은 `* `로 시작한다. 새 업무 설명은 문장당 최대 120자·전체 최대 12문장으로 핵심 요구·범위·제약을 정리한다. 상세 변경·검증 결과는 결과 요약 댓글 작업에서 다루며 설명에 나열하거나 별도 결과 구역을 추가하지 않는다. 확인할 수 없는 사실은 `미확인`으로 표시한다. 새 실행의 고정 형식 계약과 기존 로컬 지시문 보존은 [재작성 문서](on-demand-writing.md)를 따른다.

GUI 상세·미리보기는 구역과 목록을 렌더링하고 편집창은 Jira wiki 원문을 유지한다. 기존 Markdown·평문 설명을 DB에서 자동 변환하지 않으며 직접 편집한 내용도 보존한다. 이전 설명을 자동으로 재작성하거나 이미 연결된 Jira 이슈를 조회만으로 변경하지 않는다.

Jira Cloud REST v3의 이슈 생성·수정은 저장된 제목을 `fields.summary`에, 설명을 Atlassian Document Format(ADF) 문서로 변환해 `fields.description`에 전송한다. Jira wiki 문자열을 `description`에 그대로 보내지 않는다. 생성과 제목·설명 반영은 같은 `jiraDescription` 변환기를 사용해 내용과 구역·목록의 순서를 보존한다. ADF는 `doc` 아래에 제목·문단·목록을 담는 JSON 문서이며 전송을 위해 변환해도 로컬 원문은 바뀌지 않는다. [Jira Cloud 이슈 생성·수정 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [ADF 구조](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)

| 설명 원문 | Jira 표현 |
|---|---|
| Jira wiki의 `h2. 배경` 등 다섯 구역 | `heading`, `attrs.level=2` |
| Jira wiki의 `* ` 목록 | `bulletList` 안의 `listItem` |
| Jira wiki의 `*강조*`, `{{코드}}` | `strong`, `code` 텍스트 mark |
| Jira wiki의 `[표시\|https://example.com]` | 허용된 `http`·`https` 주소의 `link` mark |
| 기존 Markdown의 `#`~`######` 제목 | `heading`, 해당 `attrs.level` |
| 일반 문장·줄바꿈 | `paragraph`, `text`, `hardBreak` |
| 기존 Markdown의 `-`, `*`, `+` 연속 한 단계 목록 | `bulletList` 안의 `listItem` |
| 기존 Markdown의 `1.` 또는 `1)` 연속 한 단계 목록 | 시작 번호를 보존하는 `orderedList` |
| 기존 Markdown의 `**강조**` | `strong` 텍스트 mark |
| 기존 Markdown의 `[표시](https://example.com)` | `http`·`https` 주소만 허용하는 `link` mark |

제목과 목록의 문법은 [heading](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/heading/), [bulletList](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/bulletList/), [orderedList](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/orderedList/) 규약을 따른다. 링크는 [link mark](https://developer.atlassian.com/cloud/jira/platform/apis/document/marks/link/)로 표현한다.

HTML·이미지·중첩 목록·표 등 지원하지 않는 구문은 문자로 남긴다. 코드 펜스 안의 내용도 제목·목록으로 재해석하지 않는다. `javascript:`·`data:` 링크나 인증 정보가 포함된 URL은 링크로 만들지 않는다. 기존 일반 텍스트 설명은 문장과 개행을 유지한다. Jira wiki나 Markdown 전체를 지원하는 편집기 또는 HTML 변환기로 취급하지 않는다.

세션 업무 로그의 댓글은 별도의 `plainTextADF`를 사용한다. 제목 한 줄과 최대 다섯 줄 요약이라는 기존 계약, 문자와 줄바꿈을 보존하며 업무 설명의 Jira wiki 구역 형식으로 바꾸지 않는다. 세션 요약과 캘린더 업무 요약 보고서의 생성 형식도 유지한다.

반영 요청은 로컬 work item의 버전과 미리보기 시점 Jira의 `updated`를 보낸다. 서비스는 최신 원격 버전을 조회하고 실제 전송 직전에도 로컬 식별자·버전을 확인한다. 중간 편집이나 병합, 이미 확인된 원격 변경이 있으면 전송을 거절한다. Jira 읽기와 PUT은 하나의 원자적 비교·교환이 아니므로, 원격 조회 뒤 PUT 직전 다른 사용자가 수정하는 경우까지 배제하지는 못한다.

## 상태 조회와 전환

관리 서비스는 선택한 사이트에 접근할 수 있는 OAuth 권한을 확인한 뒤 아래 공식 API를 사용한다.

| 동작 | Jira REST API |
|---|---|
| 새 이슈 생성 | `POST /rest/api/3/issue`, `fields.summary`, `fields.description`(ADF) |
| 제목 검색·다음 페이지 | `GET /rest/api/3/search/jql`, `jql`, `maxResults=20`, `nextPageToken` |
| 제목·상태·수정 버전 | `GET /rest/api/3/issue/{id}?fields=summary,status,updated` |
| 제목·구조화 설명 반영 | `PUT /rest/api/3/issue/{id}`, `fields.summary`, `fields.description`(ADF), 성공 `204` |
| 현재 사용자가 수행할 수 있는 전환 | `GET /rest/api/3/issue/{id}/transitions?expand=transitions.fields` |
| 선택한 전환 수행 | `POST /rest/api/3/issue/{id}/transitions`, `{"transition":{"id":"…"}}` |

상태 이름을 임의로 전송하지 않는다. API가 제공하는 transition ID와 대상 상태를 사용한다. 정상 전환의 `204 No Content`를 성공으로 처리한 뒤 실제 상태를 다시 읽는다. 사용자의 Jira 전환 권한과 프로젝트 워크플로가 적용된다. [Jira 공식 이슈·전환 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)

필수 추가 입력이 있는 전환은 선택 목록에서 비활성화하고 Jira 링크에서 처리하도록 안내한다. 필수 필드의 기본값이 있더라도 이 구현은 값을 임의로 선택하지 않는다. 쓰기 scope가 없거나 전환 목록이 비어 있으면 사유를 표시한다. 전환 목록 조회만 실패했을 때에도 성공적으로 읽은 제목·상태는 보여 준다.

열려 있는 상세 화면은 5초 갱신과 SSE를 사용하며 Jira 조회에는 30초 캐시를 적용한다. 외부에서 변경한 상태는 다음 조회 때 표시되며 새로고침 버튼으로 즉시 조회할 수 있다. 마지막으로 성공한 조회 시각과 조회 실패를 구분하고, 실패 시 이전 상태를 최신이라고 표시하지 않는다. 선택 중인 전환은 같은 이슈 버전의 실시간 이력 갱신 동안 유지한다. 상태나 수정 버전이 바뀌면 선택을 해제한다.

변경 전 최신 상태·수정 시각·허용 전환을 다시 조회한다. GUI가 선택한 기준과 다르면 전송하지 않고 최신 상태에서 다시 선택하게 한다. 이 검사는 Jira의 조건부 원자적 쓰기를 뜻하지 않는다. 조회와 POST 사이의 외부 변경은 Jira 워크플로 검증과 최종 재조회로 확인한다.

## 완료 결과 댓글

연결된 이슈의 `제목·설명 반영` 버튼은 현재 로컬 제목·본문을 미리보기로 확인하고 원격 이슈에 반영한다. Jira wiki 원문과 화면의 구조를 같은 ADF로 변환하며, 결과 댓글과 업무 로그는 설명에 합치지 않는다.

WorkLog에서 Jira가 반환한 대상 상태의 `statusCategory.key=done`인 전환을 선택하면, 성공한 상태 변경에 이어 `work-item.result.summarize`를 백그라운드로 실행한다. 상태 이름이 영어 Done인지 여부로 판단하지 않는다. 상태 변경 요청 시점의 해당 work item에 연결된 사용자 에이전트 세션 원본 입출력·유효한 요약을 고정한다. 제목·본문은 작업 맥락으로 사용하며, 내부 요약 worker의 대화를 수행 결과로 섞지 않는다.

생성 결과는 확인된 수행 내용·산출물·검증 결과와 남은 제약을 간결한 한 문단으로 표현한다. 모델 호출 1회와 JSON·길이·단락 형식 검사를 수행한다. 실제 결과가 없으면 미확인으로 명시하며 Done 상태 자체를 작업 성공의 근거로 사용하지 않는다. 이 댓글은 `POST /rest/api/3/issue/{issueId}/comment`로 작성하는 일반 댓글이다. 각 세션의 시작 시각·작업 시간을 담는 `/worklog`와 별개다. [공식 댓글 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)

상태 변경과 댓글 작성은 별도 결과다. 요약 또는 댓글 게시가 실패해도 성공한 Jira 상태 변경을 되돌리지 않는다. GUI에서 진행·생성 결과·실패 이유를 표시하고, 확정된 실패에만 다시 시도 버튼을 제공한다. 댓글 응답이 유실되거나 전송 중 서비스가 종료되면 `unknown`으로 보관하고 자동 재게시하지 않는다. 원격 댓글의 `work-log-result` 속성으로 동일 operation ID를 찾아야 게시를 확인한다. 조회 결과가 없더라도 접근 제한으로 보이지 않을 수 있으므로 미확인 상태를 유지한다. 댓글의 생성 완료를 로컬 업무 완료나 모델의 사실 검증으로 표현하지 않는다.

`jira_result_comments`는 전환 operation·연결·고정 입력·입력 해시·생성 run·전송 상태·댓글 ID를 보관한다. 같은 전환 재요청과 서비스 재시작으로 댓글을 중복 생성하지 않는다. 실패한 재시도는 새 operation ID로 같은 스냅샷을 사용하고, 미확인 전송은 조회만 가능하다. 작업이 병합·삭제되거나 연결이 변경되면 기존 스냅샷의 게시를 중단한다. WorkLog 밖에서 이루어진 상태 변경은 댓글 생성 트리거가 아니다.

## 구조화 명령과 저장

Jira 읽기·연결·상태 변경은 관리 계층의 명시적인 API 명령이다. 모델 판단이 필요하지 않으므로 헤드리스 텍스트 작업으로 만들지 않는다. 기존 제목·설명 및 세션 요약의 `text.rewrite` 계약은 유지한다.

| 관리 API | 용도 |
|---|---|
| `GET /api/integrations/atlassian/jira-search?cloud_id=…&query=…&next_page_token=…` | 키·제목·URL 검색과 다음 페이지. 응답은 `issues`, `next_page_token` |
| `GET /api/integrations/atlassian/jira-preview?cloud_id=…&key=…` | 기존 이슈 키 또는 URL 조회 |
| `POST /api/items/:id/jira` | 새 이슈 생성 |
| `POST /api/items/:id/jira/link` | 조회한 기존 이슈에 연결 |
| `POST /api/jira-links/:operation/refresh` | 상태·허용 전환 새로고침 |
| `POST /api/jira-links/:operation/transition` | 선택한 전환 수행 |
| `POST /api/jira-links/:operation/content` | 확인한 work item 제목·설명을 연결된 Jira에 반영 |
| `POST /api/jira-links/:operation/result-comment/retry` | 확정 실패한 완료 결과 댓글을 새 operation ID로 다시 작성·전송 |
| `POST /api/jira-links/:operation/result-comment/reconcile` | 응답 미확인 댓글을 원격 operation marker로 조회 |

기존 이슈 연결 요청:

```json
{
  "operation_id": "client-generated-unique-id",
  "version": 1,
  "cloud_id": "site-id",
  "key": "TEAM-123",
  "issue_id": "10042"
}
```

상태 변경 요청:

```json
{
  "operation_id": "another-client-generated-id",
  "transition_id": "21",
  "expected_status_id": "10000",
  "expected_updated": "2026-09-17T00:00:00.000Z"
}
```

제목·설명 반영 요청:

```json
{
  "operation_id": "unique-content-update-id",
  "version": 3,
  "expected_updated": "2026-09-17T00:00:00.000Z"
}
```

제목·설명은 위 요청을 접수할 때 서비스가 해당 work item에서 읽고 고정한다. 클라이언트에서 별도의 문구를 덧붙이지 않는다. `jira_content_changes`에 요청 스냅샷과 전송 상태를 기록하며 같은 operation ID를 다시 받아도 PUT을 재전송하지 않는다.

허용 필드·타입·식별자·등록된 연결을 검증한다. 연결은 네트워크 조회 후 work item 버전과 기존 연결을 트랜잭션 안에서 다시 검사한다. 동시 편집·연결·병합으로 대상을 바꾸지 않는다. 같은 operation ID는 원래 결과를 재사용하며 다른 대상이나 전환 내용으로 재사용하면 거부한다.

기존 `jira_links`를 연결의 기준으로 사용한다. `jira_issue_views`는 `(cloud_id, issue_id)` 기준의 마지막 상태·전환 목록·관측 시각·조회 오류를 보관하고 `jira_changes`는 상태 변경 intent와 결과를 보관한다. 같은 이슈에 대한 조회와 쓰기는 직렬화한다. 여러 work item이 같은 이슈를 가리켜도 같은 캐시·잠금을 사용한다.

## 응답 유실과 재시작

전환은 `preparing → sending → applied`로 기록한다. 전송 전 거절이나 확정된 API 거절은 `failed`다. `sending` 중 종료되거나 전송 결과가 불확실하면 `unknown`으로 보존하고 자동 재전송하지 않는다. 같은 요청을 재전송해도 추가 POST를 만들지 않는다.

새로고침에서 현재 상태가 요청 대상과 일치하면 `observed`로 기록하며 **현재 이슈가 요청한 상태이나 이전 전송 응답은 확인하지 못했다**고 표시한다. 이 요청이 상태 변경의 원인이었다고 추정하지 않는다. 대상과 다르면 `unknown`을 유지하고 추가 앱 전환을 막는다. 이 경우 이슈 링크로 Jira에서 현재 상황을 확인·처리할 수 있다.

204 성공 뒤 후속 조회만 실패하면 `applied`는 유지하고 이전 상태를 최신 미확인으로 표시한다. 성공한 POST를 다시 보내지 않는다. [Atlassian 연결 설정](atlassian-worklogs.md)의 Client ID·Secret 직접 입력과 앱 자격증명·OAuth 토큰의 Keychain 분리 보관 정책을 적용한다.

제목·설명 PUT도 전송 전 실패는 `failed`, 성공 확인은 `applied`, 응답 유실이나 전송 중 서비스 중단은 `unknown`으로 기록한다. `unknown`에서는 새 반영을 막고 새로고침을 요청한다. 숫자 이슈 ID로 현재 제목·설명을 읽어 요청 스냅샷과 같으면 `observed`, 다르면 `different`로 기록한다. 객체 키의 순서는 ADF 내용 차이로 보지 않는다. 두 상태 모두 이전 전송의 성공 여부를 확정한 것으로 표현하지 않는다. 현재 내용을 확인한 뒤 새 operation ID로 다시 반영할 수 있고, 이전 operation ID 재요청은 기록만 반환한다.

## 검증 범위

서비스 E2E는 `tests/e2e/jira-issues.test.mjs`, 브라우저 E2E는 `tests/ui/jira-issues.spec.mjs`, `tests/ui/jira-search.spec.mjs`에 있다. 키/URL 조회, 제목 검색·페이지 이동·접근 범위·특수문자, 연결의 동시성·멱등성, 제목 보존, 204 전환, 낡은 선택 거절, 추가 입력·권한 부족, 실패 조회·키 이동, 중복 클릭, 응답 유실·서비스 강제 종료·재개, 성공 후 조회 실패, 병합 후 독립 상태·업무 로그를 검증한다. GUI는 실제 링크의 href와 브라우저 열기 bridge, 검색 결과 선택·더 보기, 지연된 이전 응답 무시, 선택 보존, 상태 갱신, 실패 표시와 좁은 화면을 확인한다.

`tests/e2e/result-summary.test.mjs`, `tests/e2e/jira-result-comments.test.mjs`, `tests/e2e/jira-identity-comments.test.mjs`는 완료 댓글의 생성 계약·전환 연계·중복 방지·복구 및 생성자 지정 경로를 검증한다.

Atlassian·Keychain·요약 모델은 격리된 테스트 대역을 사용한다. 실제 계정의 권한·워크플로·외부 쓰기는 이 검증 결과에 포함하지 않는다. 이전 `op` 기반 자격증명 조회의 결과는 [과거 연동 검증 기록](verification-atlassian.md)으로 구분한다. macOS의 기본 브라우저 실행은 기존 NSWorkspace bridge를 재사용하며 브라우저 E2E는 bridge에 전달한 URL까지 확인한다.

`tests/e2e/jira-description.test.mjs`는 실제 로컬 관리 서비스와 모의 Jira HTTP API를 연결해 생성·수정의 ADF 제목·목록·강조·링크, 기존 일반 텍스트, HTML과 위험한 링크의 문자 보존, 업무 로그 댓글의 원문 보존, 쓰기 권한·204·거절·응답 유실을 검증한다. 새 Jira wiki 형식의 검증 대상에는 정확한 다섯 구역과 `* ` 목록의 ADF 변환, 생성·수정의 동일 본문 전달, 기존 Markdown·평문 원문 보존을 포함한다. 아래의 과거 회귀 결과와 이번 형식 변경의 검증 결과는 구분한다.

`tests/e2e/jira-content.test.mjs`는 명시적 반영 전 외부 수정 없음, 동시·재시작 후 멱등성, 로컬·원격 버전 충돌, 검사·인증 중 편집과 병합, 응답 유실의 동일/상이 판정, 이슈 키 이동, 후속 읽기 실패, 전송 중 서비스 종료 복구를 검증한다.

Jira 검색·세션별 작업 결과 연결을 구현한 2026-09-17 회귀 결과는 **서비스 95/95, GUI 27/27, 합계 122개 통과**였다. 기존 112개에 서비스 6개·GUI 4개를 추가했으며 [당시 검사 근거](../output/self-verification/2026-09-17T09-19-45.302Z/verification.md)를 보존한다. 이후 같은 날 세션 입출력 무한 스크롤을 추가한 **서비스 99/99·GUI 32/32**의 검사와 GUI 재검증 결과는 [세션 입출력 레코드](session-record-history.md)에 있다. Jira 상태 선택이 실시간 기록 추가 중 유지되는 시나리오도 실제 세션을 펼친 상태로 확인했다. macOS 앱 빌드·서명·ZIP 및 번들 서비스 smoke 검증도 통과했다. [패키지 검증](../output/package-validation.json), [Jira 검색 화면](../output/screenshots/jira-issue-search.png)은 Git에서 제외되는 로컬 산출물이다. 현재 전체 검증 안내는 [README](../README.md)를 따른다.

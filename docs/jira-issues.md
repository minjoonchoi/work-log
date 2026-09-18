# Work item의 Jira 이슈 연결과 상태 변경

작성일: 2026-09-17 · 로컬 관리 서비스와 GUI 구현

## 사용자 흐름

Work item 상세의 **Jira 이슈** 영역에서 **새 이슈 만들기** 또는 **기존 이슈 연결**을 선택한다. 새 이슈는 저장된 work item 제목·설명을 그대로 사용한다. 기존 이슈는 사이트를 선택하고 **완전한 이슈 키(`TEAM-123`) 또는 제목**으로 검색한다. 같은 사이트의 `/browse/TEAM-123` URL도 지원한다. 결과 목록에서 키·제목·상태를 비교해 하나를 선택한 뒤 **이슈 연결**을 누른다. 검색·선택만으로 연결하거나 업무 로그를 전송하지 않는다. 연결은 기존 Jira 이슈의 제목·설명과 work item 메타데이터를 수정하지 않는다.

제목 검색은 관리 서비스의 `AtlassianClient.searchIssues`가 Jira REST API를 감싸 처리한다. GUI에는 JQL·인증 토큰·외부 API 주소를 전달하지 않는다. 제목의 단어마다 접두어 검색 조건을 결합하며, 구두점은 단어 경계로 처리한다. 실제 검색 일치는 Jira 색인·언어 분석에 따른다. 사용자 문자열을 JQL로 직접 실행하지 않는다. 한 번에 최대 20개를 반환하고 Jira의 `nextPageToken`으로 **더 보기**를 제공한다. 검색 총건수는 추정하지 않는다.

GUI에서 검색어·사이트를 변경하면 기존 선택과 다음 페이지를 무효화한다. 늦게 도착한 이전 검색 응답은 반영하지 않는다. 추가 페이지 조회 실패는 기존 결과와 선택을 보존하며, 최종 연결 시 이슈 ID·현재 접근 권한·work item 버전을 다시 확인한다. 키 조회는 검색 색인의 갱신을 기다리지 않고 직접 조회한다. 제목 검색은 [Jira enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)를 사용한다.

연결된 카드에는 클릭 가능한 이슈 키, Jira 제목, 현재 상태, 상태 새로고침, 변경할 상태 선택과 **상태 변경** 버튼을 제공한다. 링크는 macOS 앱의 기본 브라우저에서 열리고, 웹 GUI에서는 새 창으로 열린다. 키가 변경되어도 숫자 issue ID로 조회·전환·업무 로그 대상을 유지하고 새 키와 URL을 반영한다.

여러 work item을 병합하면 각 Jira 연결을 보존한다. 서로 다른 이슈는 별도 카드로 표시하고 같은 이슈의 카드는 중복 표시하지 않는다. 원래 세션의 업무 로그 연결은 유지한다. 하나의 미병합 work item에 연결을 추가하거나 교체하는 기능은 이번 범위에 포함하지 않는다.

연결 완료 후 종료 세션의 요약·시작 시각·관측 시간은 기존 [업무 로그 동기화](atlassian-worklogs.md) 규칙을 따른다. 이 점을 연결 확인 화면에도 표시한다. Jira 상태는 하네스 작업 상태와 별개이며, 이슈를 완료로 변경해도 로컬 work item이나 실행을 완료 처리하지 않는다.

## 상태 조회와 전환

관리 서비스는 선택한 사이트에 접근할 수 있는 OAuth 권한을 확인한 뒤 아래 공식 API를 사용한다.

| 동작 | Jira REST API |
|---|---|
| 제목 검색·다음 페이지 | `GET /rest/api/3/search/jql`, `jql`, `maxResults=20`, `nextPageToken` |
| 제목·상태·수정 버전 | `GET /rest/api/3/issue/{id}?fields=summary,status,updated` |
| 현재 사용자가 수행할 수 있는 전환 | `GET /rest/api/3/issue/{id}/transitions?expand=transitions.fields` |
| 선택한 전환 수행 | `POST /rest/api/3/issue/{id}/transitions`, `{"transition":{"id":"…"}}` |

상태 이름을 임의로 전송하지 않는다. API가 제공하는 transition ID와 대상 상태를 사용한다. 정상 전환의 `204 No Content`를 성공으로 처리한 뒤 실제 상태를 다시 읽는다. 사용자의 Jira 전환 권한과 프로젝트 워크플로가 적용된다. [Jira 공식 이슈·전환 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)

필수 추가 입력이 있는 전환은 선택 목록에서 비활성화하고 Jira 링크에서 처리하도록 안내한다. 필수 필드의 기본값이 있더라도 이 구현은 값을 임의로 선택하지 않는다. 쓰기 scope가 없거나 전환 목록이 비어 있으면 사유를 표시한다. 전환 목록 조회만 실패했을 때에도 성공적으로 읽은 제목·상태는 보여 준다.

열려 있는 상세 화면은 5초 갱신과 SSE를 사용하며 Jira 조회에는 30초 캐시를 적용한다. 외부에서 변경한 상태는 다음 조회 때 표시되며 새로고침 버튼으로 즉시 조회할 수 있다. 마지막으로 성공한 조회 시각과 조회 실패를 구분하고, 실패 시 이전 상태를 최신이라고 표시하지 않는다. 선택 중인 전환은 같은 이슈 버전의 실시간 이력 갱신 동안 유지한다. 상태나 수정 버전이 바뀌면 선택을 해제한다.

변경 전 최신 상태·수정 시각·허용 전환을 다시 조회한다. GUI가 선택한 기준과 다르면 전송하지 않고 최신 상태에서 다시 선택하게 한다. 이 검사는 Jira의 조건부 원자적 쓰기를 뜻하지 않는다. 조회와 POST 사이의 외부 변경은 Jira 워크플로 검증과 최종 재조회로 확인한다.

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

허용 필드·타입·식별자·등록된 연결을 검증한다. 연결은 네트워크 조회 후 work item 버전과 기존 연결을 트랜잭션 안에서 다시 검사한다. 동시 편집·연결·병합으로 대상을 바꾸지 않는다. 같은 operation ID는 원래 결과를 재사용하며 다른 대상이나 전환 내용으로 재사용하면 거부한다.

기존 `jira_links`를 연결의 기준으로 사용한다. `jira_issue_views`는 `(cloud_id, issue_id)` 기준의 마지막 상태·전환 목록·관측 시각·조회 오류를 보관하고 `jira_changes`는 상태 변경 intent와 결과를 보관한다. 같은 이슈에 대한 조회와 쓰기는 직렬화한다. 여러 work item이 같은 이슈를 가리켜도 같은 캐시·잠금을 사용한다.

## 응답 유실과 재시작

전환은 `preparing → sending → applied`로 기록한다. 전송 전 거절이나 확정된 API 거절은 `failed`다. `sending` 중 종료되거나 전송 결과가 불확실하면 `unknown`으로 보존하고 자동 재전송하지 않는다. 같은 요청을 재전송해도 추가 POST를 만들지 않는다.

새로고침에서 현재 상태가 요청 대상과 일치하면 `observed`로 기록하며 **현재 이슈가 요청한 상태이나 이전 전송 응답은 확인하지 못했다**고 표시한다. 이 요청이 상태 변경의 원인이었다고 추정하지 않는다. 대상과 다르면 `unknown`을 유지하고 추가 앱 전환을 막는다. 이 경우 이슈 링크로 Jira에서 현재 상황을 확인·처리할 수 있다.

204 성공 뒤 후속 조회만 실패하면 `applied`는 유지하고 이전 상태를 최신 미확인으로 표시한다. 성공한 POST를 다시 보내지 않는다. 1Password·OAuth·Keychain의 기존 보관 정책과 범위는 그대로 적용한다.

## 검증 범위

서비스 E2E는 `tests/e2e/jira-issues.test.mjs`, 브라우저 E2E는 `tests/ui/jira-issues.spec.mjs`, `tests/ui/jira-search.spec.mjs`에 있다. 키/URL 조회, 제목 검색·페이지 이동·접근 범위·특수문자, 연결의 동시성·멱등성, 제목 보존, 204 전환, 낡은 선택 거절, 추가 입력·권한 부족, 실패 조회·키 이동, 중복 클릭, 응답 유실·서비스 강제 종료·재개, 성공 후 조회 실패, 병합 후 독립 상태·업무 로그를 검증한다. GUI는 실제 링크의 href와 브라우저 열기 bridge, 검색 결과 선택·더 보기, 지연된 이전 응답 무시, 선택 보존, 상태 갱신, 실패 표시와 좁은 화면을 확인한다.

Atlassian·op·Keychain·요약 모델은 격리된 테스트 대역을 사용한다. 실제 계정의 권한·워크플로·외부 쓰기는 이번 검증 결과에 포함하지 않는다. macOS의 기본 브라우저 실행은 기존 NSWorkspace bridge를 재사용하며 브라우저 E2E는 bridge에 전달한 URL까지 확인한다.

Jira 검색·세션별 작업 결과 연결을 구현한 2026-09-17 회귀 결과는 **서비스 95/95, GUI 27/27, 합계 122개 통과**였다. 기존 112개에 서비스 6개·GUI 4개를 추가했으며 [당시 검사 근거](../output/self-verification/2026-09-17T09-19-45.302Z/verification.md)를 보존한다. 이후 세션 입출력 무한 스크롤을 추가한 **서비스 99/99·GUI 32/32**의 최신 검사와 GUI 재검증 결과는 [세션 입출력 레코드](session-record-history.md)에 있다. Jira 상태 선택이 실시간 기록 추가 중 유지되는 시나리오도 실제 세션을 펼친 상태로 확인했다. macOS 앱 빌드·서명·ZIP 및 번들 서비스 smoke 검증도 통과했다. [패키지 검증](../output/package-validation.json), [Jira 검색 화면](../output/screenshots/jira-issue-search.png)은 Git에서 제외되는 로컬 산출물이다.

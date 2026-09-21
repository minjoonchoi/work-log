# 실시간 이력·Atlassian 연동 검증 기록

## 현재 연결 설정과 검증 구분

2026-09-21부터 연결 설정은 Client ID·Client Secret 직접 입력 방식이다. 앱 자격증명과 OAuth 토큰을 macOS Keychain의 별도 레코드에 보관하고, 설정에는 Client ID·불투명한 자격증명 버전 등 메타데이터만 남긴다. 저장된 Secret은 사용자가 **보기**를 눌렀을 때만 로컬 API로 조회한다. 같은 ID에서 Secret을 비워 저장하면 기존 값을 유지하며, ID 변경에는 새 Secret이 필요하다. 연결 해제는 토큰만 제거한다. 상세 계약은 [현재 연동 설계](atlassian-worklogs.md)를 따른다.

과거 섹션의 수치와 `op` 조회 시나리오는 **1Password 기반으로 구현했던 당시의 검증 기록**이다. 현재 앱은 vault/item을 자동 조회하거나 마이그레이션하지 않으며 직접 재입력을 안내한다. 기존 업무 기록과 토큰은 보존한다. 과거 통과 수치를 직접 입력·명시적 Secret 보기 기능의 검증 결과로 사용하지 않는다.

## 직접 입력 검증: 2026-09-21

직접 입력·Keychain 분리 저장·빈 Secret 유지·명시적 보기·재열기·갱신 중 입력 보존을 검증했다. 연결 해제보다 늦게 처리되는 OAuth 콜백이 토큰을 복원하지 않는지도 확인했다. 관련 서비스 테스트 101개와 GUI 5개, 총 106개가 통과했다. 서비스 검증에는 콜백 대기열 경합을 재현하는 결정적 대역 검사도 포함한다. 기존 자격증명 테스트 대역과 토큰 읽기 대기 지점을 새 저장 구조에 맞춰 수정한 뒤 영향받은 19개를 재검증했다.

근거는 [검증 결과](../output/oauth-client-verification.json)와 그 안의 로그에 있다. macOS 앱과 Keychain 도우미 빌드를 완료했고 번들 소스 134개가 작업 디렉터리와 일치한다. 실제 Atlassian 계정 로그인이나 설치본 갱신은 하지 않았다.

## 과거 검증: 2026-09-17

Jira 키·제목 검색과 세션 입출력 무한 스크롤을 포함한 2026-09-17 검증 결과는 **서비스 99개·GUI 32개 통과**다. 설계는 [Jira 이슈 관리](jira-issues.md), 해당 시나리오와 검사·GUI 재검증 근거는 [세션 입출력 레코드](session-record-history.md)에 정리했다. 아래 84개 결과는 최초 실시간 이력·업무 로그 구현 시점의 기록이다. 현재 전체 검증 안내는 [README](../README.md)를 따른다.

당시 서비스·CLI·설치 E2E와 GUI 시나리오를 실제 subprocess, loopback HTTP, SQLite, 파일, Chrome으로 실행했다. Atlassian 서버·1Password CLI·Keychain 응답과 요약 모델만 테스트 대역이었다. 실제 계정 로그인, Jira 티켓/업무 로그 생성, 유료 모델 호출은 수행하지 않았다.

### 당시 검증 시나리오

| 영역 | 확인한 동작 |
|---|---|
| 원본 이력 | 실제 Claude/Codex 훅 subprocess의 입출력이 열린 GUI에 최신순으로 추가됨; 같은 이벤트 중복 제거 |
| 실시간 복구 | 지연 수집은 원본 시각으로 정렬; 편집 중 입력·열린 이력을 보존; manager 재시작과 스풀 적재 후 재연결 |
| OAuth | 설정은 vault/item 참조만 저장; 잘못된 state 거부; 코드 교환; 만료 및 401 refresh; 동시 refresh 1회; 두 토큰 회전; 재시작; 인증 회수 시 연결 해제 |
| 접근 실패 | op 접근·실행 불가, Keychain 잠금, Jira 쓰기 scope 누락; 전송 전 실패를 생성 성공이나 불명확한 POST로 오인하지 않음 |
| Jira 수동 생성 | 훅으로 item을 만들어도 Jira 호출 없음; 생성 버튼과 사이트·프로젝트·유형 선택; 저장된 제목·설명/줄바꿈 일치; 낡은 버전·중복 클릭 거부 |
| Jira 조회 | 프로젝트·이슈 유형 pagination, Jira 티켓 읽기, Confluence 페이지 읽기 |
| 종료 세션 | 정확히 20분 경계 → 구조화된 요약 작업 → 제목 1줄+최대 5줄 → comment/started/초 단위 시간 전송 |
| 요약 계약 | 동일 입력의 실행 키 재사용, 다른 입력 거부, 6줄 초과 산출물 실패·수정 한도 준수, 내부 작업의 사용자 item/윈도우 재귀 방지 |
| 동기화 복구 | 불명확한 issue POST는 property 검사 후 연결; worklog 응답 유실은 조회 후 기존 로그 확인; 원문 추가는 같은 ID로 PUT |
| 실패와 경계 | 권한 거절 후 명시적 재시도; 0초를 임의 작업 시간으로 만들지 않음; 늦은 이벤트가 경계를 바꾸면 중복 집계 방지를 위한 확인 필요 표시 |
| 업무 병합 | n일·복수 에이전트의 세션을 하나의 item에 모으고 각 세션의 기존 Jira 티켓 연결 유지 |
| macOS | AppKit/WKWebView 앱과 Security/LocalAuthentication Keychain 도우미 컴파일, ad-hoc 서명 검사, 메뉴 막대 GUI 업무 목록·월 캘린더·설정·세션 상세의 실제 앱 화면 확인 |

### 당시 결과와 근거

검사 결과는 하네스의 `checks.run` → `verification.report` 실행으로 기록한다. `output/self-verification/latest.json`이 현재 보고서를 가리킨다. 테스트 소스는 `tests/e2e/atlassian.test.mjs`, `tests/ui/integrations.spec.mjs`, `tests/ui/workflows.spec.mjs`에 있다.

- 서비스·CLI·설치 E2E: **68/68 통과**.
- GUI E2E: **16/16 통과**. 화면 점검에서 발견한 내부 worker 출력의 중복 표시를 수정한 후 GUI 16개를 다시 실행해 통과했다.
- 총 **84개 시나리오**, 실패·스킵 없음. 하네스의 검사 실행과 근거 보고서 생성도 완료했다.
- [전체 검사 근거 보고서](../output/self-verification/2026-09-17T04-30-07.161Z/verification.md), [최종 GUI 재검증 보고서](../output/self-verification/2026-09-17T04-31-51.590Z/verification.md).
- macOS 빌드: `output/build-mac.log`.
- GUI 화면: `output/screenshots/`의 `blue-` 파일. Jira 값은 격리된 모의 데이터다.

### 당시 실제 환경에서 남은 확인

2026-09-17 최초 검증 당시 이 컴퓨터에서는 `op` 실행 파일이 발견되지 않았다. 실제 vault/item 이름도 설정하지 않았으므로 실제 1Password 읽기·OAuth 로그인·사용자 Keychain 저장·Jira/Confluence 호출은 수행하지 않았다. Swift 도우미는 컴파일·패키징까지 검증했고, Keychain 잠금·저장·회전 프로토콜은 테스트 대역으로 검증했다. 사용자 Keychain에서의 실제 접근은 별도 설치·연결 시 확인해야 한다.

새 `session.summarize`의 모델 출력 품질은 이 테스트만으로 입증하지 않는다. 로컬 E2E에서는 fixture subprocess가 형식·루프·상태·연결을 검증했다. 이전 승인으로 수행한 PRD/HTML/엔티티 실모델 결과는 [별도 기록](live-model-e2e-v0.3.1.md)에 있고, 이번 작업에서 추가 유료 호출은 하지 않았다.

최초 검증 당시 앱은 워크스페이스에 빌드했으며 `~/Applications`, LaunchAgent, 실제 Claude/Codex 훅 설정에는 설치하지 않았다. 개발용 ad-hoc 서명이며 공증은 적용하지 않았다.

## 과거 추가 검증: 1Password 이름 → ID 조회

이 절은 현재 사용하지 않는 `op` 기반 구현의 기록이다. 당시에는 설정에 vault 이름과 item 이름만 저장했다. OAuth 연결 시작과 토큰 갱신에 필요한 자격증명을 읽을 때마다 다음 순서로 조회했다. 이름의 대소문자와 전체 문자열이 정확히 일치하는 항목 하나만 허용했으며, 이전 조회의 ID를 재사용하지 않았다.

```text
op vault list --format json
op item list --vault <vaultID> --format json
op item get <itemID> --vault <vaultID> --fields label=client_id,label=client_secret --format json --reveal
```

첫 목록에서 vault 이름을 ID로 확정하고, 해당 vault로 제한한 item 목록에서 제목을 ID로 확정했다. 선택한 item의 `vault.id`도 대조했다. 이름 누락·중복이나 다른 vault의 item은 자격증명 읽기 전에 차단했다. ID는 조회 중 메모리에서만 사용했으며 설정·API 상태·로그·Keychain에 저장하지 않았다. 당시 Keychain은 OAuth 토큰과 검증용 해시만 보관했다. 명령 인터페이스는 공식 [vault 명령](https://www.1password.dev/cli/reference/management-commands/vault)과 [item 명령](https://www.1password.dev/cli/reference/management-commands/item)의 목록 조회, vault 제한, ID 조회 및 필드 반환 규약을 따랐다.

당시 `tests/e2e/credentials.test.mjs`는 실제 manager와 credential subprocess를 실행하고 loopback OAuth 서버와 연결해 다음을 확인했다. 자격증명 대역만 사용했으며 실제 `op`, 사용자 Keychain, Atlassian 계정에는 접근하지 않았다.

- 이름으로 찾은 정확한 ID와 인자 순서로 조회하고, 같은 이름의 vault/item이 새 ID로 바뀌면 refresh 전에 다시 해석한다.
- 이름 누락·대소문자 불일치·동명이름·다른 vault·vault 근거 누락은 후속 조회와 OAuth 요청을 차단한다.
- 각 조회 단계의 접근 거절, 잘못된 JSON·목록·ID, 누락·중복·빈 자격증명 필드는 성공으로 취급하지 않는다.
- subprocess의 비밀이 포함된 오류 출력과 잘못된 응답 본문은 API 오류·설정·로그에 노출하지 않는다.
- refresh 중 item 이름이 중복되면 토큰 교환을 중단하고 기존 토큰을 보존하며, 이름이 다시 유일해진 뒤 정상 갱신한다.

`node --test --test-concurrency=1 tests/e2e/credentials.test.mjs tests/e2e/atlassian.test.mjs` 결과는 **35개 통과**다. 신규 자격증명 테스트 4개와 그 하위 사례 22개, 기존 Atlassian E2E 9개를 포함한다. 실제 계정 연결 여부와 별개인 격리 검증 결과다.

`npx playwright test tests/ui/integrations.spec.mjs --output output/playwright/credentials-review --reporter=list`도 **GUI 2개 통과**했다. 저장한 이름 참조의 보존, OAuth 연결, Jira 수동 생성과 업무 로그 동기화까지 새 조회 순서로 실행했다.

# 실시간 이력·Atlassian 연동 검증

검증일: 2026-09-17

Jira 키·제목 검색과 세션 입출력 무한 스크롤을 포함한 최신 검증 결과는 **서비스 99개·GUI 32개 통과**다. 설계는 [Jira 이슈 관리](jira-issues.md), 최신 시나리오와 검사·GUI 재검증 근거는 [세션 입출력 레코드](session-record-history.md)에 정리했다. 아래 84개 결과는 최초 실시간 이력·업무 로그 구현 시점의 기록이다.

서비스·CLI·설치 E2E와 GUI 시나리오를 실제 subprocess, loopback HTTP, SQLite, 파일, Chrome으로 실행한다. Atlassian 서버·1Password CLI·Keychain 응답과 요약 모델만 테스트 대역이다. 실제 계정 로그인, Jira 티켓/업무 로그 생성, 유료 모델 호출을 수행하지 않는다.

## 검증 시나리오

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

## 결과와 근거

검사 결과는 하네스의 `checks.run` → `verification.report` 실행으로 기록한다. `output/self-verification/latest.json`이 현재 보고서를 가리킨다. 테스트 소스는 `tests/e2e/atlassian.test.mjs`, `tests/ui/integrations.spec.mjs`, `tests/ui/workflows.spec.mjs`에 있다.

- 서비스·CLI·설치 E2E: **68/68 통과**.
- GUI E2E: **16/16 통과**. 화면 점검에서 발견한 내부 worker 출력의 중복 표시를 수정한 후 GUI 16개를 다시 실행해 통과했다.
- 총 **84개 시나리오**, 실패·스킵 없음. 하네스의 검사 실행과 근거 보고서 생성도 완료했다.
- [전체 검사 근거 보고서](../output/self-verification/2026-09-17T04-30-07.161Z/verification.md), [최종 GUI 재검증 보고서](../output/self-verification/2026-09-17T04-31-51.590Z/verification.md).
- macOS 빌드: `output/build-mac.log`.
- GUI 화면: `output/screenshots/`의 `blue-` 파일. Jira 값은 격리된 모의 데이터다.

## 실제 환경에서 남은 확인

이 컴퓨터에서는 `op` 실행 파일이 발견되지 않았다. 실제 vault/item 이름도 설정하지 않았으므로 실제 1Password 읽기·OAuth 로그인·사용자 Keychain 저장·Jira/Confluence 호출은 수행하지 않았다. Swift 도우미는 컴파일·패키징까지 검증했고, Keychain 잠금·저장·회전 프로토콜은 테스트 대역으로 검증했다. 사용자 Keychain에서의 실제 접근은 별도 설치·연결 시 확인해야 한다.

새 `session.summarize`의 모델 출력 품질은 이 테스트만으로 입증하지 않는다. 로컬 E2E에서는 fixture subprocess가 형식·루프·상태·연결을 검증했다. 이전 승인으로 수행한 PRD/HTML/엔티티 실모델 결과는 [별도 기록](live-model-e2e-v0.3.1.md)에 있고, 이번 작업에서 추가 유료 호출은 하지 않았다.

앱은 워크스페이스에 빌드했으며 `~/Applications`, LaunchAgent, 실제 Claude/Codex 훅 설정에는 설치하지 않았다. 개발용 ad-hoc 서명이며 공증은 적용하지 않았다.

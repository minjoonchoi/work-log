# 모델 실행 프로필

모델과 추론 수준은 사용자 요청이나 worker 출력에서 선택하지 않는다. 각 모델 기반 업무는 `harness/jobs.json`의 `execution_profile`로 `harness/execution-profiles/<유형>.json`을 참조한다. 프로필은 해당 workflow에서 사용하는 `produce` 또는 `plan`, `review`, `repair` 단계별로 Codex와 Claude의 `model`, `effort`를 지정한다. 실행 서비스는 업무 요청을 등록할 때 선택된 프로필 전체를 실행 정의에 고정하고 정의 해시에 포함한다.

GUI의 **작업 실행 설정**에서는 특정 업무의 지시문, 기본 backend, Codex/Claude별 model과 effort override를 로컬에서 관리한다. 설정은 `DATA_ROOT/execution-settings.json`에 저장하며 GitHub의 배포 기본 문서를 수정하지 않는다. model 또는 effort를 비워 두면 해당 backend의 단계별 유형 기본값을 사용한다. 값을 지정하면 그 업무의 생성·계획·검토·수정 단계에 동일한 override를 적용한다.

기본 지시문은 업무별 역할과 책임 경계에서 `목적`, `입력`, `범위`, `수행 절차`, `완료 기준`을 갖춘 Markdown으로 구성한다. GUI는 미리보기를 기본으로 열고 **원문 편집**에서 Markdown을 수정한다. 제목·목록·강조·코드 블록을 표시하며 HTML·링크·이미지는 실행하거나 가져오지 않고 텍스트로 보여 준다. 저장된 원문은 새 실행의 실제 worker 프롬프트에도 동일하게 사용한다. 기존 수동 지시문은 일반 텍스트여도 그대로 보존하고, **기본값 복원**을 선택하면 구조화된 기본 지시문으로 돌아간다. 편집 가능한 지시문과 별개로 담당·제외 범위 및 완료 기준의 검증 계약은 유지한다.

설정 대상은 모델 기반 업무 64개이며 제품·프로젝트·설계·FE·BE·개발 공통·조사 문서·시스템의 8개 그룹으로 표시한다. 로컬 검사 실행과 근거 보고서인 `checks.run`, `verification.report`에는 모델 설정이 없다. 업무의 담당·제외 범위·필요 자료·완료 기준은 읽기 전용이며 지시문 편집으로 바뀌지 않는다.

새 run은 `명시적으로 검증된 API engine → 로컬 업무 backend → codex` 순서로 backend를 결정하고, 로컬 model/effort override가 있으면 유형 프로필 위에 적용한다. 지시문과 최종 실행 프로필은 run 생성 시 복사해 정의 해시에 포함하므로 GUI에서 설정을 바꿔도 진행 중인 run이나 재개되는 기존 run은 바뀌지 않는다. 복합 계획은 접수할 때 모든 자식 정의를 고정하므로 아직 시작하지 않은 대기 작업에도 접수 당시 설정을 사용한다. 수정은 revision 비교로 다른 GUI 창의 변경을 덮어쓰지 않는다.

현재 유형은 다음과 같다.

| 프로필 | 적용 업무 | 기본 설정 |
|---|---|---|
| `document` | PRD, 제품·프로젝트·설계·조사·검토 문서, 일반 텍스트 | 생성 medium, 검토·수정 high |
| `html` | 동작형 HTML 목업 | 모든 모델 단계 high |
| `data-model` | 엔티티 설계 | 모든 모델 단계 high |
| `metadata` | 세션 요약, 제목·설명 재작성 | 생성 low, 검토·수정 medium |
| `scenario` | E2E 시나리오 계획 | 모든 모델 단계 high |
| `coding` | FE·BE 구현, 버그 수정, 리팩터링, 테스트 작성, 리뷰 반영 | 모든 모델 단계 high |

Codex는 `--model <model>`과 `-c model_reasoning_effort="<effort>"`를 사용한다. Claude는 `--model <model>`과 `--effort <effort>`를 사용한다. 선택값은 각 attempt의 `process.json`에도 기록한다. 새 업무는 기존 프로필을 명시적으로 참조하거나 필요한 유형 문서를 먼저 추가해야 하며, 모델 기반 workflow인데 프로필 또는 단계 설정이 빠지면 서비스 시작을 거부한다.

모델 subprocess는 비대화형으로 멈추지 않도록 Codex에 `--dangerously-bypass-approvals-and-sandbox`, Claude에 `--allow-dangerously-skip-permissions --permission-mode bypassPermissions`를 전달한다. Claude의 allow 플래그만으로는 bypass 모드가 시작되지 않으므로 permission mode도 명시한다. 따라서 CLI 자체의 승인·sandbox가 실행 경계가 되지 않는다. 하네스는 작업별 임시 디렉터리, 프롬프트의 변경 범위, 산출물 해시·허용 파일·코드 묶음 검증기로 결과 범위를 판정하지만 이것은 OS 수준 격리를 대신하지 않는다. 운영 배포에서는 프로세스 계정·파일 권한·네트워크 정책으로 실행 환경을 별도로 제한해야 한다.

지원 형식은 `contracts/execution-profile.schema.json`으로 검사한다. Codex 기본 모델은 요약·메타데이터의 `metadata` 프로필에서 `gpt-5.6-luna`, 나머지 프로필에서 `gpt-5.6-terra`를 사용한다. Claude 기본 모델은 `sonnet`이다. 2026-09-19의 [공식 모델 목록](https://learn.chatgpt.com/docs/models)과 설치된 Codex 계정의 모델 목록에서 이 식별자를 확인했다. `gpt-5.6`만 지정하면 ChatGPT 계정에서 지원하지 않는 모델 오류가 발생할 수 있다. 설치된 CLI와 계정에서 해당 모델·effort 조합을 제공하지 않으면 해당 attempt는 실행 실패로 기록되며 다른 설정으로 조용히 대체하지 않는다.

모델 설정 오류로 실패한 실행은 원래 사용한 모델과 오류를 보존한다. 설정 수정 후에는 새 재작성 요청으로 변경된 설정을 적용한다. 기존 run의 재개는 고정된 실행 정의를 사용하므로 모델을 조용히 바꾸지 않는다. Codex의 terminal `turn.failed` 또는 실패 종료의 구조화 오류를 실행 기록과 GUI에 전달하고, 비치명적인 경고만으로 정상 결과를 실패로 바꾸지 않는다.

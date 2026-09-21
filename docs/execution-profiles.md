# 모델 실행 프로필

모델과 추론 수준은 사용자 요청이나 worker 출력에서 선택하지 않는다. 각 모델 기반 업무는 `harness/jobs.json`의 `execution_profile`로 `harness/execution-profiles/<유형>.json`을 참조한다. 프로필은 해당 workflow에서 사용하는 `produce` 또는 `plan`, `review`, `repair` 단계별로 Codex와 Claude의 `model`, `effort`를 지정한다. 실행 서비스는 업무 요청을 등록할 때 선택된 프로필 전체를 실행 정의에 고정하고 정의 해시에 포함한다.

GUI의 **작업 실행 설정**에서는 특정 업무의 지시문, 기본 backend, Codex/Claude별 model과 effort override를 로컬에서 관리한다. model은 backend별 지원 목록에서, effort는 선택한 모델의 지원 목록에서 고른다. 설정은 `DATA_ROOT/execution-settings.json`에 저장하며 GitHub의 배포 기본 문서를 수정하지 않는다. model override가 `null`이면 해당 backend의 단계별 유형 모델을 사용한다. model이나 effort를 명시하면 그 업무의 생성·계획·검토·수정 단계에 동일한 override를 적용한다.

effort override가 `null`이면 선택한 모델에서 지원하는 단계별 프로필 effort를 먼저 상속한다. 해당 값이 지원되지 않으면 모델 목록의 `default_effort`를 사용한다. 예를 들어 Codex의 모델만 Luna로 지정하고 effort를 비우면 프로필의 `high`를 상속한다. Haiku처럼 effort를 지원하지 않는 모델은 최종 effort가 `null`이며 Claude CLI에 `--effort`를 전달하지 않는다. 사용자가 명시한 effort는 다른 수준으로 자동 변경하지 않고 지원 여부를 검증한다.

기본 지시문은 업무별 역할과 책임 경계에서 `목적`, `입력`, `범위`, `수행 절차`, `완료 기준`을 갖춘 Markdown으로 구성한다. GUI는 미리보기를 기본으로 열고 **원문 편집**에서 Markdown을 수정한다. 제목·목록·강조·코드 블록을 표시하며 HTML·링크·이미지는 실행하거나 가져오지 않고 텍스트로 보여 준다. 저장된 원문은 새 실행의 실제 worker 프롬프트에도 동일하게 사용한다. 기존 수동 지시문은 일반 텍스트여도 그대로 보존하고, **기본값 복원**을 선택하면 구조화된 기본 지시문으로 돌아간다. 편집 가능한 지시문과 별개로 담당·제외 범위 및 완료 기준의 검증 계약은 유지한다.

기본 설정 대상은 모델 기반 업무 64개이며 제품·프로젝트·설계·FE·BE·개발 공통·조사 문서·시스템의 8개 그룹으로 표시한다. 등록한 사용자 유형은 별도의 **사용자 작업** 그룹에 표시한다. 로컬 검사 실행과 근거 보고서인 `checks.run`, `verification.report`에는 모델 설정이 없다. 기본 업무의 담당·제외 범위·필요 자료·완료 기준은 읽기 전용이며 지시문 편집으로 바뀌지 않는다.

새 run은 `명시적으로 검증된 API engine → 로컬 업무 backend → codex` 순서로 backend를 결정하고, 로컬 model/effort override가 있으면 유형 프로필 위에 적용한다. 지시문과 최종 실행 프로필은 run 생성 시 복사해 정의 해시에 포함하므로 GUI에서 설정을 바꿔도 진행 중인 run이나 재개되는 기존 run은 바뀌지 않는다. 복합 계획은 접수할 때 모든 자식 정의를 고정하므로 아직 시작하지 않은 대기 작업에도 접수 당시 설정을 사용한다. 수정은 revision 비교로 다른 GUI 창의 변경을 덮어쓰지 않는다.

모든 모델 기반 업무의 기본 backend는 Codex이며, 여섯 프로필의 모든 Codex 생성·계획·검토·수정 단계는 `gpt-5.6-luna`와 `high`를 사용한다. 사용자 유형도 선택한 템플릿의 프로필 기본값을 상속한다. 저장된 업무별 backend/model/effort override와 이미 접수된 실행 정의는 이 배포 기본값 변경으로 덮어쓰지 않는다. Claude의 기존 단계별 기본값은 다음과 같이 유지한다.

| 프로필 | 적용 업무 | Codex 기본 설정 | Claude 기본 설정 |
|---|---|---|---|
| `document` | PRD, 제품·프로젝트·설계·조사·검토 문서, 일반 텍스트 | Luna / 모든 단계 high | Sonnet / 생성 medium, 검토·수정 high |
| `html` | 동작형 HTML 목업 | Luna / 모든 단계 high | Sonnet / 모든 단계 high |
| `data-model` | 엔티티 설계 | Luna / 모든 단계 high | Sonnet / 모든 단계 high |
| `metadata` | 세션 요약, 제목·설명 재작성 | Luna / 모든 단계 high | Sonnet / 생성 low, 검토·수정 medium |
| `scenario` | E2E 시나리오 계획 | Luna / 모든 단계 high | Sonnet / 모든 단계 high |
| `coding` | FE·BE 구현, 버그 수정, 리팩터링, 테스트 작성, 리뷰 반영 | Luna / 모든 단계 high | Sonnet / 모든 단계 high |

Codex는 `--model <model>`과 `-c model_reasoning_effort="<effort>"`를 사용한다. Claude는 `--model <model>`과 지원 모델에 한해 `--effort <effort>`를 사용한다. Claude의 `auto`는 앱 프로필 상속과 구분되는 명시적 선택이며 `--effort auto`로 CLI에 전달한다. 선택값은 각 attempt의 `process.json`에도 기록한다. 새 업무는 기존 프로필을 명시적으로 참조하거나 필요한 유형 문서를 먼저 추가해야 하며, 모델 기반 workflow인데 프로필 또는 단계 설정이 빠지면 서비스 시작을 거부한다.

모델 subprocess는 비대화형으로 멈추지 않도록 Codex에 `--dangerously-bypass-approvals-and-sandbox`, Claude에 `--allow-dangerously-skip-permissions --permission-mode bypassPermissions`를 전달한다. Claude의 allow 플래그만으로는 bypass 모드가 시작되지 않으므로 permission mode도 명시한다. 따라서 CLI 자체의 승인·sandbox가 실행 경계가 되지 않는다. 하네스는 작업별 임시 디렉터리, 프롬프트의 변경 범위, 산출물 해시·허용 파일·코드 묶음 검증기로 결과 범위를 판정하지만 이것은 OS 수준 격리를 대신하지 않는다. 운영 배포에서는 프로세스 계정·파일 권한·네트워크 정책으로 실행 환경을 별도로 제한해야 한다.

지원 형식은 `contracts/execution-profile.schema.json`으로, 모델과 effort 조합은 배포에 포함된 `harness/model-capabilities.json`으로 검사한다. GUI와 실행 검증은 이 목록을 함께 사용한다. 프로필은 서비스 시작 시, 신규·변경 override는 저장 시, 실제 사용할 backend의 최종 조합은 새 run·계획을 접수하기 전에 확인한다. Codex 기본 모델은 모든 프로필에서 `gpt-5.6-luna`이며 Claude 기본 모델은 `sonnet`이다. Luna 식별자는 [공식 모델 목록](https://learn.chatgpt.com/docs/models)과 설치된 Codex CLI의 모델 메타데이터를 근거로 등록했다.

이 지원 목록은 배포 시 고정한 기능 정보이며, 현재 계정이나 CLI에서 사용할 수 있는 모델을 실시간 조회한 결과가 아니다. 앱은 목록을 표시하기 위해 로그인하거나 모델을 호출하지 않는다. 목록에 있는 모델도 실제 CLI 버전·계정·provider 설정에 따라 실행이 거부될 수 있으며, 이때 해당 attempt는 실행 실패로 기록하고 다른 설정으로 조용히 대체하지 않는다. Claude의 `sonnet`·`opus` 별칭은 표준 Anthropic 연결의 현재 기능을 기준으로 등록했다. [공식 Claude 모델 설정 문서](https://code.claude.com/docs/en/model-config#model-aliases)처럼 별칭이 가리키는 버전은 provider와 CLI 설정에 따라 달라질 수 있으므로 특정 기능을 정확히 고정하려면 `claude-sonnet-5` 같은 전체 모델 ID를 선택한다.

기존 파일에 현재 지원 목록에 없는 모델·effort가 있어도 읽기나 앱 시작 시 값을 삭제하거나 파일을 다시 쓰지 않는다. GUI에서 이전 값을 확인한 뒤 지원되는 조합으로 수정할 수 있다. 지시문처럼 무관한 항목만 편집할 때에는 변경하지 않은 기존 조합을 유지할 수 있지만, 해당 조합의 backend로 기본 실행 대상을 바꾸거나 새 실행을 요청하면 worker를 시작하기 전에 거부한다. 기본값을 사용하려면 해당 override를 해제하거나 업무의 **기본값 복원**을 사용한다.

모델 설정 오류로 실패한 실행은 원래 사용한 모델과 오류를 보존한다. 설정 수정 후에는 새 재작성 요청으로 변경된 설정을 적용한다. 기존 run의 재개는 고정된 실행 정의를 사용하므로 모델을 조용히 바꾸지 않는다. Codex의 terminal `turn.failed` 또는 실패 종료의 구조화 오류를 실행 기록과 GUI에 전달하고, 비치명적인 경고만으로 정상 결과를 실패로 바꾸지 않는다.


## 사용자 작업 유형 등록과 보존

**작업 실행 설정 → 사용자 작업 등록**에서 템플릿, 이름, 용도, 분류 키워드와 Markdown 지시문을 입력하고 Codex/Claude별 실행 설정을 저장한다. 문서·HTML·엔티티·코드 묶음·시나리오 계획을 생성하는 기본 업무를 템플릿으로 선택할 수 있다. 내부 메타데이터 작업, 로컬 검사 실행, 다른 사용자 유형은 템플릿으로 사용할 수 없다.

사용자 유형에는 변경되지 않는 `user.<랜덤 ID>`를 부여한다. 이름과 용도, 키워드, 지시문, backend/model/effort는 편집할 수 있지만 입력 스키마, 산출물 파일·형식, 제외 범위, 검증 규칙과 workflow는 선택한 템플릿에서 상속한다. 사용자 설명은 기존 책임 범위에 추가되며 제외 범위와 권한을 확대하지 않는다. 새 파일 형식이나 실행 명령이 필요하면 하네스 자체의 검증 계약을 구현해야 한다. 사용자 유형의 독립 검토는 필수이며, 기본 `text.generate`의 검토 생략 선택은 사용자 유형으로 확대하지 않는다.

등록 즉시 서비스의 `/catalog`와 `harness catalog --summary/--task`에 이름·설명·키워드·출처·템플릿·상속 계약이 포함된다. 요청 스킬은 이 카탈로그를 읽어 구조화된 계획의 task/input을 구성하므로 별도 업무별 스킬이나 앱 재설치가 필요하지 않다. 자연어 `run`은 계속 단일·명확한 업무만 허용하며 모호한 요청을 임의 분류하지 않는다.

`DATA_ROOT/execution-settings.json` 형식 2에서 `custom_tasks`는 정의를, `tasks`는 업무별 지시문·실행 설정을 저장한다. 앱 번들이나 설치 소유 파일에 포함하지 않으며 `make uninstall`과 재설치는 이 파일을 보존한다. 형식 1은 읽을 때 변경하지 않고, 설정을 저장할 때 기존 지시문을 유지해 형식 2로 변환한다. 저장은 revision 비교와 원자적 파일 교체 후에만 실행 카탈로그에 반영한다.

**기본값 복원**은 지시문과 실행 설정만 초기화하고 사용자 유형은 유지한다. **사용자 작업 삭제**는 확인 후 등록과 설정만 삭제한다. 기존 실행·산출물은 보존하며 이미 접수된 계획의 대기 단계까지 당시 고정된 정의를 사용한다. 삭제한 유형으로 새 실행을 요청하면 거부한다.

등록은 최대 100개, 이름은 120자, 용도는 2,000자, 키워드는 중복 없는 1~20개(각 80자), 지시문은 12,000자다. 이름은 기존 기본·사용자 업무와 Unicode 정규화·대소문자·앞뒤 공백 기준으로 중복될 수 없다. 다른 창의 변경과 충돌하면 미저장 편집을 유지하고 다시 불러오도록 안내한다.

## 헤드리스 작업과 수집 훅

생성·검토·수정과 GUI 요약 등 모든 executor subprocess 및 CLI 버전 조회에는 `HARNESS_WORKER=1`을 전달한다. 설치된 WorkLog 훅 명령은 이 값을 확인하면 Node를 실행하기 전에 성공 반환한다. 직접 `src/hook.mjs`를 실행하더라도 stdin을 읽거나 DB·스풀·오류 파일에 접근하기 전에 종료한다. 작업자 이력과 결과는 executor에서 직접 수집한다.

이 조건은 WorkLog 소유 수집 훅에만 적용된다. 사용자 에이전트 세션의 수집과 별도로 등록된 보안·사내 훅은 유지한다. 외부 훅이나 CLI 자체의 실행 시간이 없어지는 것을 보장하는 설정은 아니다.

## 검증 시나리오

`tests/e2e/model-selection.test.mjs`는 모든 유형의 Luna/high 기본값, backend별 설정 보존, 잘못된 모델·effort 조합의 저장·실행 차단, 기존 설정 보존과 초기화를 확인한다. CLI 프로토콜 대역으로 실제 subprocess 인자를 검사하며 effort 미지원 모델의 인자 생략도 확인한다. `tests/ui/model-selection.spec.mjs`는 backend별 모델 목록, 모델 변경 시 effort 선택지 갱신, 호환되지 않는 선택 해제와 기존 설정 표시를 검증한다.

`tests/e2e/custom-tasks.test.mjs`와 `custom-task-inheritance.test.mjs`는 GUI API 등록 → CLI 카탈로그 → 산출물 검증·검토, 선행 결과를 받는 대기 작업의 정의 보존, 등록 삭제 후 기존 결과 조회, 구형 설정 이관, 사용자 시나리오 입력 검증과 분류를 확인한다. 문서·HTML·엔티티·코드 묶음·시나리오 모두 로컬 fixture로 실행하며 실제 모델 사용량은 발생하지 않는다.

`tests/e2e/install.test.mjs`는 패키지의 등록·편집·제거·재설치·재실행에서 원본 설정 보존을, `worker-hooks.test.mjs`는 열린 stdin과 잘못된 입력에서도 worker 훅이 즉시 반환하고 일반 훅은 수집하는지 확인한다. `tests/ui/custom-tasks.spec.mjs`는 등록·편집·재시작·충돌·삭제·HTML 이스케이프를 검증한다. 아이콘은 `menu-icons.spec.mjs`의 글꼴·배율·초기 로딩 검사와 `native-connection.test.mjs`의 실제 WKWebView·메뉴 막대 대체 이미지 검사로 확인한다.

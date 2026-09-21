WorkLog 앱 아이콘은 파란색(`#2563eb`) 작업 이력과 시계를 흰색 타일에 배치한 자체 벡터 마크입니다. `worklog.svg`가 편집 원본이며 외부 폰트·이미지·서비스를 사용하지 않습니다.

macOS에서 ICNS와 크기별 미리보기를 다시 생성합니다.

```sh
swift scripts/build-icons.swift apps/macos/assets/worklog.svg apps/macos/assets/WorkLog.icns output/screenshots/worklog-icon-preview.png
```

앱 빌드는 같은 SVG에서 `Contents/Resources/WorkLog.icns`를 생성하고 `CFBundleIconFile`로 등록합니다. ICNS에는 16~1024픽셀의 표준 macOS 표현 10개가 포함됩니다. 생성기는 SVG의 단색 `rect`·`circle` 요소를 지원합니다.

메뉴 막대는 SVG의 `data-role="mark"` 도형을 검정색으로, `cutout` 도형은 투명하게 렌더링한 18·36픽셀 템플릿을 사용합니다. 빌드 시 `WorkLogStatusTemplate.png`와 `WorkLogStatusTemplate@2x.png`를 ICNS 옆에 생성하며 macOS가 화면 테마에 맞춰 표시합니다. 템플릿이 없는 개발용 앱에서는 기존 시스템 심벌을 사용합니다.

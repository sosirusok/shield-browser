# 🛡 Shield Browser

가볍고 빠른 **프라이버시 브라우저**. 링크를 붙여넣으면 그 자리에서 사이트가 열리고,
광고·트래커는 기본 차단됩니다. 엔진은 Chromium(Electron)이라 속도는 크롬과 동일합니다.

## 무엇을 막아주나 (덕덕고 스타일)
- **광고 / 트래커 차단** — EasyList + EasyPrivacy 프리빌트 필터 (`@ghostery/adblocker-electron`)
- **http / https 모두 지원** — 베어 도메인은 https 우선 시도 후 안 되면 http 자동 폴백
  (선생님들의 http 수업 사이트도 열림). 붙여넣은 `http://` 링크는 그대로 http 로 로드.
- **권한 기본 거부** — 위치·카메라·마이크·알림을 사이트가 함부로 못 씀
- **WebRTC 로컬 IP 누출 차단**
- **DNT / Global Privacy Control** 헤더 전송
- **깨끗한 User-Agent** 로 핑거프린트 표면 축소, 텔레메트리/구글 서비스 호출 비활성화
- **원클릭 데이터 삭제** & **종료 시 자동 삭제** 옵션

## 무엇을 못 하나 (정직하게)
이 브라우저는 **웹사이트·광고사로부터의** 추적을 막습니다.
**기기에 관리자 권한으로 설치된 모니터링/관리 소프트웨어(학교·회사 MDM 등)는 우회하지 않습니다.**
그건 어떤 브라우저도 원리상 불가능하고, 의도하지도 않았습니다. 덕덕고도 마찬가지입니다.

## 실행
```powershell
npm install     # 최초 1회 (Electron + 필터 다운로드)
npm start
```

## 단축키
| 키 | 동작 |
|---|---|
| Ctrl+T | 새 탭 |
| Ctrl+W | 탭 닫기 |
| Ctrl+L | 주소창 포커스 |
| Ctrl+R / F5 | 새로고침 |
| 가운데 클릭(탭) | 탭 닫기 |

## 구조
```
src/main.js      메인 프로세스 — 탭(WebContentsView)·차단·프라이버시 하드닝·IPC
src/preload.js   안전한 contextBridge (window.shield)
ui/              브라우저 크롬 (탭바·주소창·설정 패널)
```

> ※ 검색 엔진은 없습니다. 주소창엔 URL만 입력하세요. (점이 포함된 도메인 또는 http/https 링크)

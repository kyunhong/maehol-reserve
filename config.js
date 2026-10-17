// Apps Script 웹 앱 배포 URL (…/exec 로 끝나는 주소)을 넣으세요.
// 비워 두면 브라우저에만 저장되는 "데모 모드"로 동작합니다.
// 반별 제목·시간대·요일·예약 기간·휴무일은 담임 관리 화면(admin.html) > 설정 에서 바꿉니다.
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwoJTCe8DRKVxxQ-CWJYrC9F6M2tMqrBDEtITDuvsk3-A6FXe7ADNq-ekvtiC3zbGeR/exec',
  GRADE: 2, // apps-script/Code.gs 의 CONFIG.GRADE 와 같게
  CLASS_COUNT: 10, // apps-script/Code.gs 의 CONFIG.CLASS_COUNT 와 같게
};

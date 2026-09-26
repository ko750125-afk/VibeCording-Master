const CACHE_NAME = 'vibecoding-master-v4';
const urlsToCache = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/data.js'
];

// 설치: 새 캐시에 파일 저장
self.addEventListener('install', event => {
  self.skipWaiting(); // 대기 없이 즉시 활성화
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// 활성화: 이전 버전 캐시 삭제
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => self.clients.claim()) // 즉시 모든 탭에 적용
  );
});

// 가져오기: 네트워크 우선, 실패하면 캐시 사용 (오프라인 대비)
self.addEventListener('fetch', event => {
  // GET 요청이 아니면 가로채지 않고 그대로 통과
  if (event.request.method !== 'GET') {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // 유효한 응답일 때만 캐시 갱신
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // 오프라인이면 캐시 사용
  );
});

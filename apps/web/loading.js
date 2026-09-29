export function showListSkeleton(root) {
  root.dataset.loading = 'true';
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = '<div class="list-skeleton"><p role="status">목록을 불러오는 중…</p>' +
    Array.from({ length: 5 }, () => '<div class="skeleton-row" aria-hidden="true"><span class="skeleton-line skeleton-title"></span><span class="skeleton-line"></span><span class="skeleton-line skeleton-meta"></span></div>').join('') + '</div>';
}
export function finishListLoading(root, retry) {
  root.removeAttribute('aria-busy');
  if (retry && root.dataset.loading) {
    root.replaceChildren();
    const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = '목록을 불러오지 못했습니다.';
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = '다시 불러오기'; button.onclick = retry;
    root.append(message, button);
  }
  delete root.dataset.loading;
}

// 圖片快取
// 1. 先檢查本次頁面的快取中是否有該圖片 URL。
// 2. 第一次使用時以 fetch 讀取圖片並轉成 Blob URL。
// 3. 後續動畫幀只使用同一個 Blob URL，不再重複向伺服器請求。
// 4. Blob URL 只存在本次頁面生命週期，頁面關閉時由瀏覽器自動釋放。
const imgCacheUrlPromise = new Map();

/**
 * 取得快取的圖片 URL
 * @param {string} url - 圖片的 URL
 * @returns {Promise<string>} - 快取的圖片 URL
 */
function GetCacheUrl(url) {
    url = String(url || '');
    if (!url) return Promise.reject(new Error('圖片 URL 不可為空白'));
    // 已經是本地 Blob／Data URL 時不必再次 fetch，避免快取圖片被重包一層。
    if (/^(?:blob|data):/i.test(url)) return Promise.resolve(url);
    if (imgCacheUrlPromise.has(url)) {
        return imgCacheUrlPromise.get(url);
    }
    const cacheUrlPromise = Promise.resolve().then(() => fetch(url)).then(async (r) => {
        if (!r.ok) throw new Error(`圖片載入失敗 (${r.status}): ${url}`);
        const blob = await r.blob();
        if (!blob || !blob.size) throw new Error(`圖片內容為空白: ${url}`);
        return URL.createObjectURL(blob);
    });
    imgCacheUrlPromise.set(url, cacheUrlPromise);
    return cacheUrlPromise;
}

// 每個圖片元素各自保存目前的非同步請求狀態。
// 動畫會快速連續切換 A→B→C；若 A 的 fetch 比 C 晚完成，不能讓 A 把最新畫面覆蓋掉。
const imgCacheElementState = new WeakMap();

/**
 * 將圖片元素切換到快取 URL。
 * @param {HTMLImageElement} img - 要更新的圖片元素
 * @param {string} url - 原始圖片 URL（不可傳入上一張圖片的 Blob URL 當 key）
 * @returns {Promise<string>} - 實際採用的 Blob URL；快取失敗時回傳原始 URL
 */
function SetCachedImageSrc(img, url) {
    if (!img) return Promise.resolve('');
    const rawUrl = String(url || '');
    if (!rawUrl) {
        const old = imgCacheElementState.get(img) || { token: 0 };
        old.token += 1;
        old.rawUrl = '';
        old.appliedUrl = '';
        old.promise = Promise.resolve('');
        imgCacheElementState.set(img, old);
        img.removeAttribute('src');
        return old.promise;
    }

    let current = imgCacheElementState.get(img);
    if (current && current.rawUrl === rawUrl && current.promise) return current.promise;
    current = current || { token: 0 };
    const token = ++current.token;
    current.rawUrl = rawUrl;
    current.appliedUrl = '';
    // data-cache-src 是 innerHTML 建立時的初始來源；另記最後一次來源，讓死亡殘影等讀取目前幀的邏輯不會拿回初始幀。
    if (img.dataset) img.dataset.cacheCurrentSrc = rawUrl;

    const promise = GetCacheUrl(rawUrl).then((cachedUrl) => {
        if (current.token === token) {
            current.appliedUrl = cachedUrl;
            if (img.src !== cachedUrl) img.src = cachedUrl;
        }
        return cachedUrl;
    }).catch(() => {
        // fetch/CORS/404 失敗時退回原始 URL，交由既有 onerror 或 data-fb 繼續處理。
        if (current.token === token) {
            current.appliedUrl = rawUrl;
            if (img.src !== rawUrl) img.src = rawUrl;
        }
        return rawUrl;
    });
    current.promise = promise;
    imgCacheElementState.set(img, current);
    return promise;
}

/**
 * 建立已接上快取流程的預載圖片。
 * @param {string} url - 原始圖片 URL
 * @returns {HTMLImageElement} - Image 元素；ready Promise 會在 Blob／fallback 圖片完成載入或確認失敗後完成
 */
function PreloadCachedImage(url) {
    const rawUrl = String(url || '');
    const img = new Image();
    img.dataset.cacheSource = rawUrl;
    let resolveReady;
    let ready = false;
    let rawFallbackTried = false;
    const finish = (failed) => {
        if (ready) return;
        if (failed) img.cacheLoadFailed = true;
        ready = true;
        resolveReady(img);
    };
    img.ready = new Promise((resolve) => {
        resolveReady = resolve;
        img.onload = () => {
            // load 後再等 decode，讓幀探測／動畫使用時圖片已可直接繪製。
            if (rawFallbackTried || typeof img.decode !== 'function') {
                finish(false);
                return;
            }
            Promise.resolve().then(() => img.decode()).then(() => finish(false)).catch(() => {
                // Blob 解碼失敗時退回原始 URL；原始 URL 也失敗則交給 onerror。
                if (!rawFallbackTried && img.src !== rawUrl) {
                    rawFallbackTried = true;
                    img.src = rawUrl;
                    return;
                }
                finish(true);
            });
        };
        // 預載失敗不拋出未處理 Promise；呼叫端可用 naturalWidth 判斷是否真的可用。
        img.onerror = () => finish(true);
    });
    if (rawUrl) SetCachedImageSrc(img, rawUrl);
    else finish(true);
    return img;
}

/**
 * 取得預載 Image 對應的原始 URL。
 * 動畫陣列中的 img.src 可能已經被換成 Blob URL，切換畫面時仍必須用原始 URL 查快取。
 * @param {HTMLImageElement|string} image - 預載 Image 或原始 URL
 * @returns {string}
 */
function GetCachedImageSource(image) {
    if (typeof image === 'string') return image;
    if (image && image.dataset && image.dataset.cacheCurrentSrc) return image.dataset.cacheCurrentSrc;
    return image && image.dataset && image.dataset.cacheSource ? image.dataset.cacheSource : (image && image.src ? image.src : '');
}

/**
 * 將 root 底下標示 data-cache-src 的動畫圖片接上快取。
 * innerHTML 產生的圖片不能在字串內 await，因此由 DOM 插入完成後統一 hydrate。
 * @param {Element|Document} root - 掃描範圍
 * @returns {Promise<string[]>} - 各圖片實際採用的 URL
 */
function CacheImageTree(root) {
    const host = root && typeof root.querySelectorAll === 'function' ? root : document;
    const list = [];
    if (host.matches && host.matches('img[data-cache-src]')) list.push(host);
    host.querySelectorAll('img[data-cache-src]').forEach((img) => list.push(img));
    return Promise.all(list.map((img) => {
        // 重繪容器可能包含仍在播放中的舊元素；已有目前來源時不可用初始 data-cache-src 把它重置回第一幀。
        if (img.dataset && img.dataset.cacheCurrentSrc) return Promise.resolve(img.src || img.dataset.cacheCurrentSrc);
        return SetCachedImageSrc(img, img.getAttribute('data-cache-src') || '');
    }));
}
